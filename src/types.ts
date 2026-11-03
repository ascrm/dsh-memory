/**
 * dsh-memory 的核心数据模型。
 *
 * 一条记忆就是一个带 YAML frontmatter 的普通 Markdown 文件。下面的记录是内存中的
 * 投影；`rawFrontmatter` 保留用户自行编写的未知键，使手工编辑在往返读写后依然保留。
 */

/** 写入每个记忆文件和派生索引的格式版本。 */
export const SCHEMA_VERSION = 1 as const

/** 记忆的语义类别。 */
export type MemoryKind =
  | 'preference'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'artifact'
  | 'episode'

/** 全部记忆类型，顺序与工具 schema 和 UI 过滤器一致。 */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'constraint',
  'decision',
  'fact',
  'artifact',
  'episode'
]

/** 记忆的作用域：用户全局，或某个项目键。 */
export type MemoryScope =
  | { type: 'user' }
  | { type: 'project'; key: string }

/** trust 生命周期。只有用户能把一条记录转为 `verified`。 */
export type TrustState = 'candidate' | 'verified' | 'disputed' | 'superseded'

/** 全部 trust 状态。 */
export const TRUST_STATES: readonly TrustState[] = [
  'candidate',
  'verified',
  'disputed',
  'superseded'
]

/** 一条记忆的 provenance 指针。 */
export interface MemorySource {
  sessionId?: string
  messageId?: string
  tool?: string
  file?: string
  commit?: string
  url?: string
}

/** 支撑某条记忆的原文引用。 */
export interface MemoryEvidence {
  /** 原文摘录，最多 500 个字符。 */
  quote: string
  /** 引用原文或其来源的可选指纹。 */
  hash?: string
}

/** 一条持久化记忆记录。 */
export interface MemoryRecord {
  schemaVersion: typeof SCHEMA_VERSION
  /** ULID 主键；创建后永不改变。 */
  id: string
  /** kebab-case 形式，在作用域内唯一。 */
  slug: string
  kind: MemoryKind
  scope: MemoryScope
  /** 单行标题，最多 80 个字符。 */
  title: string
  /** 单行摘要，最多 200 个字符。 */
  summary: string
  /** Markdown 正文，默认最多 8 KB。 */
  body: string
  tags: string[]
  source: MemorySource
  evidence?: MemoryEvidence
  trust: TrustState
  /** 取值为 1–10。 */
  importance: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
  expiresAt?: number
  supersedes?: string
  supersededBy?: string
  conflictOf?: string[]
  pinned: boolean
  muted: boolean
  verifiedBy?: 'user'
  verifiedAt?: number
  /** 每次内容变更都会递增。 */
  revision: number
  /** 未知的 frontmatter 键，写入时保留。 */
  rawFrontmatter?: Record<string, unknown>
}

/** 一条记录及其存储位置来源。 */
export interface LocatedMemory {
  record: MemoryRecord
  scope: MemoryScope
  /** 记忆文件的绝对路径。 */
  file: string
}

/** {@link MemoryStore.write} 接受的输入。 */
export interface MemoryWriteInput {
  id?: string
  slug?: string
  kind: MemoryKind
  title: string
  summary: string
  body: string
  tags?: string[]
  scope: MemoryScope
  importance?: number
  evidence?: string
  source?: MemorySource
  expiresAt?: number | null
}

/** 一次写入的结果。 */
export interface MemoryWriteResult {
  record: MemoryRecord
  operation: 'created' | 'updated'
  truncated: boolean
  /** 与本次写入疑似冲突的记忆 ID。 */
  conflicts: string[]
}

/** 用户解决冲突时可提供的合并内容；未提供的字段沿用保留方。 */
export interface MemoryMergeInput {
  title?: string
  summary?: string
  body?: string
  tags?: string[]
  importance?: number
  evidence?: string
}

/** 一条带排名的搜索结果。 */
export interface MemorySearchHit {
  id: string
  slug: string
  kind: MemoryKind
  title: string
  summary: string
  trust: TrustState
  score: number
  scope: MemoryScope
  updatedAt: number
  pinned: boolean
}

/** {@link MemoryStore.search} 接受的选项。 */
export interface MemorySearchOptions {
  query: string
  /** `all` 会搜索每个作用域；调用方当前所在的项目仍然排名更高。 */
  scope: 'user' | 'project' | 'all'
  /** 由所属 agent 解析出的项目作用域；除非只查询用户作用域，否则必填。 */
  projectScope?: MemoryScope
  kinds?: MemoryKind[]
  limit?: number
  includeDisputed?: boolean
  /** 记录在审计事件中的会话 id（绝不记录查询文本）。 */
  sessionId?: string
  /** 发起搜索的一方；默认为 `model`。 */
  actor?: 'model' | 'user'
  /** 为 false 时，`all` 不包含当前项目之外的其他项目（per-turn recall 使用）。 */
  includeOtherProjects?: boolean
  /** 为 false 时不写 search 审计事件（recall 自己写 inject 审计）。 */
  audit?: boolean
  /** 为 false 时不使用元数据分补足关键词命中不足的候选（recall 使用）。 */
  includeMetadataFallback?: boolean
}

/** {@link MemoryStore.list} 接受的选项。 */
export interface MemoryListOptions {
  scope: 'user' | 'project' | 'all'
  projectScope?: MemoryScope
  kind?: MemoryKind
  includeAll?: boolean
  limit?: number
}

/** doctor 报告条目。 */
export interface DoctorFinding {
  level: 'error' | 'warn' | 'info'
  code: string
  scope?: string
  id?: string
  message: string
}

/** 设计文档中定义的错误码。 */
export type MemoryErrorCode =
  | 'INVALID_SLUG'
  | 'RESERVED_SLUG'
  | 'DUPLICATE_SLUG'
  | 'NOT_FOUND'
  | 'BODY_TOO_LARGE'
  | 'SCOPE_REQUIRED'
  | 'SCOPE_FORBIDDEN'
  | 'LOCK_TIMEOUT'
  | 'MALFORMED_MEMORY'
  | 'SCHEMA_TOO_NEW'
  | 'INVALID_ARGUMENT'
  | 'IO_ERROR'

/** 带类型、对模型安全的失败。 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: MemoryErrorCode, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`)
    this.name = 'MemoryError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** 由 profile patch 解析出的插件配置。 */
export interface MemoryConfig {
  /** 记忆根目录；默认为 `$DSH_HOME/memory`。 */
  memoryDir?: string
  maxCoreBytes: number
  maxCoreItems: number
  maxSearchResults: number
  maxBodyBytes: number
  /** 是否根据当前用户消息做 per-turn recall 注入。 */
  enableRecall: boolean
  /** recall 段的字节预算。 */
  recallMaxBytes: number
  /** recall 段最多包含的记忆条数。 */
  recallMaxItems: number
  /** recall 是否包含未验证的 candidate。 */
  recallIncludeCandidates: boolean
  /** 冷索引导致检索超时后放弃本回合 recall 的毫秒数。 */
  recallTimeoutMs: number
  /** 派生索引后端：JSON 或可选 SQLite FTS5。 */
  indexBackend: 'json' | 'sqlite'
  /** 是否同时索引 CJK 单字；默认关闭以控制索引体积。 */
  cjkUnigrams: boolean
  enableUserScope: boolean
  enableAutoCapture: boolean
  autoCaptureMaxTokens: number
  autoCaptureMaxItems: number
  trustCandidatesInCore: boolean
  staleAfterDays: number
  decayHalfLifeDays: number
  projectScope: 'git' | 'path'
  enablePanel: boolean
  redactPhoneAndId: boolean
}

/** 各类型的默认 importance（§4.2）。 */
export const DEFAULT_IMPORTANCE: Record<MemoryKind, number> = {
  preference: 8,
  constraint: 9,
  decision: 8,
  fact: 6,
  artifact: 4,
  episode: 4
}

/** 各类型的默认作用域（§6.3）。 */
export function defaultScopeForKind(kind: MemoryKind): MemoryScope {
  if (kind === 'preference' || kind === 'artifact') return { type: 'user' }
  return { type: 'project', key: '' }
}

/** 用户作用域允许的类型（§6.3）。 */
export const USER_SCOPE_KINDS: readonly MemoryKind[] = ['preference', 'artifact']

/** episode 的默认 TTL（§4.2）。 */
export const EPISODE_TTL_MS = 90 * 24 * 60 * 60 * 1000
