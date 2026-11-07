import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-mail'
export const inject = ['tools']

const SCRIPT = process.env.DSH_MAIL_SCRIPT || join(dirname(fileURLToPath(import.meta.url)), 'send-mail.ps1')
const MAX_SUBJECT = 200
const MAX_BODY = 20000
const TIMEOUT_MS = 60000

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      resolve({ code: null, stdout, stderr: `${stderr}\ntimeout after ${TIMEOUT_MS}ms` })
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function sendEmail(args) {
  const to = typeof args.to === 'string' ? args.to.trim() : ''
  const subject = typeof args.subject === 'string' ? args.subject : ''
  const body = typeof args.body === 'string' ? args.body : ''

  if (!to.includes('@')) throw new Error('to 必须是一个邮箱地址')
  if (subject.length > MAX_SUBJECT) throw new Error(`subject 超过 ${MAX_SUBJECT} 个字符`)
  if (!body.trim()) throw new Error('body 不能为空')
  if (body.length > MAX_BODY) throw new Error(`body 超过 ${MAX_BODY} 个字符`)

  const dir = await mkdtemp(join(tmpdir(), 'dsh-mail-'))
  try {
    const subjectPath = join(dir, 'subject.txt')
    const bodyPath = join(dir, 'body.txt')
    await writeFile(subjectPath, subject, 'utf8')
    await writeFile(bodyPath, body, 'utf8')

    const result = await runScript(['-To', to, '-SubjectFile', subjectPath, '-BodyFile', bodyPath])
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || '未知错误'
      throw new Error(`发信失败：${detail}`)
    }
    return { sent: true, to, subject, via: 'smtp.qq.com:587' }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'send_email',
      description:
        'Send a plain-text email through the mail account configured for this workspace (QQ Mail SMTP). Use it when the user asks to send, forward, or deliver something by email.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address.' },
          subject: { type: 'string', description: 'Subject line, plain text.' },
          body: { type: 'string', description: 'Plain-text body.' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sent: { type: 'boolean' },
            to: { type: 'string' },
            subject: { type: 'string' },
            via: { type: 'string' },
          },
          required: ['sent', 'to', 'subject', 'via'],
        },
        render: (args, value) => [
          { type: 'text', text: `已发送到 ${value.to}（主题：${value.subject}）` },
        ],
      },
      timeoutMs: TIMEOUT_MS + 10000,
      isConcurrencySafe: () => false,
      execute: (args) => sendEmail(args),
    }),
  )
}
