/**
 * Derived index: BM25 postings plus the metadata the core layer needs.
 *
 * `index.json` is a cache and can be deleted at any time. Its `sourceHash`
 * covers the id, size, mtime and content hash of every memory file; a mismatch
 * rebuilds from Markdown, which remains the source of truth.
 */
import { createHash } from 'node:crypto'
import type { MemoryKind, MemoryRecord, MemoryScope, TrustState } from '../types.ts'
import { displayId } from '../ids.ts'
import { indexRecord } from '../retrieval/bm25.ts'
import { importanceNorm, KIND_WEIGHT, TRUST_WEIGHT, SCORE_WEIGHTS } from '../retrieval/score.ts'
import { formatBytes } from './sanitize.ts'

/** Indexed projection of one record (no body). */
export interface IndexedDoc {
  id: string
  slug: string
  kind: MemoryKind
  trust: TrustState
  title: string
  summary: string
  tags: string[]
  importance: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
  expiresAt?: number
  pinned: boolean
  muted: boolean
  conflictOf?: string[]
  /** Precomputed trust + importance + kind contribution. */
  priorScore?: number
  /** Weighted token length for BM25. */
  length: number
}

/** One skipped file. */
export interface MalformedFile {
  file: string
  id?: string
  message: string
}

/** In-memory index for one scope. */
export interface ScopeIndex {
  scopeKey: string
  builtAt: number
  sourceHash: string
  docs: Map<string, IndexedDoc>
  postings: Map<string, Map<string, number>>
  /** Records for this scope; body may be empty when hydrated from index.json. */
  records: MemoryRecord[]
  /** Monotonic cache version used by the core cache. */
  version: number
  malformed: MalformedFile[]
  /** Whether records came from parsed files (vs. a validated index.json). */
  hydrated: boolean
}

/** Source fingerprint entry for one file. */
export interface SourceFileEntry {
  id: string
  size: number
  mtimeMs: number
  contentHash: string
}

/** Stable hash over all source files (order independent). */
export function computeSourceHash(entries: readonly SourceFileEntry[]): string {
  const lines = entries
    .map((entry) => `${entry.id}\u0000${entry.size}\u0000${Math.trunc(entry.mtimeMs)}\u0000${entry.contentHash}`)
    .sort()
    .join('\n')
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`
}

/** Project one record into the searchable metadata shape. */
export function toIndexedDoc(record: MemoryRecord, length: number): IndexedDoc {
  return {
    id: record.id,
    slug: record.slug,
    kind: record.kind,
    trust: record.trust,
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    importance: record.importance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
    useCount: record.useCount,
    expiresAt: record.expiresAt,
    pinned: record.pinned,
    muted: record.muted,
    conflictOf: record.conflictOf,
    priorScore:
      SCORE_WEIGHTS.trust * TRUST_WEIGHT[record.trust] +
      SCORE_WEIGHTS.importance * importanceNorm(record.importance) +
      SCORE_WEIGHTS.kind * KIND_WEIGHT[record.kind],
    length
  }
}

/** Build an index from records. Pure function: same input, same output. */
export function buildScopeIndex(
  records: readonly MemoryRecord[],
  scopeKey: string,
  sourceHash: string,
  version: number,
  malformed: MalformedFile[] = []
): ScopeIndex {
  const docs = new Map<string, IndexedDoc>()
  const postings = new Map<string, Map<string, number>>()
  for (const record of records) {
    const doc = indexRecord(record)
    docs.set(record.id, toIndexedDoc(record, doc.length))
    for (const [term, tf] of doc.terms) {
      let posting = postings.get(term)
      if (posting === undefined) {
        posting = new Map<string, number>()
        postings.set(term, posting)
      }
      posting.set(record.id, tf)
    }
  }
  return {
    scopeKey,
    builtAt: Date.now(),
    sourceHash,
    docs,
    postings,
    records: [...records],
    version,
    malformed,
    hydrated: true
  }
}

// Imported through one binding to keep the pure-index module free of a cycle
// with retrieval/score.

/** JSON shape persisted as `index.json`. */
export interface IndexJson {
  schemaVersion: 1
  scope: string
  builtAt: number
  sourceHash: string
  docCount: number
  docs: Record<string, IndexedDoc>
  postings: Record<string, Record<string, number>>
}

/** Serialize an index to the on-disk JSON shape. */
export function serializeScopeIndex(index: ScopeIndex): IndexJson {
  const docs: Record<string, IndexedDoc> = {}
  for (const [id, doc] of index.docs) docs[id] = doc
  const postings: Record<string, Record<string, number>> = {}
  for (const [term, posting] of index.postings) {
    const inner: Record<string, number> = {}
    for (const [id, tf] of posting) inner[id] = tf
    postings[term] = inner
  }
  return {
    schemaVersion: 1,
    scope: index.scopeKey,
    builtAt: index.builtAt,
    sourceHash: index.sourceHash,
    docCount: index.docs.size,
    docs,
    postings
  }
}

/** Parse a persisted index, rejecting a mismatched scope or schema. */
export function parseScopeIndexJson(
  text: string,
  scopeKey: string,
  scope: MemoryScope,
  version: number
): ScopeIndex | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object') return null
  const json = data as Partial<IndexJson>
  if (json.schemaVersion !== 1 || json.scope !== scopeKey || typeof json.sourceHash !== 'string') {
    return null
  }
  if (json.docs === null || typeof json.docs !== 'object' || json.postings === null || typeof json.postings !== 'object') {
    return null
  }
  const docs = new Map<string, IndexedDoc>()
  const records: MemoryRecord[] = []
  for (const [id, raw] of Object.entries(json.docs as Record<string, unknown>)) {
    const doc = raw as IndexedDoc
    if (typeof doc.slug !== 'string' || typeof doc.summary !== 'string' || typeof doc.kind !== 'string') return null
    docs.set(id, { ...doc, id })
    records.push(docToPartialRecord(doc, scope))
  }
  const postings = new Map<string, Map<string, number>>()
  for (const [term, posting] of Object.entries(json.postings as Record<string, unknown>)) {
    if (posting === null || typeof posting !== 'object') continue
    const inner = new Map<string, number>()
    for (const [id, tf] of Object.entries(posting as Record<string, unknown>)) {
      if (typeof tf === 'number' && Number.isFinite(tf)) inner.set(id, tf)
    }
    postings.set(term, inner)
  }
  return {
    scopeKey,
    builtAt: typeof json.builtAt === 'number' ? json.builtAt : Date.now(),
    sourceHash: json.sourceHash,
    docs,
    postings,
    records,
    version,
    malformed: [],
    hydrated: false
  }
}

/** Reconstruct a body-less record from an index entry. */
function docToPartialRecord(doc: IndexedDoc, scope: MemoryScope): MemoryRecord {
  return {
    schemaVersion: 1,
    id: doc.id,
    slug: doc.slug,
    kind: doc.kind,
    scope,
    title: doc.title,
    summary: doc.summary,
    body: '',
    tags: doc.tags ?? [],
    source: {},
    trust: doc.trust,
    importance: doc.importance,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastUsedAt: doc.lastUsedAt,
    useCount: doc.useCount,
    expiresAt: doc.expiresAt,
    pinned: doc.pinned,
    muted: doc.muted,
    revision: 1,
    conflictOf: doc.conflictOf
  }
}

/** Render a human-readable `index.md`. */
export function renderIndexMarkdown(scopeKey: string, docs: readonly IndexedDoc[], updatedAt = Date.now()): string {
  const sorted = [...docs].sort((a, b) => b.updatedAt - a.updatedAt)
  const lines: string[] = [
    `# Memories — ${scopeKey}`,
    '',
    `Generated at ${new Date(updatedAt).toISOString()}; do not edit by hand.`,
    `Total: ${sorted.length}`,
    ''
  ]
  for (const doc of sorted) {
    const badges: string[] = [doc.trust, doc.kind]
    if (doc.pinned) badges.push('pinned')
    if (doc.muted) badges.push('muted')
    lines.push(`- [${badges.join(' · ')}] ${doc.title} — ${doc.summary} (${displayId(doc.id)})`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Compact byte estimate for a doc list, used by stats. */
export function estimateDocsBytes(docs: readonly IndexedDoc[]): number {
  return docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.summary, 'utf8'), 0)
}

/** Human summary line for stats. */
export function summarizeIndex(index: ScopeIndex): string {
  return `${index.scopeKey}: ${index.docs.size} docs, ${index.postings.size} terms, ${formatBytes(estimateDocsBytes([...index.docs.values()]))}`
}
