/**
 * 派生索引：BM25 postings，以及核心层所需的元数据。
 *
 * `index.json` 只是一份缓存，随时可以删除。它的 `sourceHash` 覆盖每个记忆文件的 id、
 * 大小、mtime 和内容哈希；一旦不匹配，就从 Markdown 重建，Markdown 始终是唯一事实来源。
 */
import { createHash } from 'node:crypto'
import type { MemoryKind, MemoryRecord, MemoryScope, TrustState } from '../types.ts'
import { displayId } from '../ids.ts'
import { indexRecord } from '../retrieval/bm25.ts'
import { importanceNorm, KIND_WEIGHT, TRUST_WEIGHT, SCORE_WEIGHTS } from '../retrieval/score.ts'
import { formatBytes } from './sanitize.ts'

/** 单条记录的索引投影（不含正文）。 */
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
  /** 预计算的 trust + importance + kind 贡献。 */
  priorScore?: number
  /** BM25 使用的加权 token 长度。 */
  length: number
}

/** 一个被跳过的文件。 */
export interface MalformedFile {
  file: string
  id?: string
  message: string
}

/** 某个作用域的内存索引。 */
export interface ScopeIndex {
  scopeKey: string
  builtAt: number
  sourceHash: string
  docs: Map<string, IndexedDoc>
  postings: Map<string, Map<string, number>>
  /** 该作用域的记录；从 index.json 还原时正文可能为空。 */
  records: MemoryRecord[]
  /** 供核心缓存使用的单调递增版本号。 */
  version: number
  malformed: MalformedFile[]
  /** 记录是否来自解析文件（而不是经过校验的 index.json）。 */
  hydrated: boolean
  /** 派生索引后端；缺省为 JSON。 */
  backend?: 'json' | 'sqlite'
  /** 每个源文件的指纹；用于 JSON 后端的增量 sourceHash 更新。 */
  files?: Map<string, SourceFileEntry>
  /** 构建该索引时是否启用 CJK 单字。 */
  cjkUnigrams?: boolean
}

/** 单个文件的来源指纹条目。 */
export interface SourceFileEntry {
  id: string
  size: number
  mtimeMs: number
  contentHash: string
}

/** 覆盖所有源文件的稳定哈希（与顺序无关）。 */
export function computeSourceHash(entries: readonly SourceFileEntry[]): string {
  const lines = entries
    .map((entry) => `${entry.id}\u0000${entry.size}\u0000${Math.trunc(entry.mtimeMs)}\u0000${entry.contentHash}`)
    .sort()
    .join('\n')
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`
}

/** 把一条记录投影成可搜索的元数据形态。 */
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

/** 从记录构建索引。纯函数：同样的输入得到同样的输出。 */
export function buildScopeIndex(
  records: readonly MemoryRecord[],
  scopeKey: string,
  sourceHash: string,
  version: number,
  malformed: MalformedFile[] = [],
  files?: Map<string, SourceFileEntry>,
  cjkUnigrams = false
): ScopeIndex {
  const docs = new Map<string, IndexedDoc>()
  const postings = new Map<string, Map<string, number>>()
  for (const record of records) {
    const doc = indexRecord(record, { cjkUnigrams })
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
    hydrated: true,
    files,
    cjkUnigrams
  }
}

/** 持久化为 `index.json` 的 JSON 形态。 */
export interface IndexJson {
  schemaVersion: 1
  scope: string
  builtAt: number
  sourceHash: string
  docCount: number
  docs: Record<string, IndexedDoc>
  postings: Record<string, Record<string, number>>
  files?: Record<string, SourceFileEntry>
  cjkUnigrams?: boolean
}

/** 把索引序列化为磁盘上的 JSON 形态。 */
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
    postings,
    ...(index.files !== undefined && index.files.size > 0
      ? { files: Object.fromEntries(index.files) }
      : {}),
    ...(index.cjkUnigrams === true ? { cjkUnigrams: true } : {})
  }
}

/** 解析已持久化的索引；作用域或 schema 不匹配时拒绝。 */
export function parseScopeIndexJson(
  text: string,
  scopeKey: string,
  scope: MemoryScope,
  version: number,
  cjkUnigrams = false
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
  if ((json.cjkUnigrams === true) !== cjkUnigrams) return null
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
  const files = new Map<string, SourceFileEntry>()
  if (json.files !== null && typeof json.files === 'object') {
    for (const [id, raw] of Object.entries(json.files as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as Partial<SourceFileEntry>
      if (
        typeof entry.size === 'number' &&
        typeof entry.mtimeMs === 'number' &&
        typeof entry.contentHash === 'string'
      ) {
        files.set(id, { id, size: entry.size, mtimeMs: entry.mtimeMs, contentHash: entry.contentHash })
      }
    }
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
    hydrated: false,
    ...(files.size > 0 ? { files } : {}),
    ...(cjkUnigrams ? { cjkUnigrams: true } : {})
  }
}

/** 从索引条目重建一条不含正文的记录。 */
export function docToPartialRecord(doc: IndexedDoc, scope: MemoryScope): MemoryRecord {
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

/** 渲染人类可读的 `index.md`。 */
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

/** 估算文档列表的紧凑字节数，供统计使用。 */
export function estimateDocsBytes(docs: readonly IndexedDoc[]): number {
  return docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.summary, 'utf8'), 0)
}

/** 供统计使用的可读摘要行。 */
export function summarizeIndex(index: ScopeIndex): string {
  return `${index.scopeKey}: ${index.docs.size} docs, ${index.postings.size} terms, ${formatBytes(estimateDocsBytes([...index.docs.values()]))}`
}
