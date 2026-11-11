import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'dsh-bus'
export const inject = ['tools', 'agents']

// 数据目录：默认 ~/.dsh-bus（跨平台），可用 DSH_BUS_DIR 覆盖。
const DIR = process.env.DSH_BUS_DIR || join(homedir(), '.dsh-bus')
const DB = join(DIR, 'bus.db')
const PRICES_FILE = join(DIR, 'prices.json')
const CFG_FILE = join(DIR, 'bus.json')

// ---- 可调参数：优先级 环境变量 > bus.json > 内置默认 ----
function loadConfig() {
  let file = {}
  try {
    if (existsSync(CFG_FILE)) file = JSON.parse(readFileSync(CFG_FILE, 'utf8')) || {}
  } catch {
    // 配置坏了就用默认值，别把工具搞挂
  }
  const pick = (env, key, fallback) => {
    if (process.env[env] !== undefined && process.env[env] !== '') return Number(process.env[env])
    if (file[key] !== undefined && file[key] !== null) return Number(file[key])
    return fallback
  }
  return {
    chatDailyYuan: pick('DSH_BUS_DAILY_YUAN', 'chatDailyYuan', 2),
    maxBody: pick('DSH_BUS_MAX_BODY', 'maxBody', 2000),
    digestMaxSent: pick('DSH_BUS_DIGEST_MAX', 'digestMaxSent', 30),
    chatMaxSent: pick('DSH_BUS_CHAT_MAX_SENT', 'chatMaxSent', 200),
    defaultWait: pick('DSH_BUS_DEFAULT_WAIT', 'defaultWait', 60),
    wakeMaxPerDay: pick('DSH_BUS_WAKE_MAX', 'wakeMaxPerDay', 30),
    wakeMinGapMs: pick('DSH_BUS_WAKE_GAP', 'wakeMinGapMs', 8000),
    retentionDays: pick('DSH_BUS_RETENTION_DAYS', 'retentionDays', 30),
    scope: process.env.DSH_BUS_SCOPE || file.scope || 'turn',
  }
}

const CFG = loadConfig()
const CHAT_DAILY_YUAN = CFG.chatDailyYuan // chat 通道每人每天上限（人民币）
const MAX_BODY = CFG.maxBody // 单条消息最大字符
const DIGEST_MAX_SENT = CFG.digestMaxSent // digest 通道每天条数上限
const CHAT_MAX_SENT = CFG.chatMaxSent // chat 通道每天条数上限（防刷屏）
const DEFAULT_WAIT = CFG.defaultWait
// 记账口径：turn=只算当前这一轮（默认）；session=算自上次调用总线以来的全部消耗
const CHAT_SCOPE = CFG.scope === 'session' ? 'session' : 'turn'

// ---- 单价表：元 / 百万 token。可用 %USERPROFILE%\.dsh-bus\prices.json 覆盖 ----
const DEFAULT_PRICES = {
  'deepseek-v4-pro': { in: 4.75, cache: 0.16, out: 14.3 },
  'deepseek-v4.1-flash': { in: 1.1, cache: 0.02, out: 4.3 },
  'deepseek-v4-flash': { in: 1.1, cache: 0.02, out: 4.3 },
  'deepseek-flash': { in: 1.1, cache: 0.02, out: 4.3 },
  'qwen3.8-max': { in: 14.4, cache: 1.8, out: 43.2 },
  'qwen3.7-max': { in: 18.0, cache: 3.6, out: 54.0 },
  'qwen3.7-plus': { in: 2.9, cache: 0.29, out: 11.5 },
  'glm-5.3': { in: 10.0, cache: 1.9, out: 31.7 },
}
const FALLBACK_PRICE = { in: 10.0, cache: 1.0, out: 30.0 }

// 实际生效的数据目录：默认 DIR；DIR 不可写（只读盘、沙箱、权限不足）时降级到系统临时目录。
// 降级同样能跨工作区共享，因为临时目录也是整机一份；代价是重启后可能被系统清理。
let ACTIVE_DIR = DIR

function priceFile() {
  return join(ACTIVE_DIR, 'prices.json')
}

let priceCache = null
function prices() {
  if (priceCache) return priceCache
  const table = { ...DEFAULT_PRICES }
  try {
    const file = priceFile()
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && typeof v === 'object') table[k] = { in: Number(v.in) || 0, cache: Number(v.cache) || 0, out: Number(v.out) || 0 }
      }
    } else {
      mkdirSync(ACTIVE_DIR, { recursive: true })
      writeFileSync(file, JSON.stringify(DEFAULT_PRICES, null, 2), 'utf8')
    }
  } catch {
    // 读不到就用默认，别让记账把工具搞挂
  }
  priceCache = table
  return table
}

function priceOf(model) {
  const table = prices()
  const name = String(model || '')
  if (table[name]) return { ...table[name], matched: name }
  for (const [k, v] of Object.entries(table)) {
    if (name.includes(k) || k.includes(name)) return { ...v, matched: k }
  }
  return { ...FALLBACK_PRICE, matched: '(default)' }
}

function openDb() {
  // 多场景自适应：先试配置目录；不可写（只读盘 / 沙箱 / 权限）再降级到系统临时目录。
  const candidates = [DIR, join(tmpdir(), 'dsh-bus')].filter((v, i, a) => v && a.indexOf(v) === i)
  const errors = []
  for (const dir of candidates) {
    try {
      const db = openAt(dir)
      if (ACTIVE_DIR !== dir) {
        ACTIVE_DIR = dir
        priceCache = null
      }
      return db
    } catch (e) {
      errors.push(`${dir}：${e && e.message ? e.message : e}`)
    }
  }
  throw new Error(`总线数据库打不开（已尝试 ${candidates.length} 个位置）：${errors.join(' ｜ ')}`)
}

function openAt(dir) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'bus.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, name TEXT, last_seen INTEGER)')
  // 唤醒用：记录每个会话对应的 agent id（有了它才能主动叫醒空闲会话）
  const peerCols = db.prepare('PRAGMA table_info(peers)').all().map((c) => c.name)
  if (!peerCols.includes('agent_id')) db.exec('ALTER TABLE peers ADD COLUMN agent_id TEXT')
  db.exec(
    'CREATE TABLE IF NOT EXISTS wake(peer TEXT, day TEXT, n INTEGER, last_ts INTEGER, PRIMARY KEY(peer, day))',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, channel TEXT DEFAULT \'chat\', sender TEXT, recipient TEXT, body TEXT)',
  )
  // 老库迁移：补 channel 列
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name)
  if (!cols.includes('channel')) db.exec("ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'chat'")
  // 老库迁移：补 msg_id 列（幂等发送用；同一 msgId 只落一条）
  if (!cols.includes('msg_id')) db.exec('ALTER TABLE messages ADD COLUMN msg_id TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(msg_id) WHERE msg_id IS NOT NULL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS cursors(peer TEXT, channel TEXT, last_seq INTEGER, PRIMARY KEY(peer, channel))',
  )
  // 已读回执：谁读到了哪一条（用来回答「我发过去了，他到底看没看」）
  db.exec('CREATE TABLE IF NOT EXISTS reads(seq INTEGER, peer TEXT, ts INTEGER, PRIMARY KEY(seq, peer))')
  // 老库迁移：reads 表刚建出来时，历史消息一律视为已读，避免「11 条全未读」的假象
  try {
    const empty = Number(db.prepare('SELECT COUNT(*) c FROM reads').get().c) === 0
    if (empty) {
      db.exec('INSERT OR IGNORE INTO reads(seq, peer, ts) SELECT seq, recipient, ts FROM messages')
    }
  } catch {
    // ignore
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS spend(peer TEXT, day TEXT, channel TEXT, yuan REAL, seen_seq INTEGER, sent INTEGER, PRIMARY KEY(peer, day, channel))',
  )
  db.exec('CREATE TABLE IF NOT EXISTS debug(ts INTEGER, tool TEXT, note TEXT)')

  // 保留期：默认 30 天，避免库无限长。只删消息与唤醒记录，不动 peers/spend。
  try {
    const days = Number(CFG.retentionDays)
    if (days > 0) {
      const cutoff = Date.now() - days * 86400_000
      db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff)
      db.prepare('DELETE FROM reads WHERE ts < ?').run(cutoff)
    }
  } catch {
    // 清理失败不影响主流程
  }
  return db
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function touch(db, peer, agentId) {
  if (!peer || peer === 'anon') return
  db.prepare(
    'INSERT INTO peers(id, name, last_seen, agent_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, agent_id=COALESCE(excluded.agent_id, peers.agent_id)',
  ).run(peer, peer, Date.now(), agentId || null)
}

// ---- 主动唤醒：把消息推给空闲会话，而不是等它下次自己来读 ----
const WAKE_MAX_PER_DAY = CFG.wakeMaxPerDay // 每个对象每天最多被唤醒多少次
const WAKE_MIN_GAP_MS = CFG.wakeMinGapMs // 同一对象两次唤醒最小间隔

function findAgentId(ctx, db, peer) {
  try {
    const row = db.prepare('SELECT agent_id FROM peers WHERE id = ?').get(peer)
    if (row && row.agent_id) return { id: row.agent_id, via: 'peers' }
  } catch {
    // ignore
  }
  try {
    const list = ctx.agents.list ? ctx.agents.list() : []
    for (const a of list) {
      const title = a?.session?.title || a?.session?.name || a?.title || ''
      if (typeof title === 'string' && title.includes(peer)) return { id: a.id, via: 'title' }
      if (a?.id === peer) return { id: a.id, via: 'id' }
    }
  } catch {
    // ignore
  }
  return null
}

function wake(db, ctx, peer, text, from) {
  if (!peer || peer === '*' || peer === from) return { woke: false, reason: 'skip' }
  const hit = findAgentId(ctx, db, peer)
  if (!hit) return { woke: false, reason: '对方没上线过总线，没有可唤醒的会话' }
  const day = today()
  let row = db.prepare('SELECT n, last_ts FROM wake WHERE peer = ? AND day = ?').get(peer, day)
  const n = Number(row?.n || 0)
  const lastTs = Number(row?.last_ts || 0)
  if (n >= WAKE_MAX_PER_DAY) return { woke: false, reason: `今天已唤醒 ${n} 次，到上限` }
  if (Date.now() - lastTs < WAKE_MIN_GAP_MS) return { woke: false, reason: '刚唤醒过（防抖）' }
  let agent = null
  try {
    agent = ctx.agents.get ? ctx.agents.get(hit.id) : null
  } catch {
    agent = null
  }
  if (!agent || typeof agent.followup !== 'function') {
    return { woke: false, reason: '会话不在运行（agent 已释放）' }
  }
  try {
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `[总线消息 · 来自 ${from}]\n${text}\n\n` +
            `（回信：bus_send(me:"你的注册名", to:"${from}", channel:"chat", text:"…")。只在窗口里说话，对方收不到。）`,
        },
      ],
      source: { kind: 'user' },
    })
  } catch (e) {
    return { woke: false, reason: `唤醒失败：${String(e && e.message ? e.message : e)}` }
  }
  const next = { n: n + 1, last: Date.now() }
  db.prepare(
    'INSERT INTO wake(peer, day, n, last_ts) VALUES(?,?,?,?) ON CONFLICT(peer, day) DO UPDATE SET n = excluded.n, last_ts = excluded.last_ts',
  ).run(peer, day, next.n, next.last)
  return { woke: true, via: hit.via, agentId: hit.id }
}

function pending(db, peer, channel) {
  const cur = db.prepare('SELECT last_seq FROM cursors WHERE peer = ? AND channel = ?').get(peer, channel)
  const since = cur ? Number(cur.last_seq) : 0
  return db
    .prepare(
      'SELECT seq, ts, sender, recipient, body FROM messages WHERE channel = ? AND seq > ? AND (recipient = ? OR recipient = ?) ORDER BY seq ASC LIMIT 100',
    )
    .all(channel, since, peer, '*')
}

function markRead(db, peer, channel, seq, rows) {
  if (!seq) return
  db.prepare(
    'INSERT INTO cursors(peer, channel, last_seq) VALUES(?,?,?) ON CONFLICT(peer, channel) DO UPDATE SET last_seq=excluded.last_seq',
  ).run(peer, channel, seq)
  // 已读回执：逐条记下来，发送方才能查到「他读没读」
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO reads(seq, peer, ts) VALUES(?,?,?)')
    const now = Date.now()
    for (const r of rows || []) ins.run(Number(r.seq), peer, now)
  } catch {
    // 回执是附加信息，失败不影响读信
  }
}

// ---- 记账：读会话日志里 assistant/message 的 usage，按单价折人民币 ----
function costOfMessage(usage, model) {
  const p = priceOf(model)
  const input = Number(usage.inputTokens || 0)
  const cached = Number(usage.cacheReadTokens || 0)
  const output = Number(usage.outputTokens || 0)
  const fresh = Math.max(0, input - cached)
  return (fresh * p.in + cached * p.cache + output * p.out) / 1e6
}

function sessionOf(exec, ctx) {
  // 依次尝试：工具执行上下文里的 agent → 当前发起者
  if (exec && exec.agent && exec.agent.session) return { agent: exec.agent, via: 'exec.agent' }
  try {
    const agent = ctx.agents.currentInitiator()
    if (agent && agent.session) return { agent, via: 'currentInitiator' }
  } catch {
    // ignore
  }
  return null
}

function spendRow(db, peer, day, channel) {
  return db.prepare('SELECT yuan, seen_seq, sent FROM spend WHERE peer = ? AND day = ? AND channel = ?').get(peer, day, channel)
}

function ensureRow(db, peer, day, channel, startSeq) {
  const row = spendRow(db, peer, day, channel)
  if (row) return row
  db.prepare('INSERT INTO spend(peer, day, channel, yuan, seen_seq, sent) VALUES(?,?,?,?,?,0)').run(
    peer,
    day,
    channel,
    0,
    startSeq,
  )
  return { yuan: 0, seen_seq: startSeq, sent: 0 }
}

function saveRow(db, peer, day, channel, row) {
  db.prepare('UPDATE spend SET yuan = ?, seen_seq = ?, sent = ? WHERE peer = ? AND day = ? AND channel = ?').run(
    Number(row.yuan) || 0,
    Number(row.seen_seq) || 0,
    Number(row.sent) || 0,
    peer,
    day,
    channel,
  )
}

// 把自上次记账以来的 assistant usage 累加进当日金额
function account(db, peer, day, channel, sessionInfo) {
  const session = sessionInfo ? sessionInfo.agent.session : null
  const seqNow = session ? Number(session.seq) : 0
  const row = ensureRow(db, peer, day, channel, seqNow)
  if (!session) return { ...row, accounted: false, sessionId: null, model: null }

  let from = Number(row.seen_seq) || 0
  if (from > seqNow) from = 0 // 会话是新的/重置过
  let yuan = Number(row.yuan) || 0
  let model = null
  let calls = 0
  let tokens = 0
  try {
    const events = session.snapshotEvents(from, seqNow)
    // 口径：默认只算「当前这一轮」的消耗（聊天轮次才计费）；
    // 设 DSH_BUS_SCOPE=session 则算「自上次调用总线以来的全部消耗」。
    const scoped = []
    let maxTurn = -1
    for (const ev of events) {
      if (ev.type !== 'assistant/message') continue
      const usage = ev.data && ev.data.usage
      if (!usage) continue
      const turn = Number(ev.data.turn)
      if (Number.isFinite(turn) && turn > maxTurn) maxTurn = turn
      scoped.push({ usage, ev, turn })
    }
    for (const item of scoped) {
      if (CHAT_SCOPE === 'turn' && Number.isFinite(item.turn) && maxTurn >= 0 && item.turn !== maxTurn) continue
      const src = (item.ev.data.message && item.ev.data.message.source) || {}
      model = src.model || model
      // digest 通道不收钱，只记条数；钱只记在 chat 上
      if (channel === 'chat') yuan += costOfMessage(item.usage, src.model)
      tokens += Number(item.usage.inputTokens || 0) + Number(item.usage.outputTokens || 0)
      calls++
    }
  } catch {
    // 读不到日志就保留原值
  }
  row.yuan = yuan
  row.seen_seq = seqNow
  saveRow(db, peer, day, channel, row)
  return { ...row, accounted: true, sessionId: session.id, model, calls, tokens }
}

function fmt(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2)
}

function balanceLine(peer, day, channel, row) {
  if (channel !== 'chat') {
    const left = Math.max(0, DIGEST_MAX_SENT - Number(row.sent || 0))
    return `[digest 今日] 已发 ${Number(row.sent || 0)}/${DIGEST_MAX_SENT} 条，不占聊天额度`
  }
  const spent = Number(row.yuan || 0)
  const left = Math.max(0, CHAT_DAILY_YUAN - spent)
  return `[今日聊天额度] 剩余 ¥${fmt(left)} / ¥${fmt(CHAT_DAILY_YUAN)}（已花 ¥${fmt(spent)}）`
}

function send(args, me, exec, ctx) {
  const to = String(args.to || '').trim()
  const channel = args.channel === 'digest' ? 'digest' : 'chat'
  const body = String(args.text || '').trim()
  if (!to) throw new Error('to 不能为空：填对方会话的名字，或 "*" 表示广播')
  if (!body) throw new Error('text 不能为空')
  if (body.length > MAX_BODY) throw new Error(`单条消息超过 ${MAX_BODY} 字（现在 ${body.length} 字），请压缩`)

  const db = openDb()
  try {
    const day = today()
    const sessionInfo = sessionOf(exec, ctx)
    const row = account(db, me, day, channel, sessionInfo)

    const sent = Number(row.sent || 0)
    if (channel === 'chat') {
      if (Number(row.yuan || 0) >= CHAT_DAILY_YUAN) {
        throw new Error(
          `今日聊天额度已用完（¥${fmt(row.yuan)} / ¥${fmt(CHAT_DAILY_YUAN)}）。明天 00:00 重置；要提前解封请调整 DSH_BUS_DAILY_YUAN 配置。`,
        )
      }
      if (sent >= CHAT_MAX_SENT) throw new Error(`今天 chat 消息已到 ${CHAT_MAX_SENT} 条上限，请收尾`)
    } else if (sent >= DIGEST_MAX_SENT) {
      throw new Error(`今天 digest 已到 ${DIGEST_MAX_SENT} 条上限`)
    }

    touch(db, me, exec && exec.agent ? exec.agent.id : undefined)
    // 幂等：同一 msgId 重发不会落两条（网络重试、模型重试都安全）
    const msgId = args.msgId ? String(args.msgId).slice(0, 120) : null
    const info = db
      .prepare('INSERT OR IGNORE INTO messages(ts, channel, sender, recipient, body, msg_id) VALUES(?,?,?,?,?,?)')
      .run(Date.now(), channel, me, to, body, msgId)
    if (msgId && Number(info.changes) === 0) {
      const dup = db.prepare('SELECT seq FROM messages WHERE msg_id = ?').get(msgId)
      return {
        seq: Number(dup && dup.seq ? dup.seq : 0),
        to,
        channel,
        chars: body.length,
        duplicate: true,
        sentToday: sent,
        spentYuan: Number(row.yuan || 0),
        balance: balanceLine(me, day, channel, row),
        woke: false,
        wakeNote: '重复消息（同一 msgId），没有再次发送',
        ts: new Date().toISOString(),
      }
    }
    row.sent = sent + 1
    saveRow(db, me, day, channel, row)

    // chat 通道：写库之后立刻尝试叫醒对方（真推送）；digest 不打扰
    let wakeInfo = { woke: false, reason: 'digest 通道不唤醒' }
    if (channel === 'chat') {
      try {
        wakeInfo = wake(db, ctx, to, body, me)
      } catch (e) {
        wakeInfo = { woke: false, reason: String(e && e.message ? e.message : e) }
      }
    }

    return {
      seq: Number(info.lastInsertRowid),
      to,
      channel,
      chars: body.length,
      sentToday: sent + 1,
      spentYuan: Number(row.yuan || 0),
      balance: balanceLine(me, day, channel, row),
      woke: wakeInfo.woke,
      wakeNote: wakeInfo.woke ? '已叫醒对方' : wakeInfo.reason,
      ts: new Date().toISOString(),
    }
  } finally {
    db.close()
  }
}

async function wait(args, me, exec, ctx) {
  const channel = args.channel === 'digest' ? 'digest' : 'chat'
  const timeoutSec = Math.max(1, Math.min(300, Number(args.timeoutSec) || DEFAULT_WAIT))
  const deadline = Date.now() + timeoutSec * 1000
  const db = openDb()
  try {
    touch(db, me, exec && exec.agent ? exec.agent.id : undefined)
    const day = today()
    if (channel === 'digest') {
      // relay 通道不挂起：有就读，没有就回空，绝不等人
      const rows = pending(db, me, 'digest').slice(0, 20)
      if (rows.length) markRead(db, me, 'digest', rows[rows.length - 1].seq, rows)
      const row = account(db, me, day, 'digest', sessionOf(exec, ctx))
      return {
        got: rows.map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), from: r.sender, body: r.body })),
        waitedSec: 0,
        timedOut: false,
        balance: balanceLine(me, day, 'digest', row),
      }
    }
    for (;;) {
      const rows = pending(db, me, 'chat')
      if (rows.length) {
        markRead(db, me, 'chat', rows[rows.length - 1].seq, rows)
        const row = account(db, me, day, 'chat', sessionOf(exec, ctx))
        return {
          got: rows.map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), from: r.sender, body: r.body })),
          waitedSec: Math.round((timeoutSec * 1000 - (deadline - Date.now())) / 1000),
          timedOut: false,
          balance: balanceLine(me, day, 'chat', row),
        }
      }
      if (Date.now() >= deadline) {
        const row = account(db, me, day, 'chat', sessionOf(exec, ctx))
        return { got: [], waitedSec: timeoutSec, timedOut: true, balance: balanceLine(me, day, 'chat', row) }
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  } finally {
    db.close()
  }
}

function read(args, me, exec, ctx) {
  const channel = args.channel === 'digest' ? 'digest' : 'chat'
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
  const db = openDb()
  try {
    touch(db, me, exec && exec.agent ? exec.agent.id : undefined)
    const day = today()
    const rows = pending(db, me, channel).slice(0, limit)
    try {
      db.prepare('INSERT INTO debug(ts, tool, note) VALUES(?,?,?)').run(
        Date.now(),
        'bus_read',
        `${me}/${channel} rows=${rows.length} seqs=${rows.map((r) => r.seq).join(',')}`,
      )
    } catch {
      // ignore
    }
    if (rows.length) markRead(db, me, channel, rows[rows.length - 1].seq, rows)
    const row = account(db, me, day, channel, sessionOf(exec, ctx))
    return {
      channel,
      got: rows.map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), from: r.sender, body: r.body })),
      left: Math.max(0, pending(db, me, channel).length - rows.length),
      balance: balanceLine(me, day, channel, row),
    }
  } finally {
    db.close()
  }
}

function peers(me, exec) {
  const db = openDb()
  try {
    touch(db, me, exec && exec.agent ? exec.agent.id : undefined)
    const list = db
      .prepare(
        `SELECT p.id, p.last_seen,
                (SELECT COUNT(*) FROM messages m WHERE m.recipient = p.id) AS received,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.recipient = p.id
                     AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.seq = m.seq AND r.peer = p.id)) AS unread
           FROM peers p WHERE p.id <> ? ORDER BY p.last_seen DESC`,
      )
      .all(me)
    const day = today()
    const chatRow = spendRow(db, me, day, 'chat') || { yuan: 0, sent: 0 }
    const digestRow = spendRow(db, me, day, 'digest') || { yuan: 0, sent: 0 }
    return {
      me,
      dataDir: ACTIVE_DIR,
      pendingChat: pending(db, me, 'chat').length,
      pendingDigest: pending(db, me, 'digest').length,
      chatSpentYuan: Number(chatRow.yuan || 0),
      chatLimitYuan: CHAT_DAILY_YUAN,
      digestSentToday: Number(digestRow.sent || 0),
      digestLimit: DIGEST_MAX_SENT,
      peers: list.map((p) => ({
        name: p.id,
        lastSeen: localTime(Number(p.last_seen) || Date.now()),
        // 他总共收到我多少条 / 其中还没读多少条（已读回执）
        received: Number(p.received),
        unreadByThem: Number(p.unread),
      })),
    }
  } finally {
    db.close()
  }
}

// 诊断用：报告今天花了多少、会话有没有被解析到、用的是哪个模型
function budget(me, exec, ctx) {
  const db = openDb()
  try {
    const day = today()
    const info = sessionOf(exec, ctx)
    const chat = account(db, me, day, 'chat', info)
    const digest = account(db, me, day, 'digest', info)
    return {
      me,
      day,
      sessionId: chat.sessionId || null,
      resolvedVia: info ? info.via : null,
      model: chat.model || '(未读到)',
      callsCounted: chat.calls || 0,
      tokensCounted: chat.tokens || 0,
      chatSpent: Number(chat.yuan || 0),
      chatLimit: CHAT_DAILY_YUAN,
      chatSent: Number(chat.sent || 0),
      digestSent: Number(digest.sent || 0),
      digestLimit: DIGEST_MAX_SENT,
      priceTable: prices(),
    }
  } finally {
    db.close()
  }
}

function renderGot(_args, result) {
  const lines = (result.got || []).map((m) => `[#${m.seq} ${localTime(m.ts)}] ${m.from}：${m.body}`)
  const head = lines.length ? lines.join('\n') : `（挂起 ${result.waitedSec ?? 0}s，没有新消息）`
  return [{ type: 'text', text: `${head}\n${result.balance || ''}`.trim() }]
}

const gotSchema = {
  type: 'object',
  properties: {
    channel: { type: 'string' },
    got: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          seq: { type: 'number' },
          ts: { type: 'number' },
          from: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    waitedSec: { type: 'number' },
    timedOut: { type: 'boolean' },
    left: { type: 'number' },
    balance: { type: 'string' },
  },
  required: ['got'],
}

const meParam = {
  type: 'string',
  description:
    '你自己的会话名（总线上的收件地址）。必须是对方 bus_send 时 to 里写的那个名字，拼写要完全一致，否则消息会投到另一个"人"名下。第一次用之后就固定下来，改名会让队列与未读游标断掉。',
}

const channelParam = {
  type: 'string',
  enum: ['chat', 'digest'],
  description:
    'chat = 日间实时对话：立刻叫醒对方（如果对方空闲），并按真金白银的 token 消耗计入每日聊天额度；对方随时可以 bus_wait 等你的消息。digest = 留言板：只落队列不唤醒，适合周报/月报/总结/交接，不占聊天额度、只限条数。默认 chat。',
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bus_send',
      description:
        '给本机另一个 DSH 会话发一条短消息。这是"另一个会话"之间的通信，不是给用户发消息。chat 通道会立刻叫醒空闲的对方（真推送）并按 token 消耗扣当天聊定额度；digest 通道只留言不打扰，适合周报/月报/交接。用法要点：to 必须是对方的注册名（用 bus_peers 查）；正文控制在两三句；对方回复后你会在自己的 bus_read/bus_wait 里看到。',
      parameters: {
        type: 'object',
        properties: {
          me: meParam,
          to: {
            type: 'string',
            description: '收件人注册名（bus_peers 里 name 字段），或 "*" 广播给所有人。写错名字会投给一个不存在的会话。',
          },
          text: {
            type: 'string',
            description: `正文。一句话说清一件事，别复述对方全文（上限 ${MAX_BODY} 字）。`,
          },
          channel: channelParam,
          msgId: {
            type: 'string',
            description: '可选幂等键。同一次重试传同一个值，就不会发出两条（消息落库只认第一次）。',
          },
        },
        required: ['me', 'to', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            seq: { type: 'number' },
            to: { type: 'string' },
            channel: { type: 'string' },
            chars: { type: 'number' },
            sentToday: { type: 'number' },
            spentYuan: { type: 'number' },
            balance: { type: 'string' },
            woke: { type: 'boolean' },
            wakeNote: { type: 'string' },
            duplicate: { type: 'boolean' },
            ts: { type: 'string' },
          },
          required: ['seq', 'to', 'channel', 'balance'],
        },
        render: (args, v) =>
          [
            {
              type: 'text',
              text: `已发给 ${v.to}（${v.channel} #${v.seq}，${v.chars} 字）。${v.duplicate ? '\n这是重复消息，已按 msgId 去重，没有重发。' : ''}${v.channel === 'chat' ? `\n唤醒：${v.woke ? '成功（对方会话已被叫起）' : v.wakeNote || '未唤醒'}` : ''}\n${v.balance}`,
            },
          ],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => send(args, String(args.me || 'anon'), exec, ctx),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bus_wait',
      description:
        'Wait for the next chat message addressed to you. Returns the moment one arrives (this replaces "约定时间再读"). With channel=digest it never waits: it just drains whatever summaries are queued.',
      parameters: {
        type: 'object',
        properties: {
          me: meParam,
          channel: channelParam,
          timeoutSec: { type: 'number', description: `最多挂多久，默认 ${DEFAULT_WAIT} 秒，上限 300。` },
        },
        required: ['me'],
        additionalProperties: false,
      },
      output: { schema: gotSchema, render: renderGot },
      isConcurrencySafe: () => true,
      timeoutMs: 320000,
      execute: (args, exec) => wait(args, String(args.me || 'anon'), exec, ctx),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bus_read',
      description: 'Read messages addressed to you that you have not consumed yet on one channel (marks them read).',
      parameters: {
        type: 'object',
        properties: { me: meParam, channel: channelParam, limit: { type: 'number', description: '默认 20，上限 100。' } },
        required: ['me'],
        additionalProperties: false,
      },
      output: { schema: gotSchema, render: renderGot },
      isConcurrencySafe: () => false,
      execute: (args, exec) => read(args, String(args.me || 'anon'), exec, ctx),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bus_peers',
      description:
        '列出总线上的会话：对方注册名、最后活动时间、我发给他的总条数、其中他还没读的条数（已读回执），以及我自己今天还剩多少聊定额度。开工前先看一眼，确认对方的名字没写错、也没积压未读。',
      parameters: {
        type: 'object',
        properties: { me: meParam },
        required: ['me'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            me: { type: 'string' },
            dataDir: { type: 'string' },
            pendingChat: { type: 'number' },
            pendingDigest: { type: 'number' },
            chatSpentYuan: { type: 'number' },
            chatLimitYuan: { type: 'number' },
            digestSentToday: { type: 'number' },
            digestLimit: { type: 'number' },
            peers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  lastSeen: { type: 'string' },
                  received: { type: 'number' },
                  unreadByThem: { type: 'number' },
                },
              },
            },
          },
          required: ['me', 'peers'],
        },
        render: (args, v) => {
          const lines = v.peers.map(
            (p) =>
              `- ${p.name}（最后活动 ${p.lastSeen}；我发给它 ${p.received} 条，其中它还没读 ${p.unreadByThem} 条）`,
          )
          const budget = Math.max(0, Number(v.chatLimitYuan) - Number(v.chatSpentYuan))
          return [
            {
              type: 'text',
              text: `我是 ${v.me}（数据目录 ${v.dataDir}），未读 chat ${v.pendingChat} 条 / digest ${v.pendingDigest} 条；今日 chat 剩余 ¥${fmt(budget)} / ¥${fmt(v.chatLimitYuan)}，digest 已发 ${v.digestSentToday}/${v.digestLimit}。\n${lines.join('\n') || '（还没有其他会话）'}`,
            },
          ]
        },
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => peers(String(args.me || 'anon'), exec),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bus_budget',
      description:
        'Check today\'s chat budget: how much money has been spent, what is left, how many messages were sent, and whether your session was recognised for accounting.',
      parameters: {
        type: 'object',
        properties: { me: meParam },
        required: ['me'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            me: { type: 'string' },
            day: { type: 'string' },
            sessionId: { type: 'string' },
            resolvedVia: { type: 'string' },
            model: { type: 'string' },
            callsCounted: { type: 'number' },
            tokensCounted: { type: 'number' },
            chatSpent: { type: 'number' },
            chatLimit: { type: 'number' },
            chatSent: { type: 'number' },
            digestSent: { type: 'number' },
            digestLimit: { type: 'number' },
          },
          required: ['me', 'day', 'chatSpent', 'chatLimit'],
        },
        render: (args, v) => {
          const left = Math.max(0, Number(v.chatLimit) - Number(v.chatSpent))
          const lines = [
            `[今日聊天额度] 剩余 ¥${fmt(left)} / ¥${fmt(v.chatLimit)}（已花 ¥${fmt(v.chatSpent)}）`,
            `chat 已发 ${v.chatSent} 条；digest 已发 ${v.digestSent}/${v.digestLimit} 条`,
            `记账：会话 ${v.sessionId || '(未解析到)'}（${v.resolvedVia || 'n/a'}），模型 ${v.model}，累计 ${v.callsCounted} 次调用 / ${v.tokensCounted} tokens`,
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => budget(String(args.me || 'anon'), exec, ctx),
    }),
  )
}
