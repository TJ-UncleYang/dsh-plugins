import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 额度不再靠"打开用量页、读页面文字"：
// 千问控制台的前端调的是两个 JSON 接口，我们直接调它们。
//   1) GET  https://platform-home.qianwenai.com/tool/user/info.json  → data.secToken
//   2) POST https://cs-data.qianwenai.com/data/api.json              → per1MonthPercentage
// 两个接口都要登录 Cookie，所以仍然需要一个浏览器上下文——
// 但它是一个无头的、独立 profile 的 Edge，不弹窗、不抢焦点，只留一个后台页面当"代理"。
const TOKEN_PLAN_ORIGIN = 'https://platform.qianwenai.com/'
// 2026-11-09 起改用 Chrome 独立 profile（用户已在该 profile 登录千问），
// 不再从他的 Edge 同步 Cookie：同一 profile 里已有登录态，进程不在时我们自己拉起。
const BG_CDP = process.env.DSH_BG_CDP_HTTP || 'http://127.0.0.1:9222'
const CHROME_PATH =
  process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
// 登录态在 D: 盘的 chrome-profile（金明同志 11-07 在那里登录千问/知乎），
// 但 homedir() 是 C:\Users\86137 —— 旧版默认落 C: 盘，起了一个没有登录态的
// 后台 Chrome 占住 9222，导致额度 no secToken、知乎监控 not-logged-in。
// 这里按"哪个候选 profile 的 Cookies 库更大"挑带登录态的那个，避免写死盘符。
function pickProfile() {
  const cands = [
    process.env.DSH_BG_PROFILE,
    'D:\\Users\\86137\\AppData\\Local\\dsh-browser\\chrome-profile',
    join(homedir(), 'AppData', 'Local', 'dsh-browser', 'chrome-profile'),
  ].filter(Boolean)
  let best = cands[cands.length - 1]
  let bestSize = -1
  for (const c of cands) {
    const ck = join(c, 'Default', 'Network', 'Cookies')
    try {
      if (existsSync(ck)) {
        const s = statSyncSafe(ck)
        if (s > bestSize) { bestSize = s; best = c }
      }
    } catch {}
  }
  return best
}
function statSyncSafe(p) {
  try { return statSync(p).size } catch { return -1 }
}
const BG_PROFILE = process.env.DSH_BG_PROFILE || pickProfile()
const REFRESH_MS = Number(process.env.DSH_QUOTA_REFRESH_MS || 60 * 1000)
const COOKIE_TTL_MS = 30 * 60 * 1000
const ROUTE_PATH = '/dsh-qwen-quota'

const state = {
  status: 'idle',
  percent: null,
  usedPercent: null,
  resetAt: null,
  plan: null,
  daysLeft: null,
  planStatus: null,
  updatedAt: 0,
  error: null,
  source: 'api',
}

let running = false
let cookiesSyncedAt = 0
let proxyTabId = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const QUOTA_SCRIPT = `(async () => {
  const info = await fetch('https://platform-home.qianwenai.com/tool/user/info.json', { credentials: 'include', headers: { accept: 'application/json' } });
  if (!info.ok) return { error: 'info ' + info.status };
  const token = (await info.json())?.data?.secToken;
  if (!token) return { error: 'no secToken（可能未登录）' };
  const corner = { domain: 'platform.qianwenai.com', consoleSite: 'QIANWENAI', console: 'ONE_CONSOLE', xsp_lang: 'zh-CN', protocol: 'V2', productCode: 'p_efm' };
  const call = async (api, extra) => {
    const body = new URLSearchParams({
      product: 'sfm_bailian', action: 'BroadScopeAspnGateway', sec_token: token, region: 'cn-beijing',
      params: JSON.stringify({ Api: api, Data: Object.assign({ cornerstoneParam: corner }, extra || {}), V: '1.0' })
    }).toString();
    const r = await fetch('https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json, text/plain, */*' },
      body
    });
    if (!r.ok) return { error: 'api ' + r.status };
    const j = await r.json();
    return j?.data?.DataV2?.data?.data ?? null;
  };
  const usage = await call('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage');
  const sub = await call('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription', { commodityCode: 'sfm_tokenplansolo_public_cn' });
  return { usage, sub };
})()`

async function cdp(path, init, base = BG_CDP) {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(6000) })
  if (!response.ok) throw new Error('CDP ' + response.status)
  return response
}

async function alive(base) {
  try {
    const response = await fetch(base + '/json/version', { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

async function ensureHeadless() {
  if (await alive(BG_CDP)) return
  mkdirSync(BG_PROFILE, { recursive: true })
  const child = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--remote-debugging-port=9222',
      '--user-data-dir=' + BG_PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  )
  child.unref()
  for (let i = 0; i < 25; i += 1) {
    await sleep(800)
    if (await alive(BG_CDP)) return
  }
  throw new Error('后台浏览器没起来（9222 连不上）')
}

function evaluate(webSocketUrl, expression, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {}
      reject(new Error('CDP 超时'))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      )
    })
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      if (message.error) reject(new Error(message.error.message || 'CDP 报错'))
      else {
        const outcome = message.result && message.result.result
        if (message.result && message.result.exceptionDetails) {
          reject(new Error(message.result.exceptionDetails.text || '页面脚本报错'))
        } else {
          resolve(outcome ? outcome.value : undefined)
        }
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    })
  })
}

// 后台留着同一个页面当"代理"，不反复导航、也不渲染控制台。
async function proxyTab() {
  const response = await cdp('/json/list')
  const tabs = await response.json()
  const existing = Array.isArray(tabs) ? tabs.find((tab) => tab.type === 'page' && String(tab.url).startsWith(TOKEN_PLAN_ORIGIN)) : null
  if (existing) return existing
  const created = await (await cdp('/json/new?' + encodeURIComponent(TOKEN_PLAN_ORIGIN), { method: 'PUT' })).json()
  proxyTabId = created.id
  await sleep(3000)
  return created
}

async function syncCookies() {
  // 同一 Chrome profile 里已有登录态，不再从别的浏览器同步 Cookie。
  return 0
}

function formatLocal(ms) {
  if (!ms) return null
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function parseQuotaPayload(payload) {
  if (!payload || payload.error) return null
  const usage = payload.usage || {}
  const sub = payload.sub || {}
  const used = typeof usage.per1MonthPercentage === 'number' ? usage.per1MonthPercentage : null
  if (used === null && !sub.specCode) return null
  return {
    usedPercent: used === null ? null : Math.round(used * 1000) / 10,
    percent: used === null ? null : Math.round((1 - used) * 1000) / 10,
    resetAt: formatLocal(usage.per1MonthResetTime),
    plan: sub.specCode ? sub.specCode[0].toUpperCase() + sub.specCode.slice(1) : null,
    daysLeft: typeof sub.remainingDays === 'number' ? sub.remainingDays : null,
    status: sub.status === 'VALID' ? '生效中' : sub.status || null,
  }
}

// 旧实现按页面文字解析，留着给别处复用。
export function parseQuotaText(text) {
  if (typeof text !== 'string' || !text) return null
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const after = (label) => {
    const index = lines.indexOf(label)
    return index >= 0 ? lines.slice(index + 1, index + 5) : []
  }
  const percentLine = after('月额度').find((line) => /^[\d.]+%$/.test(line))
  const resetLine = after('月额度').find((line) => line.startsWith('重置时间'))
  const resetMatch = resetLine ? resetLine.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) : null
  const planMatch = text.match(/(Lite|Standard|Pro)\s*套餐/)
  const daysLine = after('剩余天数').find((line) => /^\d+\s*天?$/.test(line))
  const daysMatch = daysLine ? daysLine.match(/(\d+)/) : null
  const statusLine = after('状态').find((line) => /^[\u4e00-\u9fa5]{2,6}$/.test(line))
  return {
    percent: percentLine ? Number(percentLine.replace('%', '')) : null,
    resetAt: resetMatch ? resetMatch[1] : null,
    plan: planMatch ? planMatch[1] : null,
    daysLeft: daysMatch ? Number(daysMatch[1]) : null,
    status: statusLine || null,
  }
}

async function readOnce() {
  const page = await proxyTab()
  if (!page) throw new Error('后台页面没开起来')
  const raw = await evaluate(page.webSocketDebuggerUrl, QUOTA_SCRIPT)
  let payload = raw
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error('接口返回不是 JSON')
    }
  }
  if (payload && payload.error) throw new Error(payload.error)
  return parseQuotaPayload(payload)
}

export async function readQuota() {
  await ensureHeadless()
  let parsed = await readOnce().catch((error) => ({ __error: error }))
  if (parsed && parsed.__error) {
    const applied = await syncCookies(true)
    if (applied > 0) {
      proxyTabId = null
      const page = await proxyTab()
      if (page) {
        const raw = await evaluate(page.webSocketDebuggerUrl, QUOTA_SCRIPT)
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (payload && payload.error) throw new Error(payload.error)
        parsed = parseQuotaPayload(payload)
      }
    }
    if (parsed && parsed.__error) throw parsed.__error
  }
  if (!parsed) throw new Error('没拿到额度数据')
  return parsed
}

async function refresh() {
  if (running) return
  running = true
  try {
    const quota = await readQuota()
    state.status = 'ok'
    state.percent = quota.percent
    state.usedPercent = quota.usedPercent
    state.resetAt = quota.resetAt
    state.plan = quota.plan
    state.daysLeft = quota.daysLeft
    state.planStatus = quota.status
    state.updatedAt = Date.now()
    state.error = null
  } catch (error) {
    state.status = 'error'
    state.error = String((error && error.message) || error)
    state.updatedAt = Date.now()
  } finally {
    running = false
  }
}

export const name = 'qwen-quota'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => {
    const kick = setTimeout(() => {
      void refresh()
    }, 5000)
    const timer = setInterval(() => {
      void refresh()
    }, REFRESH_MS)
    return () => {
      clearTimeout(kick)
      clearInterval(timer)
    }
  })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => {
        try {
          const url = new URL(request.url || ROUTE_PATH, 'http://127.0.0.1')
          if (url.searchParams.get('refresh')) void refresh()
        } catch {}
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify(state))
      },
    }),
  )
}
