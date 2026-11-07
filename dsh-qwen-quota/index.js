import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUOTA_PAGE = 'https://platform.qianwenai.com/home/analytics/token-plan/individual'
const CDP_HTTP = process.env.DSH_CDP_HTTP || 'http://127.0.0.1:9333'
const REFRESH_MS = 60 * 1000
const ROUTE_PATH = '/dsh-qwen-quota'

// 读额度要一台带着登录态的 Edge。它开在固定 profile 上、固定调试端口，
// 重启电脑或用户手滑关掉之后需要有人把它拉起来，否则面板只会一直「读不到」。
const EDGE_PATH = process.env.DSH_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const EDGE_PROFILE = process.env.DSH_EDGE_PROFILE || join(homedir(), 'AppData', 'Local', 'dsh-browser', 'zhihu-watch')

const state = {
  status: 'idle',
  percent: null,
  resetAt: null,
  plan: null,
  daysLeft: null,
  planStatus: null,
  updatedAt: 0,
  error: null,
}

let running = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cdpHttp(path, init) {
  const response = await fetch(CDP_HTTP + path, { ...init, signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error('CDP ' + response.status)
  return response
}

async function cdpAlive() {
  try {
    const response = await fetch(CDP_HTTP + '/json/version', { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

async function launchEdge() {
  const child = spawn(
    EDGE_PATH,
    [
      '--user-data-dir=' + EDGE_PROFILE,
      '--remote-debugging-port=9333',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      QUOTA_PAGE,
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
}

// 不存在就拉起来，然后给它最多 25 秒把调试端口开出来。
async function ensureBrowser() {
  if (await cdpAlive()) return
  await launchEdge().catch(() => {})
  for (let i = 0; i < 25; i += 1) {
    await sleep(1000)
    if (await cdpAlive()) return
  }
  throw new Error('Edge 没起来（9333 连不上）')
}

async function findQuotaTab() {
  const response = await cdpHttp('/json/list')
  const tabs = await response.json()
  if (!Array.isArray(tabs)) return null
  return (
    tabs.find(
      (tab) => tab.type === 'page' && typeof tab.url === 'string' && tab.url.includes('analytics/token-plan'),
    ) || null
  )
}

async function ensureQuotaTab() {
  const existing = await findQuotaTab()
  if (existing) return existing
  await cdpHttp('/json/new?' + encodeURIComponent(QUOTA_PAGE), { method: 'PUT' })
  for (let i = 0; i < 15; i += 1) {
    await sleep(1000)
    const tab = await findQuotaTab()
    if (tab) return tab
  }
  throw new Error('没能打开千问用量页')
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {}
      reject(new Error('CDP 超时'))
    }, 20000)
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
        resolve(outcome ? outcome.value : undefined)
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    })
  })
}

// 页面文案是给人看的中文，结构会变，所以按「标签行 + 下一行」读，
// 不写死成一条正则——上一版就是被 83% → 58.3% 的小数点打断的。
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

export async function readQuota() {
  await ensureBrowser()
  const tab = await ensureQuotaTab()
  const read = async () => evaluate(tab.webSocketDebuggerUrl, 'document.body.innerText || ""')
  const first = await read().catch(() => '')
  const parsedFirst = parseQuotaText(first)
  if (parsedFirst && parsedFirst.percent !== null) return parsedFirst

  // 后台标签页被冻结时读不到内容，这时才把标签页唤到前台再看一眼；
  // 平时不碰用户的窗口焦点。
  await cdpHttp('/json/activate/' + tab.id).catch(() => {})
  await sleep(1500)
  const raw = await read()
  const parsed = parseQuotaText(raw)
  if (!parsed) throw new Error('页面没有返回内容')
  if (parsed.percent === null && !parsed.plan) throw new Error('页面上找不到额度信息（可能未登录）')
  return parsed
}

async function refresh() {
  if (running) return
  running = true
  try {
    const quota = await readQuota()
    state.status = 'ok'
    state.percent = quota.percent
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
