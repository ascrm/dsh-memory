/**
 * Single write point for every memory.
 *
 * All mutation paths (tools, panel API, import, auto capture) go through this
 * class. Files are written atomically under a per-scope cross-process lock;
 * `index.json` is a best-effort derivative that is rebuilt from Markdown when
 * stale.
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DEFAULT_IMPORTANCE,
  EPISODE_TTL_MS,
  MEMORY_KINDS,
  MemoryError,
  SCHEMA_VERSION,
  USER_SCOPE_KINDS,
  type DoctorFinding,
  type LocatedMemory,
  type MemoryConfig,
  type MemoryKind,
  type MemoryListOptions,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemoryWriteInput,
  type MemoryWriteResult,
  type TrustState
} from '../types.ts'
import { bareId, displayId, generateUlid, isUlid } from '../ids.ts'
import {
  buildScopeIndex,
  computeSourceHash,
  parseScopeIndexJson,
  renderIndexMarkdown,
  serializeScopeIndex,
  type IndexedDoc,
  type MalformedFile,
  type ScopeIndex,
  type SourceFileEntry
} from './index.ts'
import {
  normalizeSlug,
  normalizeSource,
  normalizeTags,
  redactSecrets,
  sanitizeBody,
  sha256,
  singleLine,
  summariesConflict
} from './sanitize.ts'
import {
  evidenceFor,
  parseMemoryFile,
  serializeMemoryFile,
  type ParsedMemoryFile
} from './parse.ts'
import {
  canonicalPath,
  isRegularFile,
  listProjectKeys,
  memoriesDir,
  parseScopeKey,
  projectIdentity,
  projectJsonFile,
  projectScopeFor,
  scopeDir,
  scopeKey,
  type ProjectIdentity
} from './paths.ts'
import { MemoryAudit } from './audit.ts'
import { BM25_B, BM25_K1 } from '../retrieval/bm25.ts'
import { tokenize } from '../retrieval/tokenize.ts'
import {
  dedupeCandidates,
  mmrSelect,
  scoreDoc,
  type ScoredMemory
} from '../retrieval/score.ts'

/** Options for constructing a store. */
export interface MemoryStoreOptions {
  now?: () => number
  warn?: (message: string) => void
  lockWaitMs?: number
}

interface SourceFile {
  file: string
  filenameId: string
  text: string
  entry: SourceFileEntry
}

interface FileStat {
  file: string
  filenameId: string
  size: number
  mtimeMs: number
}

/** The one write API for memories. */
export class MemoryStore {
  readonly root: string
  readonly config: MemoryConfig
  readonly audit: MemoryAudit
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly lockWaitMs: number
  private readonly cache = new Map<string, ScopeIndex>()
  private readonly meta = new Map<string, { statSignature: string; indexMtimeMs: number; checkedAt: number }>()
  private version = 0
  private evidenceVerifier?: (quote: string, sessionId?: string) => boolean

  constructor(root: string, config: MemoryConfig, options: MemoryStoreOptions = {}) {
    this.root = canonicalPath(root)
    this.config = config
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? (() => {})
    this.lockWaitMs = options.lockWaitMs ?? 5000
    this.audit = new MemoryAudit(this.root, this.warn)
  }

  /** Install a transcript-backed evidence verifier (used by auto capture). */
  setEvidenceVerifier(verifier: ((quote: string, sessionId?: string) => boolean) | undefined): void {
    if (verifier === undefined) delete this.evidenceVerifier
    else this.evidenceVerifier = verifier
  }

  /** Create the root layout. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const tmp = join(this.root, 'tmp')
    await fs.mkdir(tmp, { recursive: true, mode: 0o700 })
    // Crash leftovers: remove stale temporary files from the dedicated tmp dir.
    try {
      for (const entry of await fs.readdir(tmp)) {
        await fs.rm(join(tmp, entry), { recursive: true, force: true }).catch(() => {})
      }
    } catch {
      // A missing or unreadable tmp dir is not fatal.
    }
    if (this.config.enableUserScope) {
      await fs.mkdir(memoriesDir(this.root, { type: 'user' }), { recursive: true, mode: 0o700 })
    }
  }

  /** Ensure project metadata exists and is current. */
  async ensureProject(scope: MemoryScope, cwd: string): Promise<ProjectIdentity | undefined> {
    if (scope.type !== 'project') return undefined
    const identity = projectIdentity(cwd, this.config.projectScope)
    await fs.mkdir(memoriesDir(this.root, scope), { recursive: true, mode: 0o700 })
    const file = projectJsonFile(this.root, scope.key)
    let previous: Record<string, unknown> = {}
    try {
      previous = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    } catch {
      previous = {}
    }
    const metadata = {
      schemaVersion: 1,
      key: scope.key,
      label: identity.label,
      root: identity.root,
      remote: identity.remote ?? null,
      createdAt: typeof previous.createdAt === 'number' ? previous.createdAt : this.now(),
      lastSeenAt: this.now()
    }
    try {
      await withFileLock(
        file,
        () => writeFileAtomic(file, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
        { waitMs: this.lockWaitMs }
      )
    } catch (error) {
      this.warn(`project metadata write failed: ${String(error)}`)
    }
    return identity
  }

  /** Resolve the project scope for a working directory. */
  scopeForCwd(cwd: string): MemoryScope {
    return projectScopeFor(cwd, this.config.projectScope)
  }

  /**
   * Load (or rebuild) the index for one scope.
   *
   * `refresh` forces a full parse. `validate` forces a full stat check (used on
   * `agent/created` so external hand edits are noticed). Otherwise the in-memory
   * index is served directly, with a cheap `index.json` mtime probe every two
   * seconds to notice writes from another process.
   */
  async getScopeIndex(
    scope: MemoryScope,
    options: { refresh?: boolean; validate?: boolean } = {}
  ): Promise<ScopeIndex> {
    const key = scopeKey(scope)
    const cached = this.cache.get(key)
    const meta = this.meta.get(key)
    const now = Date.now()

    if (options.refresh !== true && options.validate !== true && cached !== undefined && meta !== undefined) {
      // One stat detects another process's committed index.json without
      // re-reading every memory file.
      const mtime = await this.indexJsonMtime(scope)
      if (mtime === meta.indexMtimeMs) {
        meta.checkedAt = now
        return cached
      }
    }

    const stats = await this.listMemoryFileStats(scope)
    const statSignature = computeStatSignature(stats)
    const indexMtime = await this.indexJsonMtime(scope)

    if (
      options.refresh !== true &&
      options.validate !== true &&
      cached !== undefined &&
      meta !== undefined &&
      meta.statSignature === statSignature
    ) {
      meta.checkedAt = now
      meta.indexMtimeMs = indexMtime
      return cached
    }

    const files = await this.readSourceFiles(scope, stats)
    const hash = computeSourceHash(files.map((file) => file.entry))
    if (options.refresh !== true && cached !== undefined && cached.sourceHash === hash) {
      this.meta.set(key, { statSignature, indexMtimeMs: indexMtime, checkedAt: now })
      return cached
    }

    this.version += 1
    if (options.refresh !== true) {
      const persisted = await this.loadPersistedIndex(scope, key, hash)
      if (persisted !== null) {
        persisted.version = this.version
        this.cache.set(key, persisted)
        this.meta.set(key, { statSignature, indexMtimeMs: indexMtime, checkedAt: now })
        return persisted
      }
    }

    const { records, malformed, repaired } = await this.parseSourceFiles(scope, files)
    let finalHash = hash
    let finalSignature = statSignature
    if (repaired) {
      const repairedStats = await this.listMemoryFileStats(scope)
      finalHash = computeSourceHash((await this.readSourceFiles(scope, repairedStats)).map((file) => file.entry))
      finalSignature = computeStatSignature(repairedStats)
    }
    const index = buildScopeIndex(records, key, finalHash, this.version, malformed)
    this.cache.set(key, index)
    await this.persistIndex(scope, index)
    this.meta.set(key, {
      statSignature: finalSignature,
      indexMtimeMs: await this.indexJsonMtime(scope),
      checkedAt: now
    })
    return index
  }

  /** Force a rebuild of one or all scopes. */
  async refresh(scope?: MemoryScope): Promise<{ scopes: Array<{ scope: string; docs: number }> }> {
    const scopes = scope !== undefined ? [scope] : this.allScopes()
    const out: Array<{ scope: string; docs: number }> = []
    for (const item of scopes) {
      const index = await this.getScopeIndex(item, { refresh: true })
      out.push({ scope: scopeKey(item), docs: index.docs.size })
    }
    await this.audit.append({
      ts: this.now(),
      event: 'refresh',
      actor: 'system',
      details: { scopes: out.length }
    })
    return { scopes: out }
  }

  /** Write or update one memory. */
  async write(
    input: MemoryWriteInput,
    options: { actor?: 'model' | 'user' | 'system' } = {}
  ): Promise<MemoryWriteResult> {
    this.validateScopeKind(input.scope, input.kind)
    if (input.scope.type === 'project' && input.scope.key.trim().length === 0) {
      throw new MemoryError('SCOPE_REQUIRED', 'project scope requires a project key')
    }
    const rawBody = input.body ?? ''
    if (Buffer.byteLength(rawBody, 'utf8') > this.config.maxBodyBytes) {
      throw new MemoryError('BODY_TOO_LARGE', `body exceeds ${this.config.maxBodyBytes} bytes`)
    }
    const title = singleLine(redactSecrets(input.title ?? '', this.redactOptions()), 80)
    const summary = singleLine(redactSecrets(input.summary ?? '', this.redactOptions()), 200)
    if (title.length === 0) throw new MemoryError('INVALID_ARGUMENT', 'title must not be empty')
    if (summary.length === 0) throw new MemoryError('INVALID_ARGUMENT', 'summary must not be empty')
    const body = sanitizeBody(rawBody, this.redactOptions())
    const tags = normalizeTags(input.tags)
    const tagsProvided = input.tags !== undefined
    const kind = input.kind
    if (!MEMORY_KINDS.includes(kind)) throw new MemoryError('INVALID_ARGUMENT', `invalid kind ${String(kind)}`)
    const importance = clampImportance(input.importance ?? DEFAULT_IMPORTANCE[kind])
    const importanceProvided = input.importance !== undefined
    const source = normalizeSource(input.source)
    const evidenceQuote =
      input.evidence !== undefined && input.evidence.trim().length > 0
        ? singleLine(redactSecrets(input.evidence, this.redactOptions()), 500)
        : undefined
    const sessionId = typeof input.source?.sessionId === 'string' ? input.source.sessionId : undefined
    const evidence =
      evidenceQuote !== undefined && this.verifyEvidence(evidenceQuote, sessionId)
        ? evidenceFor(evidenceQuote)
        : undefined

    const scope = input.scope
    await fs.mkdir(memoriesDir(this.root, scope), { recursive: true, mode: 0o700 })
    const existingId = input.id !== undefined ? bareId(input.id.trim()) : undefined
    if (existingId !== undefined && !isUlid(existingId)) {
      throw new MemoryError('NOT_FOUND', `invalid memory id "${input.id}"`)
    }

    const result = await this.withScopeLock(scope, async () => {
      const index = await this.getScopeIndex(scope)
      const existing =
        existingId !== undefined
          ? await this.readInScope(existingId, scope)
          : undefined
      if (existingId !== undefined && existing === undefined) {
        throw new MemoryError('NOT_FOUND', `memory ${displayId(existingId)} does not exist`)
      }

      const slug = this.resolveSlug(input.slug, existing, title)
      const duplicate = [...index.docs.values()].find(
        (doc) => doc.slug === slug && doc.id !== existing?.id
      )
      if (duplicate !== undefined) {
        throw new MemoryError('DUPLICATE_SLUG', `slug "${slug}" already exists`, { id: duplicate.id })
      }

      let record: MemoryRecord
      let operation: 'created' | 'updated'
      let conflicts: string[] = []

      if (existing === undefined) {
        const id = existingId ?? generateRecordId()
        if (this.findFile(scope, id) !== undefined) {
          throw new MemoryError('DUPLICATE_SLUG', `memory ${displayId(id)} already exists`, { id })
        }
        record = {
          schemaVersion: SCHEMA_VERSION,
          id,
          slug,
          kind,
          scope,
          title,
          summary,
          body,
          tags,
          source: source as MemoryRecord['source'],
          trust: 'candidate',
          importance,
          createdAt: this.now(),
          updatedAt: this.now(),
          useCount: 0,
          pinned: false,
          muted: false,
          revision: 1,
          evidence
        }
        if (kind === 'episode') {
          record.expiresAt = input.expiresAt ?? this.now() + EPISODE_TTL_MS
        } else if (typeof input.expiresAt === 'number') {
          record.expiresAt = input.expiresAt
        }
        conflicts = this.detectConflicts(index, record)
        if (conflicts.length > 0) record.conflictOf = conflicts
        operation = 'created'
      } else {
        const contentChanged =
          existing.kind !== kind ||
          existing.title !== title ||
          existing.summary !== summary ||
          existing.body !== body
        record = {
          ...existing,
          slug,
          kind,
          title,
          summary,
          body,
          tags: tagsProvided ? tags : existing.tags,
          importance: importanceProvided ? importance : existing.importance,
          source: Object.keys(source).length > 0 ? (source as MemoryRecord['source']) : existing.source,
          updatedAt: this.now(),
          revision: contentChanged ? existing.revision + 1 : existing.revision
        }
        if (Object.keys(source).length > 0) record.source = source as MemoryRecord['source']
        if (evidence !== undefined) record.evidence = evidence
        else if (contentChanged) delete record.evidence
        if (contentChanged && existing.trust === 'verified') {
          record.trust = 'candidate'
          delete record.verifiedBy
          delete record.verifiedAt
        }
        if (typeof input.expiresAt === 'number') record.expiresAt = input.expiresAt
        operation = 'updated'
      }

      const file = this.findFile(scope, record.id) ?? join(memoriesDir(this.root, scope), `${record.id}.md`)
      await writeFileAtomic(file, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
      this.invalidateScope(scope)
      // The file is the commit point. A failed index refresh is repaired later.
      try {
        const next = await this.getScopeIndex(scope, { refresh: true })
        await this.persistIndex(scope, next)
      } catch (error) {
        this.warn(`index refresh after write failed: ${String(error)}`)
      }
      return { record, operation, conflicts }
    })

    await this.audit.append({
      ts: this.now(),
      event: 'write',
      actor: options.actor ?? 'model',
      id: result.record.id,
      scope: scopeKey(scope),
      trust: result.record.trust,
      sessionId,
      bytes: Buffer.byteLength(serializeMemoryFile(result.record), 'utf8'),
      details: { operation: result.operation }
    })
    return { ...result, truncated: false }
  }

  /** Read a memory by id or slug, preferring the caller's scope. */
  async read(
    idOrSlug: string,
    options: { scope?: MemoryScope; projectScope?: MemoryScope; allProjects?: boolean } = {}
  ): Promise<LocatedMemory | undefined> {
    const scopes = this.scopesToSearch(options)
    for (const scope of scopes) {
      const located = await this.locateInScope(idOrSlug, scope)
      if (located !== undefined) {
        void this.touch(located.record.id, scope).catch((error: unknown) => {
          this.warn(`touch failed: ${String(error)}`)
        })
        return located
      }
    }
    return undefined
  }

  /** Locate without touching usage counters. */
  async locate(
    idOrSlug: string,
    options: { scope?: MemoryScope; projectScope?: MemoryScope; allProjects?: boolean } = {}
  ): Promise<LocatedMemory | undefined> {
    for (const scope of this.scopesToSearch(options)) {
      const located = await this.locateInScope(idOrSlug, scope)
      if (located !== undefined) return located
    }
    return undefined
  }

  /** Mute or permanently delete one memory. */
  async forget(id: string, mode: 'mute' | 'delete', scope?: MemoryScope): Promise<{ id: string; mode: string }> {
    const located = await this.requireLocated(id, scope)
    if (mode === 'delete') {
      await this.withScopeLock(located.scope, async () => {
        await fs.rm(located.file, { force: true })
        this.invalidateScope(located.scope)
      })
    } else {
      await this.mutate(located, (record) => {
        record.muted = true
        record.updatedAt = this.now()
      })
    }
    await this.audit.append({
      ts: this.now(),
      event: 'forget',
      actor: 'user',
      id: located.record.id,
      scope: scopeKey(located.scope),
      mode
    })
    return { id: located.record.id, mode }
  }

  /** Mark a memory verified. Only users call this. */
  async verify(id: string, scope?: MemoryScope): Promise<MemoryRecord> {
    const located = await this.requireLocated(id, scope)
    if (located.record.trust === 'superseded') {
      throw new MemoryError('INVALID_ARGUMENT', 'a superseded memory must be restored before verification')
    }
    const record = await this.mutate(located, (item) => {
      item.trust = 'verified'
      item.verifiedBy = 'user'
      item.verifiedAt = this.now()
    })
    await this.audit.append({
      ts: this.now(),
      event: 'verify',
      actor: 'user',
      id: record.id,
      scope: scopeKey(located.scope)
    })
    return record
  }

  /** Mark a memory disputed. Disputed memories leave the core layer. */
  async dispute(id: string, scope?: MemoryScope): Promise<MemoryRecord> {
    const located = await this.requireLocated(id, scope)
    const record = await this.mutate(located, (item) => {
      item.trust = 'disputed'
    })
    await this.audit.append({
      ts: this.now(),
      event: 'dispute',
      actor: 'user',
      id: record.id,
      scope: scopeKey(located.scope)
    })
    return record
  }

  /** Restore a disputed/superseded/muted memory to candidate. */
  async restore(id: string, scope?: MemoryScope): Promise<MemoryRecord> {
    const located = await this.requireLocated(id, scope)
    const record = await this.mutate(located, (item) => {
      item.trust = 'candidate'
      item.muted = false
      delete item.verifiedBy
      delete item.verifiedAt
      item.updatedAt = this.now()
    })
    await this.audit.append({
      ts: this.now(),
      event: 'restore',
      actor: 'user',
      id: record.id,
      scope: scopeKey(located.scope)
    })
    return record
  }

  /** Pin or unpin a memory (user operation). */
  async setPinned(id: string, pinned: boolean, scope?: MemoryScope): Promise<MemoryRecord> {
    const located = await this.requireLocated(id, scope)
    const record = await this.mutate(located, (item) => {
      item.pinned = pinned
    })
    await this.audit.append({
      ts: this.now(),
      event: 'pin',
      actor: 'user',
      id: record.id,
      scope: scopeKey(located.scope),
      details: { pinned }
    })
    return record
  }

  /** Mark `oldId` superseded by `newId`; both sides are written. */
  async supersede(oldId: string, newId: string, scope?: MemoryScope): Promise<void> {
    const oldLocated = await this.requireLocated(oldId, scope)
    const newLocated = await this.requireLocated(newId, scope ?? oldLocated.scope)
    if (scopeKey(oldLocated.scope) !== scopeKey(newLocated.scope)) {
      throw new MemoryError('SCOPE_FORBIDDEN', 'supersede requires both memories in the same scope')
    }
    if (oldLocated.record.id === newLocated.record.id) {
      throw new MemoryError('INVALID_ARGUMENT', 'a memory cannot supersede itself')
    }
    await this.withScopeLock(oldLocated.scope, async () => {
      const oldRecord = await this.readInScope(oldLocated.record.id, oldLocated.scope)
      const newRecord = await this.readInScope(newLocated.record.id, newLocated.scope)
      if (oldRecord === undefined || newRecord === undefined) {
        throw new MemoryError('NOT_FOUND', 'memory disappeared during supersede')
      }
      oldRecord.trust = 'superseded'
      oldRecord.supersededBy = newRecord.id
      oldRecord.updatedAt = this.now()
      newRecord.supersedes = oldRecord.id
      newRecord.updatedAt = this.now()
      await writeFileAtomic(oldLocated.file, serializeMemoryFile(oldRecord), { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(newLocated.file, serializeMemoryFile(newRecord), { mode: 0o600, dirMode: 0o700 })
      this.invalidateScope(oldLocated.scope)
    })
    await this.audit.append({
      ts: this.now(),
      event: 'supersede',
      actor: 'user',
      id: newLocated.record.id,
      scope: scopeKey(oldLocated.scope),
      details: { oldId: oldLocated.record.id }
    })
  }

  /** Update usage counters (best effort, never bumps `updatedAt`). */
  async touch(id: string, scope?: MemoryScope): Promise<void> {
    const located = await this.requireLocated(id, scope)
    await this.withScopeLock(located.scope, async () => {
      const record = await this.readInScope(located.record.id, located.scope)
      if (record === undefined) return
      record.lastUsedAt = this.now()
      record.useCount += 1
      await writeFileAtomic(located.file, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
      // Usage counters are not content: patch the cached index instead of
      // forcing a full reparse on the next search.
      const cached = this.cache.get(scopeKey(located.scope))
      if (cached !== undefined) {
        const doc = cached.docs.get(record.id)
        if (doc !== undefined) {
          doc.lastUsedAt = record.lastUsedAt
          doc.useCount = record.useCount
        }
        const cachedRecord = cached.records.find((item) => item.id === record.id)
        if (cachedRecord !== undefined) {
          cachedRecord.lastUsedAt = record.lastUsedAt
          cachedRecord.useCount = record.useCount
        }
      }
    })
  }

  /** Rank memories for a query. */
  async search(options: MemorySearchOptions): Promise<MemorySearchHit[]> {
    if (options.query.trim().length === 0) return []
    const scopes = this.searchScopes(options)
    if (scopes.length === 0) return []
    const currentProjectKey = options.projectScope?.type === 'project' ? options.projectScope.key : undefined
    const indexes = await Promise.all(scopes.map((scope) => this.getScopeIndex(scope)))
    const now = this.now()
    const entries: Array<{ doc: IndexedDoc; scopeKey: string; scope: MemoryScope }> = []
    const byId = new Map<string, number>()
    let totalLength = 0
    for (const index of indexes) {
      const scopeValue = parseScopeKey(index.scopeKey)
      for (const doc of index.docs.values()) {
        if (!this.isDocSearchable(doc, options, now)) continue
        byId.set(doc.id, entries.length)
        entries.push({ doc, scopeKey: index.scopeKey, scope: scopeValue })
        totalLength += doc.length
      }
    }
    const docCount = entries.length
    if (docCount === 0) return []
    const avgdl = totalLength / docCount
    const terms = [...new Set(tokenize(options.query))]
    if (terms.length === 0) return []

    // Score only documents that contain a query term; postings are queried
    // directly instead of merging the whole inverted index on every search.
    const scores = new Float64Array(docCount)
    for (const term of terms) {
      const matches: number[] = []
      let df = 0
      for (const index of indexes) {
        const posting = index.postings.get(term)
        if (posting === undefined) continue
        for (const [id, tf] of posting) {
          const ordinal = byId.get(id)
          if (ordinal === undefined) continue
          matches.push(ordinal, tf)
          df += 1
        }
      }
      if (df === 0) continue
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
      for (let i = 0; i < matches.length; i += 2) {
        const ordinal = matches[i]!
        const tf = matches[i + 1]!
        const doc = entries[ordinal]!.doc
        const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl))
        scores[ordinal] = scores[ordinal]! + idf * ((tf * (BM25_K1 + 1)) / (denom === 0 ? 1 : denom))
      }
    }

    let maxBm25 = 0
    for (const score of scores) if (score > maxBm25) maxBm25 = score
    const TOP = 40
    const top: Array<{
      doc: IndexedDoc
      scopeKey: string
      bm25: number
      score: number
    }> = []
    const better = (
      score: number,
      doc: IndexedDoc,
      other: { score: number; doc: IndexedDoc }
    ): boolean =>
      score > other.score ||
      (score === other.score &&
        (doc.updatedAt > other.doc.updatedAt ||
          (doc.updatedAt === other.doc.updatedAt && doc.id < other.doc.id)))
    for (let ordinal = 0; ordinal < docCount; ordinal += 1) {
      const raw = scores[ordinal]!
      if (raw <= 0) continue
      const entry = entries[ordinal]!
      const score = scoreDoc(entry.doc, entry.scope, {
        bm25Norm: maxBm25 > 0 ? raw / maxBm25 : 0,
        now,
        halfLifeDays: this.config.decayHalfLifeDays,
        currentProjectKey
      })
      if (top.length === TOP && !better(score, entry.doc, top[TOP - 1]!)) continue
      let low = 0
      let high = top.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (better(score, entry.doc, top[middle]!)) high = middle
        else low = middle + 1
      }
      top.splice(low, 0, { doc: entry.doc, scopeKey: entry.scopeKey, bm25: raw, score })
      if (top.length > TOP) top.pop()
    }
    // Deduplicate and diversify only the head of the ranking; this keeps the
    // near-duplicate check bounded even when a scope holds tens of thousands of
    // memories.
    const pool: ScoredMemory[] = top.map((item) => ({
      record: partialRecord(item.doc, item.scopeKey),
      bm25: item.bm25,
      score: item.score
    }))
    const deduped = dedupeCandidates(pool)
    const limit = Math.min(Math.max(1, options.limit ?? this.config.maxSearchResults), 20)
    const selected = mmrSelect(deduped.slice(0, 20), limit)
    const hits: MemorySearchHit[] = selected.map((item) => ({
      id: item.record.id,
      slug: item.record.slug,
      kind: item.record.kind,
      title: item.record.title,
      summary: item.record.summary,
      trust: item.record.trust,
      score: Number(item.score.toFixed(6)),
      scope: item.record.scope,
      updatedAt: item.record.updatedAt,
      pinned: item.record.pinned
    }))
    void this.audit.append({
      ts: this.now(),
      event: 'search',
      actor: options.actor ?? 'model',
      sessionId: options.sessionId,
      queryHash: sha256(options.query),
      resultIds: hits.map((hit) => hit.id)
    })
    return hits
  }

  /** List summaries for debugging/panel views. */
  async list(options: MemoryListOptions): Promise<Array<IndexedDoc & { scope: string }>> {
    const scopes = this.searchScopes({
      query: '',
      scope: options.scope,
      projectScope: options.projectScope
    })
    const docs: Array<IndexedDoc & { scope: string }> = []
    for (const scope of scopes) {
      const index = await this.getScopeIndex(scope)
      for (const doc of index.docs.values()) {
        if (options.kind !== undefined && doc.kind !== options.kind) continue
        if (options.includeAll !== true) {
          if (doc.muted || doc.trust === 'disputed' || doc.trust === 'superseded') continue
        }
        docs.push({ ...doc, scope: index.scopeKey })
      }
    }
    docs.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id)
    )
    const limit = Math.min(Math.max(1, options.limit ?? 20), 50)
    return docs.slice(0, limit)
  }

  /** Everything the review queue needs for one project. */
  async review(projectScope?: MemoryScope): Promise<{
    candidates: IndexedDoc[]
    conflicts: IndexedDoc[]
    stale: IndexedDoc[]
    expired: IndexedDoc[]
  }> {
    const scopes = this.scopesToSearch({ projectScope, allProjects: projectScope === undefined })
    const now = this.now()
    const candidates: IndexedDoc[] = []
    const conflicts: IndexedDoc[] = []
    const stale: IndexedDoc[] = []
    const expired: IndexedDoc[] = []
    for (const scope of scopes) {
      const index = await this.getScopeIndex(scope)
      for (const doc of index.docs.values()) {
        if (doc.trust === 'candidate' && !doc.muted) {
          candidates.push(doc)
          if (now - doc.updatedAt > 30 * 24 * 60 * 60 * 1000) stale.push(doc)
        }
        if ((doc.conflictOf?.length ?? 0) > 0) conflicts.push(doc)
        if (doc.expiresAt !== undefined && doc.expiresAt < now) expired.push(doc)
      }
    }
    return { candidates, conflicts, stale, expired }
  }

  /** Aggregated counts for the panel. */
  async stats(projectScope?: MemoryScope): Promise<{
    scopes: Array<{
      scope: string
      docs: number
      byKind: Record<string, number>
      byTrust: Record<string, number>
      bytes: number
    }>
    audit: { total: number; byEvent: Record<string, number> }
  }> {
    const scopes = this.scopesToSearch({ projectScope, allProjects: projectScope === undefined })
    const out: Array<{
      scope: string
      docs: number
      byKind: Record<string, number>
      byTrust: Record<string, number>
      bytes: number
    }> = []
    for (const scope of scopes) {
      const index = await this.getScopeIndex(scope)
      const byKind: Record<string, number> = {}
      const byTrust: Record<string, number> = {}
      let bytes = 0
      for (const doc of index.docs.values()) {
        byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1
        byTrust[doc.trust] = (byTrust[doc.trust] ?? 0) + 1
        bytes += Buffer.byteLength(doc.summary, 'utf8')
      }
      out.push({ scope: index.scopeKey, docs: index.docs.size, byKind, byTrust, bytes })
    }
    const events = await this.audit.read()
    const byEvent: Record<string, number> = {}
    for (const event of events) byEvent[event.event] = (byEvent[event.event] ?? 0) + 1
    return { scopes: out, audit: { total: events.length, byEvent } }
  }

  /** Read all records of a scope from disk (full bodies). */
  async recordsOf(scope: MemoryScope): Promise<{ records: MemoryRecord[]; malformed: MalformedFile[] }> {
    const { records, malformed } = await this.parseSourceFiles(scope, await this.readSourceFiles(scope))
    return { records, malformed }
  }

  /** All records for the core layer: user plus the current project. */
  async coreRecords(projectScope?: MemoryScope, options: { validate?: boolean } = {}): Promise<MemoryRecord[]> {
    const scopes = this.scopesToSearch({ projectScope })
    const out: MemoryRecord[] = []
    for (const scope of scopes) {
      const index = await this.getScopeIndex(scope, { validate: options.validate === true })
      out.push(...index.records)
    }
    return out
  }

  /** Import records into a scope, always as candidates. */
  async importRecords(
    scope: MemoryScope,
    incoming: readonly Partial<MemoryRecord>[],
    options: { skipExistingSlug?: boolean } = {}
  ): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = []
    const skipped: string[] = []
    const existing = await this.getScopeIndex(scope, { refresh: true })
    const slugs = new Set([...existing.docs.values()].map((doc) => doc.slug))
    const ids = new Set(existing.docs.keys())
    for (const item of incoming) {
      if (typeof item.title !== 'string' || typeof item.summary !== 'string') {
        skipped.push(item.id ?? item.slug ?? 'unknown')
        continue
      }
      let slug: string
      try {
        slug = normalizeSlug(item.slug ?? item.title)
      } catch {
        skipped.push(item.id ?? item.slug ?? 'unknown')
        continue
      }
      if (options.skipExistingSlug !== false && slugs.has(slug)) {
        skipped.push(slug)
        continue
      }
      const requestedId = typeof item.id === 'string' ? bareId(item.id) : undefined
      const id =
        requestedId !== undefined && isUlid(requestedId) && !ids.has(requestedId) ? requestedId : undefined
      try {
        const result = await this.write({
          id,
          slug,
          kind: isKind(item.kind) ? item.kind : 'fact',
          title: item.title,
          summary: item.summary,
          body: item.body ?? '',
          tags: item.tags,
          importance: item.importance,
          scope,
          source: item.source,
          evidence: item.evidence?.quote
        })
        imported.push(result.record.id)
        slugs.add(slug)
        ids.add(result.record.id)
      } catch (error) {
        this.warn(`import skipped ${slug}: ${String(error)}`)
        skipped.push(slug)
      }
    }
    await this.audit.append({
      ts: this.now(),
      event: 'import',
      actor: 'user',
      scope: scopeKey(scope),
      details: { imported: imported.length, skipped: skipped.length }
    })
    return { imported, skipped }
  }

  /** Export one scope as markdown files, an AGENTS.md fragment, or JSON. */
  async exportScope(
    scope: MemoryScope,
    format: 'md' | 'agents' | 'json'
  ): Promise<{ format: string; files?: Array<{ name: string; content: string }>; content?: string }> {
    const { records, malformed } = await this.recordsOf(scope)
    if (malformed.length > 0) this.warn(`${malformed.length} malformed memories skipped during export`)
    if (format === 'md') {
      return {
        format,
        files: records.map((record) => ({ name: `${record.id}.md`, content: serializeMemoryFile(record) }))
      }
    }
    if (format === 'json') {
      return {
        format,
        content: JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date(this.now()).toISOString(),
            scope: scopeKey(scope),
            memories: records
          },
          null,
          2
        )
      }
    }
    const relevant = records
      .filter(
        (record) =>
          record.trust === 'verified' &&
          !record.muted &&
          (record.kind === 'preference' || record.kind === 'constraint' || record.kind === 'decision')
      )
      .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))
    const lines = ['# Project conventions', '']
    for (const record of relevant) {
      lines.push(`- **${record.title}** — ${record.summary} (${displayId(record.id)})`)
    }
    lines.push('')
    return { format, content: lines.join('\n') }
  }

  /** Run consistency checks without modifying anything. */
  async doctor(projectScope?: MemoryScope): Promise<{ findings: DoctorFinding[]; checked: number }> {
    const scopes = this.scopesToSearch({ projectScope, allProjects: projectScope === undefined })
    const findings: DoctorFinding[] = []
    let checked = 0
    const now = this.now()
    for (const scope of scopes) {
      const key = scopeKey(scope)
      const files = await this.readSourceFiles(scope)
      const hash = computeSourceHash(files.map((file) => file.entry))
      const { records, malformed } = await this.parseSourceFiles(scope, files, { repair: false })
      checked += records.length
      for (const bad of malformed) {
        findings.push({ level: 'error', code: 'MALFORMED_MEMORY', scope: key, message: `${bad.file}: ${bad.message}` })
      }
      const slugCounts = new Map<string, string[]>()
      for (const record of records) {
        const list = slugCounts.get(record.slug) ?? []
        list.push(record.id)
        slugCounts.set(record.slug, list)
      }
      for (const [slug, ids] of slugCounts) {
        if (ids.length > 1) {
          findings.push({
            level: 'error',
            code: 'DUPLICATE_SLUG',
            scope: key,
            message: `slug "${slug}" is used by ${ids.map(displayId).join(', ')}`
          })
        }
      }
      const ids = new Set(records.map((record) => record.id))
      for (const record of records) {
        if (record.supersededBy !== undefined && !ids.has(record.supersededBy)) {
          findings.push({
            level: 'warn',
            code: 'BROKEN_SUPERSEDE_LINK',
            scope: key,
            id: record.id,
            message: `supersededBy ${displayId(record.supersededBy)} is missing`
          })
        }
        if (record.supersedes !== undefined && !ids.has(record.supersedes)) {
          findings.push({
            level: 'warn',
            code: 'BROKEN_SUPERSEDE_LINK',
            scope: key,
            id: record.id,
            message: `supersedes ${displayId(record.supersedes)} is missing`
          })
        }
        if (record.trust === 'candidate' && now - record.updatedAt > 90 * 24 * 60 * 60 * 1000) {
          findings.push({
            level: 'info',
            code: 'STALE_CANDIDATE',
            scope: key,
            id: record.id,
            message: `candidate unverified for ${Math.round((now - record.updatedAt) / 86_400_000)} days`
          })
        }
        if ((record.conflictOf?.length ?? 0) > 0) {
          findings.push({
            level: 'warn',
            code: 'UNRESOLVED_CONFLICT',
            scope: key,
            id: record.id,
            message: `conflicts with ${record.conflictOf!.map(displayId).join(', ')}`
          })
        }
        if (record.expiresAt !== undefined && record.expiresAt < now) {
          findings.push({ level: 'info', code: 'EXPIRED', scope: key, id: record.id, message: 'expired; excluded from core and search' })
        }
      }
      const persisted = await this.readPersistedRaw(scope)
      if (persisted !== null && persisted.sourceHash !== undefined && persisted.sourceHash !== hash) {
        findings.push({
          level: 'warn',
          code: 'INDEX_OUT_OF_DATE',
          scope: key,
          message: 'index.json sourceHash does not match memory files; it will be rebuilt on next load'
        })
      }
    }
    return { findings, checked }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private redactOptions(): { redactPhoneAndId: boolean } {
    return { redactPhoneAndId: this.config.redactPhoneAndId }
  }

  private validateScopeKind(scope: MemoryScope, kind: MemoryKind): void {
    if (!MEMORY_KINDS.includes(kind)) throw new MemoryError('INVALID_ARGUMENT', `invalid kind ${String(kind)}`)
    if (scope.type === 'user') {
      if (!this.config.enableUserScope) {
        throw new MemoryError('SCOPE_FORBIDDEN', 'user scope is disabled')
      }
      if (!USER_SCOPE_KINDS.includes(kind)) {
        throw new MemoryError('SCOPE_FORBIDDEN', `kind "${kind}" must use project scope`)
      }
    }
  }

  private verifyEvidence(quote: string, sessionId?: string): boolean {
    if (this.evidenceVerifier === undefined) return true
    try {
      return this.evidenceVerifier(quote, sessionId)
    } catch {
      return false
    }
  }

  private resolveSlug(slug: string | undefined, existing: MemoryRecord | undefined, title: string): string {
    if (slug !== undefined && slug.trim().length > 0) {
      try {
        return normalizeSlug(slug)
      } catch (error) {
        throw new MemoryError('INVALID_SLUG', (error as Error).message)
      }
    }
    if (existing !== undefined) return existing.slug
    try {
      return normalizeSlug(title)
    } catch {
      return `memory-${generateRecordId().slice(-8).toLowerCase()}`
    }
  }

  private detectConflicts(index: ScopeIndex, record: MemoryRecord): string[] {
    const out: string[] = []
    for (const doc of index.docs.values()) {
      if (doc.id === record.id) continue
      if (doc.kind !== record.kind) continue
      if (summariesConflict(doc.summary, record.summary)) out.push(doc.id)
    }
    return out
  }

  private findFile(scope: MemoryScope, id: string): string | undefined {
    const file = join(memoriesDir(this.root, scope), `${id}.md`)
    return isRegularFile(file) ? file : undefined
  }

  private async readInScope(id: string, scope: MemoryScope): Promise<MemoryRecord | undefined> {
    const file = this.findFile(scope, id)
    if (file === undefined) return undefined
    try {
      const text = await fs.readFile(file, 'utf8')
      return parseMemoryFile(text, scope, this.now()).record
    } catch (error) {
      this.warn(`failed to read ${file}: ${String(error)}`)
      return undefined
    }
  }

  private async locateInScope(idOrSlug: string, scope: MemoryScope): Promise<LocatedMemory | undefined> {
    const raw = idOrSlug.trim()
    if (raw.length === 0) return undefined
    const candidateId = bareId(raw)
    let id: string | undefined
    if (isUlid(candidateId)) {
      id = candidateId
    } else {
      const index = await this.getScopeIndex(scope)
      const docs = [...index.docs.values()].filter((doc) => doc.slug === raw)
      if (docs.length > 1) {
        this.warn(`slug "${raw}" is ambiguous in ${scopeKey(scope)}`)
      }
      id = docs[0]?.id
    }
    if (id === undefined) return undefined
    let file = this.findFile(scope, id)
    if (file === undefined && isUlid(candidateId)) {
      // The index may be newer than a hand-renamed file.
      const index = await this.getScopeIndex(scope)
      const doc = index.docs.get(id)
      if (doc !== undefined) file = join(memoriesDir(this.root, scope), `${doc.id}.md`)
    }
    if (file === undefined || !isRegularFile(file)) return undefined
    try {
      const text = await fs.readFile(file, 'utf8')
      const parsed = parseMemoryFile(text, scope, this.now())
      return { record: parsed.record, scope, file }
    } catch (error) {
      this.warn(`skipping malformed memory ${file}: ${String(error)}`)
      return undefined
    }
  }

  private async requireLocated(id: string, scope?: MemoryScope): Promise<LocatedMemory> {
    const located = await this.locate(id, { scope, allProjects: scope === undefined })
    if (located === undefined) throw new MemoryError('NOT_FOUND', `memory "${id}" does not exist`)
    return located
  }

  private async mutate(located: LocatedMemory, change: (record: MemoryRecord) => void): Promise<MemoryRecord> {
    return this.withScopeLock(located.scope, async () => {
      const record = await this.readInScope(located.record.id, located.scope)
      if (record === undefined) throw new MemoryError('NOT_FOUND', 'memory disappeared during update')
      change(record)
      const file = this.findFile(located.scope, record.id) ?? located.file
      await writeFileAtomic(file, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
      this.invalidateScope(located.scope)
      try {
        const next = await this.getScopeIndex(located.scope, { refresh: true })
        await this.persistIndex(located.scope, next)
      } catch (error) {
        this.warn(`index refresh after update failed: ${String(error)}`)
      }
      return record
    })
  }

  private isDocSearchable(doc: IndexedDoc, options: MemorySearchOptions, now: number): boolean {
    if (doc.muted) return false
    if (doc.expiresAt !== undefined && doc.expiresAt < now) return false
    if (doc.trust === 'superseded') return false
    if (doc.trust === 'disputed' && options.includeDisputed !== true) return false
    if (options.kinds !== undefined && options.kinds.length > 0 && !options.kinds.includes(doc.kind)) return false
    return true
  }

  private searchScopes(options: MemorySearchOptions): MemoryScope[] {
    const out: MemoryScope[] = []
    const wantUser = options.scope === 'user' || options.scope === 'all'
    const wantProjects = options.scope === 'project' || options.scope === 'all'
    if (wantUser && this.config.enableUserScope) out.push({ type: 'user' })
    if (wantProjects) {
      if (options.projectScope?.type === 'project') {
        out.push(options.projectScope)
        if (options.scope === 'all') {
          for (const key of listProjectKeys(this.root)) {
            if (key !== options.projectScope.key) out.push({ type: 'project', key })
          }
        }
      } else if (options.scope === 'project') {
        throw new MemoryError('SCOPE_REQUIRED', 'project search requires a working directory')
      }
    }
    return out
  }

  private scopesToSearch(options: {
    scope?: MemoryScope
    projectScope?: MemoryScope
    allProjects?: boolean
  }): MemoryScope[] {
    if (options.scope !== undefined) return [options.scope]
    const out: MemoryScope[] = []
    if (this.config.enableUserScope) out.push({ type: 'user' })
    if (options.projectScope?.type === 'project') out.push(options.projectScope)
    if (options.allProjects === true) {
      const keys = listProjectKeys(this.root)
      for (const key of keys) {
        if (!out.some((scope) => scope.type === 'project' && scope.key === key)) {
          out.push({ type: 'project', key })
        }
      }
    }
    return out
  }

  private allScopes(): MemoryScope[] {
    const out: MemoryScope[] = []
    if (this.config.enableUserScope) out.push({ type: 'user' })
    for (const key of listProjectKeys(this.root)) out.push({ type: 'project', key })
    return out
  }

  private async indexJsonMtime(scope: MemoryScope): Promise<number> {
    try {
      const stat = await fs.stat(join(scopeDir(this.root, scope), 'index.json'))
      return stat.mtimeMs
    } catch {
      return 0
    }
  }

  private async listMemoryFileStats(scope: MemoryScope): Promise<FileStat[]> {    const dir = memoriesDir(this.root, scope)
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: FileStat[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const file = join(dir, entry.name)
      try {
        const stat = await fs.stat(file)
        out.push({ file, filenameId: entry.name.slice(0, -3), size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        continue
      }
    }
    out.sort((a, b) => a.file.localeCompare(b.file))
    return out
  }

  private async readSourceFiles(scope: MemoryScope, stats?: readonly FileStat[]): Promise<SourceFile[]> {
    const list = stats ?? (await this.listMemoryFileStats(scope))
    const out: SourceFile[] = []
    for (const item of list) {
      let text: string
      try {
        text = await fs.readFile(item.file, 'utf8')
      } catch {
        continue
      }
      out.push({
        file: item.file,
        filenameId: item.filenameId,
        text,
        entry: {
          id: item.filenameId,
          size: item.size,
          mtimeMs: item.mtimeMs,
          contentHash: contentHashOf(text)
        }
      })
    }
    out.sort((a, b) => a.file.localeCompare(b.file))
    return out
  }

  private invalidateScope(scope: MemoryScope): void {
    const key = scopeKey(scope)
    this.cache.delete(key)
    this.meta.delete(key)
  }

  private async parseSourceFiles(
    scope: MemoryScope,
    files: readonly SourceFile[],
    options: { repair?: boolean } = {}
  ): Promise<{ records: MemoryRecord[]; malformed: MalformedFile[]; repaired: boolean }> {
    const records: MemoryRecord[] = []
    const malformed: MalformedFile[] = []
    let repaired = false
    const repair = options.repair !== false
    for (const source of files) {
      let parsed: ParsedMemoryFile
      try {
        parsed = parseMemoryFile(source.text, scope, this.now())
      } catch (error) {
        malformed.push({ file: source.file, id: source.filenameId, message: (error as Error).message })
        continue
      }
      let record = parsed.record
      if (parsed.generatedId && isUlid(source.filenameId)) {
        // A hand-written file may omit the id; the ULID filename is the identity.
        record.id = source.filenameId
        parsed.needsWrite = true
      }
      if (!parsed.generatedId && record.id !== source.filenameId) {
        const target = join(memoriesDir(this.root, scope), `${record.id}.md`)
        if (isUlid(record.id) && this.findFile(scope, record.id) === undefined) {
          if (repair) {
            try {
              await writeFileAtomic(target, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
              await fs.rm(source.file, { force: true })
              repaired = true
            } catch (error) {
              this.warn(`could not repair filename for ${record.id}: ${String(error)}`)
            }
          }
        } else {
          this.warn(`memory ${displayId(record.id)} is stored as ${basename(source.file)}; frontmatter id wins`)
        }
      } else if (parsed.needsWrite && repair) {
        try {
          await writeFileAtomic(source.file, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
          repaired = true
        } catch (error) {
          this.warn(`could not repair ${source.file}: ${String(error)}`)
        }
      }
      records.push(record)
    }
    return { records, malformed, repaired }
  }

  private async loadPersistedIndex(
    scope: MemoryScope,
    key: string,
    hash: string
  ): Promise<ScopeIndex | null> {
    const file = join(scopeDir(this.root, scope), 'index.json')
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
    const index = parseScopeIndexJson(text, key, scope, this.version)
    if (index === null || index.sourceHash !== hash) return null
    return index
  }

  private async readPersistedRaw(
    scope: MemoryScope
  ): Promise<{ sourceHash?: string } | null> {
    try {
      const text = await fs.readFile(join(scopeDir(this.root, scope), 'index.json'), 'utf8')
      const data = JSON.parse(text) as { sourceHash?: unknown }
      return { sourceHash: typeof data.sourceHash === 'string' ? data.sourceHash : undefined }
    } catch {
      return null
    }
  }

  private async persistIndex(scope: MemoryScope, index: ScopeIndex): Promise<void> {
    const dir = scopeDir(this.root, scope)
    const json = `${JSON.stringify(serializeScopeIndex(index), null, 2)}\n`
    try {
      await writeFileAtomic(join(dir, 'index.json'), json, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      this.warn(`index.json write failed: ${String(error)}`)
    }
    try {
      const markdown = renderIndexMarkdown(index.scopeKey, [...index.docs.values()], index.builtAt)
      await writeFileAtomic(join(dir, 'index.md'), markdown, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      this.warn(`index.md write failed: ${String(error)}`)
    }
  }

  private async withScopeLock<T>(scope: MemoryScope, operation: () => Promise<T>): Promise<T> {
    const dir = scopeDir(this.root, scope)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const target = join(dir, 'index')
    try {
      return await withFileLock(target, operation, { waitMs: this.lockWaitMs })
    } catch (error) {
      if (!isLockTimeout(error)) throw error
      const recovered = await recoverOrphanLock(`${target}.lock`)
      if (!recovered) {
        throw new MemoryError('LOCK_TIMEOUT', `timed out waiting for the writer lock in ${scopeKey(scope)}`)
      }
      try {
        return await withFileLock(target, operation, { waitMs: this.lockWaitMs })
      } catch (retryError) {
        if (isLockTimeout(retryError)) {
          throw new MemoryError('LOCK_TIMEOUT', `timed out waiting for the writer lock in ${scopeKey(scope)}`)
        }
        throw retryError
      }
    }
  }
}

// ---------------------------------------------------------------------------

function generateRecordId(): string {
  return generateUlid()
}

function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function computeStatSignature(stats: readonly FileStat[]): string {
  return createHash('sha256')
    .update(stats.map((item) => `${item.filenameId}\u0000${item.size}\u0000${Math.trunc(item.mtimeMs)}`).join('\n'))
    .digest('hex')
}

function clampImportance(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)))
}

function isKind(value: unknown): value is MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind)
}

function partialRecord(doc: IndexedDoc, key: string): MemoryRecord {
  const scope: MemoryScope = key === 'user' ? { type: 'user' } : { type: 'project', key: key.slice('project:'.length) }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: doc.id,
    slug: doc.slug,
    kind: doc.kind,
    scope,
    title: doc.title,
    summary: doc.summary,
    body: '',
    tags: doc.tags ?? [],
    source: {},
    trust: doc.trust as TrustState,
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

function isLockTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out waiting for the writer lock/.test(error.message)
}

async function recoverOrphanLock(lockPath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch {
    return true
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return false
    if (code !== 'ESRCH') return false
  }
  try {
    await fs.rm(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}
