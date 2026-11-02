/**
 * Core data model for dsh-memory.
 *
 * A memory is a plain Markdown file with YAML frontmatter. The record below is
 * the in-memory projection; `rawFrontmatter` keeps user-authored unknown keys
 * so hand edits survive a round trip.
 */

/** Format version written into every memory file and derived index. */
export const SCHEMA_VERSION = 1 as const

/** Semantic category of a memory. */
export type MemoryKind =
  | 'preference'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'artifact'
  | 'episode'

/** All memory kinds, in the order used by tool schemas and UI filters. */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'constraint',
  'decision',
  'fact',
  'artifact',
  'episode'
]

/** Scope of a memory: global to the user, or one project key. */
export type MemoryScope =
  | { type: 'user' }
  | { type: 'project'; key: string }

/** Trust lifecycle. Only a user may move a record to `verified`. */
export type TrustState = 'candidate' | 'verified' | 'disputed' | 'superseded'

/** All trust states. */
export const TRUST_STATES: readonly TrustState[] = [
  'candidate',
  'verified',
  'disputed',
  'superseded'
]

/** Provenance pointers for a memory. */
export interface MemorySource {
  sessionId?: string
  messageId?: string
  tool?: string
  file?: string
  commit?: string
  url?: string
}

/** A verbatim quote backing a memory. */
export interface MemoryEvidence {
  /** Verbatim excerpt, at most 500 characters. */
  quote: string
  /** Optional fingerprint of the quote or its source. */
  hash?: string
}

/** One persistent memory record. */
export interface MemoryRecord {
  schemaVersion: typeof SCHEMA_VERSION
  /** ULID primary key; never changes once created. */
  id: string
  /** Kebab-case, unique within a scope. */
  slug: string
  kind: MemoryKind
  scope: MemoryScope
  /** Single-line title, at most 80 characters. */
  title: string
  /** Single-line summary, at most 200 characters. */
  summary: string
  /** Markdown body, at most 8 KB by default. */
  body: string
  tags: string[]
  source: MemorySource
  evidence?: MemoryEvidence
  trust: TrustState
  /** 1–10. */
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
  /** Incremented on every content change. */
  revision: number
  /** Unknown frontmatter keys, preserved on write. */
  rawFrontmatter?: Record<string, unknown>
}

/** A record plus its storage provenance. */
export interface LocatedMemory {
  record: MemoryRecord
  scope: MemoryScope
  /** Absolute path of the memory file. */
  file: string
}

/** Input accepted by {@link MemoryStore.write}. */
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

/** Result of one write. */
export interface MemoryWriteResult {
  record: MemoryRecord
  operation: 'created' | 'updated'
  truncated: boolean
  /** IDs of memories this write appears to conflict with. */
  conflicts: string[]
}

/** One ranked search result. */
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

/** Options accepted by {@link MemoryStore.search}. */
export interface MemorySearchOptions {
  query: string
  /** `all` searches every scope; the caller's current project still ranks higher. */
  scope: 'user' | 'project' | 'all'
  /** Project scope resolved from the owning agent; required unless only user scope is queried. */
  projectScope?: MemoryScope
  kinds?: MemoryKind[]
  limit?: number
  includeDisputed?: boolean
  /** Session id recorded in the audit event (never the query text). */
  sessionId?: string
  /** Who issued the search; defaults to `model`. */
  actor?: 'model' | 'user'
}

/** Options accepted by {@link MemoryStore.list}. */
export interface MemoryListOptions {
  scope: 'user' | 'project' | 'all'
  projectScope?: MemoryScope
  kind?: MemoryKind
  includeAll?: boolean
  limit?: number
}

/** Doctor report entry. */
export interface DoctorFinding {
  level: 'error' | 'warn' | 'info'
  code: string
  scope?: string
  id?: string
  message: string
}

/** Error codes defined by the design document. */
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

/** A typed, model-safe failure. */
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

/** Plugin configuration resolved from the profile patch. */
export interface MemoryConfig {
  /** Root memory directory; defaults to `$DSH_HOME/memory`. */
  memoryDir?: string
  maxCoreBytes: number
  maxCoreItems: number
  maxSearchResults: number
  maxBodyBytes: number
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

/** Default importance per kind (§4.2). */
export const DEFAULT_IMPORTANCE: Record<MemoryKind, number> = {
  preference: 8,
  constraint: 9,
  decision: 8,
  fact: 6,
  artifact: 4,
  episode: 4
}

/** Default scope per kind (§6.3). */
export function defaultScopeForKind(kind: MemoryKind): MemoryScope {
  if (kind === 'preference' || kind === 'artifact') return { type: 'user' }
  return { type: 'project', key: '' }
}

/** Kinds allowed at user scope (§6.3). */
export const USER_SCOPE_KINDS: readonly MemoryKind[] = ['preference', 'artifact']

/** Default TTL for episodes (§4.2). */
export const EPISODE_TTL_MS = 90 * 24 * 60 * 60 * 1000
