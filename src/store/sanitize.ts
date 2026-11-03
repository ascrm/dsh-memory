/**
 * 输入规范化、框架标记转义与密钥脱敏。
 *
 * 每个进入系统提示词或工具结果的字符串都会经过这些辅助函数。磁盘内容不被信任：
 * 手工编辑过的文件在每次读取时都会重新清洗。
 */
import { createHash } from 'node:crypto'
import { MemoryError } from '../types.ts'

const RESERVED_SLUGS = new Set([
  'memory',
  'index',
  'audit',
  'project',
  'meta',
  'tmp',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

/** 规范化并校验 slug（kebab-case，最多 64 个字符）。 */
export function normalizeSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new MemoryError('INVALID_SLUG', 'slug must be kebab-case [a-z0-9-]')
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new MemoryError('RESERVED_SLUG', `slug "${slug}" is reserved`)
  }
  return slug
}

/** 合并空白并截断为单行。 */
export function singleLine(input: string, max: number): string {
  const one = input.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) : one
}

/** 转义协议外壳标签，使存储的文本无法闭合 `<memory_context>`。 */
export function escapeFrame(text: string): string {
  return text.replace(/<\s*\/?\s*memory_context[^>]*>/gi, (match) =>
    match.replace(/[<>]/g, (char) => (char === '<' ? '&lt;' : '&gt;'))
  )
}

interface SecretPattern {
  pattern: RegExp
  label: string
}

const SECRET_PATTERNS: SecretPattern[] = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github-token' },
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, label: 'npm-token' },
  { pattern: /\bsk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}\b/g, label: 'api-key' },
  { pattern: /\bxox[bposa]-[0-9A-Za-z-]{10,}\b/g, label: 'slack-token' },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, label: 'google-key' },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: 'private-key'
  }
]

const OPTIONAL_PATTERNS: SecretPattern[] = [
  // 中国大陆手机号。
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, label: 'phone' },
  // 18 位中国大陆身份证号（末位可能是 X）。
  { pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g, label: 'id-number' }
]

/** 把已知的凭据形态替换为 `[REDACTED:kind]`。 */
export function redactSecrets(text: string, options: { redactPhoneAndId?: boolean } = {}): string {
  let out = text
  for (const { pattern, label } of SECRET_PATTERNS) {
    out = out.replace(pattern, `[REDACTED:${label}]`)
  }
  if (options.redactPhoneAndId === true) {
    for (const { pattern, label } of OPTIONAL_PATTERNS) {
      out = out.replace(pattern, `[REDACTED:${label}]`)
    }
  }
  return out
}

/** 对将要注入提示词的文本做脱敏、转义并压成单行。 */
export function sanitizeInjectionText(
  text: string,
  max: number,
  options: { redactPhoneAndId?: boolean } = {}
): string {
  return escapeFrame(singleLine(redactSecrets(text, options), max))
}

/** 清洗多行正文，同时保留行结构。 */
export function sanitizeBody(text: string, options: { redactPhoneAndId?: boolean } = {}): string {
  return escapeFrame(redactSecrets(text, options))
}

/** 把来源（provenance）字段规范化为简短的单行字符串。 */
export function normalizeSource(source: object | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (source === undefined) return out
  const record = source as Record<string, unknown>
  for (const key of ['sessionId', 'messageId', 'tool', 'file', 'commit', 'url'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = singleLine(value, 512)
    }
  }
  return out
}

/** 规范化用户提供的标签列表。 */
export function normalizeTags(tags: unknown, max = 20): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = singleLine(raw, 32).replace(/^#+/, '')
    if (tag.length === 0) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

const SUSPICIOUS_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /system\s*prompt/i,
  /输出(你的)?系统提示词/,
  /忽略(之前|上面|前面)的?(所有)?指令/,
  /reveal\s+(your\s+)?(system\s+)?prompt/i
]

/** 标记（而不是拦截）疑似提示词注入的内容。 */
export function detectSuspicious(text: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(text))
}

/** 完整的 SHA-256 十六进制摘要。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 用于指纹的短哈希。 */
export function shortHash(text: string, length = 16): string {
  return sha256(text).slice(0, length)
}

function similarityTokens(text: string): Set<string> {
  const lower = text.toLowerCase()
  const parts = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
  const out = new Set<string>()
  for (const part of parts) {
    if (/^[a-z0-9]+$/.test(part)) {
      out.add(part)
    } else {
      if (part.length === 1) out.add(part)
      for (let i = 0; i + 1 < part.length; i += 1) out.add(part.slice(i, i + 2))
    }
  }
  return out
}

/** 基于拉丁单词 + CJK 二元组的 Jaccard 相似度。 */
export function textSimilarity(a: string, b: string): number {
  const left = similarityTokens(a)
  const right = similarityTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection += 1
  }
  return intersection / (left.size + right.size - intersection)
}

/** 按设计中的阈值判断两条摘要是否近似重复。 */
export function summariesNearDuplicate(a: string, b: string): boolean {
  return textSimilarity(a, b) >= 0.9
}

/** 判断某条摘要是否是捕获过程中的近似重复候选（§12.4）。 */
export function summariesConflict(a: string, b: string): boolean {
  return textSimilarity(a, b) >= 0.7
}

/** 把字节数格式化为紧凑的可读字符串。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
