/**
 * Stable identifiers and link syntax.
 *
 * Records use ULIDs so a memory keeps its identity when its slug or wording
 * changes. Links accept either the ULID (with or without the `mem_` display
 * prefix) or a slug resolved within the same scope.
 */
import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Generate a monotonic-enough ULID (26 characters, Crockford base32). */
export function generateUlid(now: number = Date.now()): string {
  let time = Math.floor(now)
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[time % 32]! + out
    time = Math.floor(time / 32)
  }
  const random = randomBytes(16)
  for (let i = 0; i < 16; i += 1) {
    out += CROCKFORD[random[i]! % 32]!
  }
  return out
}

/** Whether a string is a canonical ULID-shaped id. */
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}

/** Strip the `mem_` display prefix from an id. */
export function bareId(value: string): string {
  return value.startsWith('mem_') ? value.slice(4) : value
}

/** Render an id for model-facing text. */
export function displayId(id: string): string {
  return `mem_${id}`
}

/** A resolved `[[link]]` inside a memory body. */
export interface MemoryLinkRef {
  raw: string
  id?: string
  slug?: string
}

/** Extract `[[...]]` references from Markdown, without duplicates. */
export function extractLinks(body: string): MemoryLinkRef[] {
  const out: MemoryLinkRef[] = []
  const seen = new Set<string>()
  const re = /\[\[([^[\]\n]{1,128})\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    const raw = match[1]!.trim()
    if (raw.length === 0 || seen.has(raw)) continue
    seen.add(raw)
    const candidate = bareId(raw)
    if (isUlid(candidate)) out.push({ raw, id: candidate })
    else if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) out.push({ raw, slug: raw })
  }
  return out
}
