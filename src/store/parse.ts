/**
 * Markdown + YAML frontmatter parsing and serialization.
 *
 * Unknown frontmatter keys are preserved. A malformed file is reported and
 * skipped, never deleted. The directory a file lives in decides its scope; a
 * conflicting `scope` field is reported and ignored.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { shortHash } from './sanitize.ts'
import { generateUlid, isUlid } from '../ids.ts'
import {
  MEMORY_KINDS,
  MemoryError,
  SCHEMA_VERSION,
  TRUST_STATES,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
  type TrustState
} from '../types.ts'
import { normalizeSlug, normalizeSource, normalizeTags, singleLine } from './sanitize.ts'

/** All frontmatter keys owned by this plugin. */
const KNOWN_FIELDS = new Set([
  'schemaVersion',
  'id',
  'slug',
  'kind',
  'scope',
  'title',
  'summary',
  'tags',
  'trust',
  'importance',
  'createdAt',
  'updatedAt',
  'lastUsedAt',
  'useCount',
  'source',
  'evidence',
  'verifiedBy',
  'verifiedAt',
  'pinned',
  'muted',
  'supersedes',
  'supersededBy',
  'conflictOf',
  'expiresAt',
  'revision'
])

/** Parsed file plus metadata needed to repair it. */
export interface ParsedMemoryFile {
  record: MemoryRecord
  rawFrontmatter: Record<string, unknown>
  warnings: string[]
  needsWrite: boolean
  /** True when the id was synthesized because the file had none. */
  generatedId: boolean
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Split a Markdown file into raw frontmatter YAML and body. */
export function splitFrontmatter(text: string): { yaml: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = FRONTMATTER.exec(normalized)
  if (match === null) {
    throw new MemoryError('MALFORMED_MEMORY', 'missing YAML frontmatter')
  }
  return {
    yaml: match[1] ?? '',
    body: normalized.slice(match[0].length).replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
  }
}

function asString(value: unknown, max = 10_000): string | undefined {
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true'
}

function asEpoch(value: unknown, fallback: number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return fallback
}

function asOptionalEpoch(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  return asEpoch(value, Number.NaN) || undefined
}

function asKind(value: unknown): MemoryKind | undefined {
  return MEMORY_KINDS.includes(value as MemoryKind) ? (value as MemoryKind) : undefined
}

function asTrust(value: unknown): TrustState {
  return TRUST_STATES.includes(value as TrustState) ? (value as TrustState) : 'candidate'
}

function asSource(value: unknown): MemorySource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return normalizeSource(value as Record<string, unknown>) as MemorySource
}

function asEvidence(value: unknown): MemoryEvidence | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const quote = asString((value as Record<string, unknown>).quote, 500)?.trim()
  if (quote === undefined || quote.length === 0) return undefined
  const hash = asString((value as Record<string, unknown>).hash, 128)
  return hash !== undefined && hash.length > 0 ? { quote, hash } : { quote }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** Parse one memory file. `scope` is authoritative (from its directory). */
export function parseMemoryFile(text: string, scope: MemoryScope, now: number = Date.now()): ParsedMemoryFile {
  const { yaml, body } = splitFrontmatter(text)
  let data: unknown
  try {
    data = parseYaml(yaml, { maxAliasCount: 50, logLevel: 'silent' })
  } catch (error) {
    throw new MemoryError('MALFORMED_MEMORY', `invalid YAML frontmatter: ${(error as Error).message}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MemoryError('MALFORMED_MEMORY', 'frontmatter must be a YAML mapping')
  }
  const raw = data as Record<string, unknown>
  const warnings: string[] = []
  let needsWrite = false

  const version = asNumber(raw.schemaVersion) ?? SCHEMA_VERSION
  if (version > SCHEMA_VERSION) {
    throw new MemoryError('SCHEMA_TOO_NEW', `memory schema ${version} is newer than supported ${SCHEMA_VERSION}`)
  }

  const rawId = asString(raw.id, 64)?.trim()
  let id = rawId !== undefined ? rawId.replace(/^mem_/, '') : ''
  let generatedId = false
  if (!isUlid(id)) {
    id = generateUlid(now)
    generatedId = true
    needsWrite = true
    warnings.push('missing or invalid id; generated a new ULID')
  }

  const titleRaw = asString(raw.title, 200)?.trim() ?? ''
  const summaryRaw = asString(raw.summary, 400)?.trim() ?? ''
  let slugRaw = asString(raw.slug, 128)?.trim() ?? ''
  if (slugRaw.length === 0) {
    slugRaw = titleRaw.length > 0 ? titleRaw : `memory-${id.slice(-8).toLowerCase()}`
    needsWrite = true
    warnings.push('missing slug; derived one from the title')
  }
  let slug: string
  try {
    slug = normalizeSlug(slugRaw)
  } catch {
    throw new MemoryError('MALFORMED_MEMORY', `invalid slug "${slugRaw}"`)
  }

  const kind = asKind(raw.kind)
  if (kind === undefined) {
    throw new MemoryError('MALFORMED_MEMORY', `invalid kind "${String(raw.kind)}"`)
  }

  const title = singleLine(titleRaw.length > 0 ? titleRaw : summaryRaw.length > 0 ? summaryRaw : slug, 80)
  const summary = singleLine(summaryRaw.length > 0 ? summaryRaw : title, 200)
  if (title.length === 0) throw new MemoryError('MALFORMED_MEMORY', 'empty title')

  let importance = Math.round(asNumber(raw.importance) ?? 5)
  importance = Math.min(10, Math.max(1, importance))

  const createdAt = asEpoch(raw.createdAt, now)
  const updatedAt = asEpoch(raw.updatedAt, createdAt)
  const lastUsedAt = asOptionalEpoch(raw.lastUsedAt)
  const verifiedAt = asOptionalEpoch(raw.verifiedAt)
  const expiresAt = asOptionalEpoch(raw.expiresAt)

  const record: MemoryRecord = {
    schemaVersion: SCHEMA_VERSION,
    id,
    slug,
    kind,
    scope,
    title,
    summary,
    body,
    tags: normalizeTags(raw.tags),
    source: asSource(raw.source),
    trust: asTrust(raw.trust),
    importance,
    createdAt,
    updatedAt,
    lastUsedAt,
    useCount: Math.max(0, Math.round(asNumber(raw.useCount) ?? 0)),
    expiresAt,
    supersedes: asString(raw.supersedes, 64)?.replace(/^mem_/, '') || undefined,
    supersededBy: asString(raw.supersededBy, 64)?.replace(/^mem_/, '') || undefined,
    conflictOf: asStringArray(raw.conflictOf).map((item) => item.replace(/^mem_/, '')),
    pinned: asBoolean(raw.pinned),
    muted: asBoolean(raw.muted),
    verifiedBy: raw.verifiedBy === 'user' ? 'user' : undefined,
    verifiedAt,
    revision: Math.max(1, Math.round(asNumber(raw.revision) ?? 1)),
    evidence: asEvidence(raw.evidence)
  }

  const conflictOf = record.conflictOf ?? []
  if (conflictOf.length === 0) delete record.conflictOf

  if (raw.scope !== undefined) {
    const expected = scope.type === 'user' ? 'user' : `project:${scope.key}`
    const actual = typeof raw.scope === 'string' ? raw.scope : ''
    if (actual !== expected) {
      warnings.push(`frontmatter scope "${actual}" does not match directory scope "${expected}"; using directory`)
    }
  }

  const rawFrontmatter: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(key)) rawFrontmatter[key] = value
  }
  if (Object.keys(rawFrontmatter).length > 0) record.rawFrontmatter = rawFrontmatter

  return { record, rawFrontmatter, warnings, needsWrite, generatedId }
}

/** Date to ISO string (epoch ms). */
function iso(epoch: number | undefined): string | null {
  return epoch === undefined ? null : new Date(epoch).toISOString()
}

/** Serialize one record back to Markdown with a stable field order. */
export function serializeMemoryFile(record: MemoryRecord): string {
  const data: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    id: record.id,
    slug: record.slug,
    kind: record.kind,
    scope: record.scope.type === 'user' ? 'user' : `project:${record.scope.key}`,
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    trust: record.trust,
    importance: record.importance,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    lastUsedAt: iso(record.lastUsedAt),
    useCount: record.useCount,
    source: record.source,
    evidence: record.evidence ?? null,
    verifiedBy: record.verifiedBy ?? null,
    verifiedAt: iso(record.verifiedAt),
    pinned: record.pinned,
    muted: record.muted,
    supersedes: record.supersedes ?? null,
    supersededBy: record.supersededBy ?? null,
    conflictOf: record.conflictOf ?? [],
    expiresAt: iso(record.expiresAt),
    revision: record.revision
  }
  if (record.rawFrontmatter !== undefined) {
    for (const [key, value] of Object.entries(record.rawFrontmatter)) {
      if (!(key in data)) data[key] = value
    }
  }
  const yaml = stringifyYaml(data, { lineWidth: 0 })
  return `---\n${yaml}---\n\n${record.body}\n`
}

/** Compute/refresh the evidence fingerprint for a quote. */
export function evidenceFor(quote: string): MemoryEvidence {
  return { quote, hash: shortHash(quote, 16) }
}
