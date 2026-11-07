import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'dsh-memory'
export const inject = ['tools']

const DIR = process.env.DSH_MEMORY_DIR || join(homedir(), '.dsh-memory')
const FACTS = join(DIR, 'facts.jsonl')
const DB = join(DIR, 'memory.db')

function readFacts() {
  if (!existsSync(FACTS)) return []
  return readFileSync(FACTS, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function openDb() {
  mkdirSync(DIR, { recursive: true })
  const db = new DatabaseSync(DB)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY, ts TEXT, topic TEXT, text TEXT, tags TEXT)',
  )
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, topic, tags, content='facts', content_rowid='rowid', tokenize='trigram')",
  )
  return db
}

function rebuildInto(db) {
  const facts = readFacts()
  db.exec('DELETE FROM facts')
  const insert = db.prepare('INSERT INTO facts(id, ts, topic, text, tags) VALUES(?,?,?,?,?)')
  db.exec('BEGIN')
  for (const fact of facts) insert.run(fact.id, fact.ts, fact.topic || '', fact.text, (fact.tags || []).join(','))
  db.exec('COMMIT')
  db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')")
}

function ensureIndex() {
  const db = openDb()
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM facts').get()
    if (Number(row.c) !== readFacts().length) rebuildInto(db)
  } finally {
    db.close()
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function localStamp(date) {
  const offset = -date.getTimezoneOffset()
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? '+' : '-'}${pad(
    Math.floor(abs / 60),
  )}:${pad(abs % 60)}`
}

function addFact(text, topic, tags) {
  const now = new Date()
  const stamp = localStamp(now)
  const fact = {
    id: `m-${stamp.slice(0, 10).replace(/-/g, '')}-${stamp.slice(11, 19).replace(/:/g, '')}-${Math.random()
      .toString(16)
      .slice(2, 5)}`,
    ts: stamp,
    topic: topic || '',
    text: text.trim(),
    tags: (tags || []).map((t) => String(t).trim()).filter(Boolean),
  }
  appendFileSync(FACTS, JSON.stringify(fact) + '\n', 'utf8')
  const db = openDb()
  try {
    db.prepare('INSERT INTO facts(id, ts, topic, text, tags) VALUES(?,?,?,?,?)').run(
      fact.id,
      fact.ts,
      fact.topic,
      fact.text,
      fact.tags.join(','),
    )
    db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')")
  } finally {
    db.close()
  }
  return { id: fact.id, topic: fact.topic, text: fact.text, ts: fact.ts, total: readFacts().length }
}

function searchFacts(query, limit) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10))
  const db = openDb()
  try {
    let rows = []
    if (query.length >= 3) {
      rows = db
        .prepare(
          "SELECT f.topic, f.text, f.ts FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(`"${query.replace(/"/g, '""')}"`, n)
    }
    if (rows.length === 0) {
      const like = `%${query}%`
      rows = db
        .prepare(
          'SELECT topic, text, ts FROM facts WHERE text LIKE ? OR topic LIKE ? OR tags LIKE ? ORDER BY ts DESC LIMIT ?',
        )
        .all(like, like, like, n)
    }
    return rows
  } finally {
    db.close()
  }
}

function listFacts(limit) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20))
  const db = openDb()
  try {
    return db.prepare('SELECT topic, text, ts FROM facts ORDER BY ts DESC LIMIT ?').all(n)
  } finally {
    db.close()
  }
}

function renderHits(args, value) {
  const lines = value.hits.map(
    (hit) => `- [${hit.topic || '未分类'}] ${hit.text} (${String(hit.ts).slice(0, 10)})`,
  )
  const text = lines.length ? lines.join('\n') : `没有匹配「${value.query}」的记忆。`
  return [{ type: 'text', text }]
}

const hitSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          text: { type: 'string' },
          ts: { type: 'string' },
        },
      },
    },
  },
  required: ['query', 'hits'],
}

export function apply(ctx) {
  ensureIndex()

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_add',
      description:
        'Save one durable fact into the cross-session local memory store (facts.jsonl). Use for stable facts about the user, decisions with their rationale, and long-lived project coordinates. Do not store temporary progress.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One self-contained sentence of fact.' },
          topic: { type: 'string', description: 'Short category, e.g. 身份 / 偏好 / 决策 / 项目 / 技术.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional free-form tags for later filtering.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            topic: { type: 'string' },
            text: { type: 'string' },
            ts: { type: 'string' },
            total: { type: 'number' },
          },
          required: ['id', 'text', 'total'],
        },
        render: (args, value) => [{ type: 'text', text: `已记住 [${value.topic || '未分类'}] ${value.text}（共 ${value.total} 条）` }],
      },
      isConcurrencySafe: () => false,
      execute: (args) => addFact(String(args.text || ''), args.topic, args.tags),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_search',
      description:
        'Search the cross-session local memory store. Query with 3+ characters for FTS5 ranking; shorter queries fall back to substring matching.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase.' },
          limit: { type: 'number', description: 'Max hits, default 10, max 50.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: hitSchema, render: renderHits },
      isConcurrencySafe: () => true,
      execute: (args) => {
        const query = String(args.query || '')
        return { query, hits: searchFacts(query, args.limit) }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_list',
      description: 'List the most recent entries of the cross-session local memory store.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Default 20, max 100.' } },
        additionalProperties: false,
      },
      output: { schema: hitSchema, render: renderHits },
      isConcurrencySafe: () => true,
      execute: (args) => ({ query: 'recent', hits: listFacts(args.limit) }),
    }),
  )
}
