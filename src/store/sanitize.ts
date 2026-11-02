/**
 * Input normalization, framing escapes and secret redaction.
 *
 * Every string that reaches the system prompt or a tool result passes through
 * these helpers. The disk is not trusted: hand-edited files are re-sanitized
 * on every read.
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

/** Normalize and validate a slug (kebab-case, at most 64 characters). */
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

/** Collapse whitespace and truncate to one line. */
export function singleLine(input: string, max: number): string {
  const one = input.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) : one
}

/** Escape protocol-shell tags so stored text cannot close `<memory_context>`. */
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
  // Mainland Chinese mobile numbers.
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, label: 'phone' },
  // 18-digit mainland ID numbers (last char may be X).
  { pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g, label: 'id-number' }
]

/** Replace known credential shapes with `[REDACTED:kind]`. */
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

/** Redact, escape and single-line text destined for injected prompt text. */
export function sanitizeInjectionText(
  text: string,
  max: number,
  options: { redactPhoneAndId?: boolean } = {}
): string {
  return escapeFrame(singleLine(redactSecrets(text, options), max))
}

/** Sanitize a multi-line body while preserving line structure. */
export function sanitizeBody(text: string, options: { redactPhoneAndId?: boolean } = {}): string {
  return escapeFrame(redactSecrets(text, options))
}

/** Normalize source provenance fields to short single-line strings. */
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

/** Normalize a user-provided tag list. */
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

/** Mark (never block) prompt-injection-looking content. */
export function detectSuspicious(text: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(text))
}

/** Full SHA-256 hex digest. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Short hash used for fingerprints. */
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

/** Jaccard similarity over latin words + CJK bigrams. */
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

/** Whether two summaries are near-duplicates by the design threshold. */
export function summariesNearDuplicate(a: string, b: string): boolean {
  return textSimilarity(a, b) >= 0.9
}

/** Whether a summary is a near-duplicate candidate during capture (§12.4). */
export function summariesConflict(a: string, b: string): boolean {
  return textSimilarity(a, b) >= 0.7
}

/** Format bytes as a compact human string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
