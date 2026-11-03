/**
 * 每条记忆唯一的写入入口。
 *
 * 所有变更路径（工具、侧边栏 API、导入、自动捕获）都经过这个类。文件在按作用域的跨进程
 * 锁保护下原子写入；`index.json` 只是尽力维护的派生物，过期时会从 Markdown 重建。
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
  type MemoryMergeInput,
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
  toIndexedDoc,
  type IndexedDoc,
  type MalformedFile,
  type ScopeIndex,
  type SourceFileEntry
} from './index.ts'
import { SqliteIndex, type SqliteFileStat } from './sqlite.ts'
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
import { BM25_B, BM25_K1, indexRecord } from '../retrieval/bm25.ts'
import { tokenize } from '../retrieval/tokenize.ts'
import {
  dedupeCandidates,
  mmrSelect,
  scoreDoc,
  type ScoredMemory
} from '../retrieval/score.ts'

/** 构造 store 的选项。 */
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

/** 记忆唯一的写入 API。 */
export class MemoryStore {
  readonly root: string
  readonly config: MemoryConfig
  readonly audit: MemoryAudit
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly lockWaitMs: number
  private readonly cache = new Map<string, ScopeIndex>()
  private readonly meta = new Map<string, { statSignature: string; indexMtimeMs: number; checkedAt: number }>()
  private readonly sqliteIndexes = new Map<string, SqliteIndex>()
  private sqliteFallbackUntil = 0
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

  /** 安装一个基于 transcript 的 evidence 校验器（自动捕获会用到）。 */
  setEvidenceVerifier(verifier: ((quote: string, sessionId?: string) => boolean) | undefined): void {
    if (verifier === undefined) delete this.evidenceVerifier
    else this.evidenceVerifier = verifier
  }

  /** 创建根目录结构。 */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const tmp = join(this.root, 'tmp')
    await fs.mkdir(tmp, { recursive: true, mode: 0o700 })
    // 崩溃残留：清掉专用 tmp 目录里过期的临时文件。
    try {
      for (const entry of await fs.readdir(tmp)) {
        await fs.rm(join(tmp, entry), { recursive: true, force: true }).catch(() => {})
      }
    } catch {
      // tmp 目录缺失或不可读并不致命。
    }
    if (this.config.enableUserScope) {
      await fs.mkdir(memoriesDir(this.root, { type: 'user' }), { recursive: true, mode: 0o700 })
    }
  }

  /** 确保项目元数据存在且是最新的。 */
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

  /** 解析某个工作目录对应的项目作用域。 */
  scopeForCwd(cwd: string): MemoryScope {
    return projectScopeFor(cwd, this.config.projectScope)
  }

  /**
   * 加载（或重建）某个作用域的索引。
   *
   * `refresh` 强制完整解析。`validate` 强制做一次完整的 stat 检查（在 `agent/created`
   * 时使用，以便发现外部手工编辑）。否则直接使用内存中的索引，每次访问时对
   * `index.json` 做一次廉价的 mtime 探测，以察觉另一个进程的写入。
   */
  async getScopeIndex(
    scope: MemoryScope,
    options: { refresh?: boolean; validate?: boolean } = {}
  ): Promise<ScopeIndex> {
    if (this.useSqlite()) {
      try {
        return await this.getSqliteScopeIndex(scope, options)
      } catch (error) {
        this.sqliteFallbackUntil = Date.now() + 30_000
        this.warn(`sqlite 索引暂不可用，30 秒内回退 JSON: ${String(error)}`)
      }
    }
    const key = scopeKey(scope)
    const cached = this.cache.get(key)
    const meta = this.meta.get(key)
    const now = Date.now()

    if (options.refresh !== true && options.validate !== true && cached !== undefined && meta !== undefined) {
      // 一次 stat 就能发现另一个进程已提交的 index.json，
      // 无需重新读取每个记忆文件。
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
    let fileEntries = new Map(files.map((file) => [file.filenameId, file.entry]))
    if (repaired) {
      const repairedStats = await this.listMemoryFileStats(scope)
      const repairedFiles = await this.readSourceFiles(scope, repairedStats)
      finalHash = computeSourceHash(repairedFiles.map((file) => file.entry))
      finalSignature = computeStatSignature(repairedStats)
      fileEntries = new Map(repairedFiles.map((file) => [file.filenameId, file.entry]))
    }
    const index = buildScopeIndex(
      records,
      key,
      finalHash,
      this.version,
      malformed,
      fileEntries,
      this.config.cjkUnigrams
    )
    this.cache.set(key, index)
    await this.persistIndex(scope, index)
    this.meta.set(key, {
      statSignature: finalSignature,
      indexMtimeMs: await this.indexJsonMtime(scope),
      checkedAt: now
    })
    return index
  }

  private useSqlite(): boolean {
    return this.config.indexBackend === 'sqlite' && Date.now() >= this.sqliteFallbackUntil
  }

  private sqliteFor(scope: MemoryScope): SqliteIndex {
    const key = scopeKey(scope)
    let index = this.sqliteIndexes.get(key)
    if (index === undefined) {
      index = new SqliteIndex(this.root, scope, this.config.cjkUnigrams)
      this.sqliteIndexes.set(key, index)
    }
    return index
  }

  private async parseSqliteFile(
    stat: SqliteFileStat,
    scope: MemoryScope
  ): Promise<{ record: MemoryRecord; contentHash: string } | null> {
    try {
      const text = await fs.readFile(stat.file, 'utf8')
      const parsed = parseMemoryFile(text, scope, this.now())
      const record = parsed.record
      if (isUlid(stat.filenameId)) record.id = stat.filenameId
      return { record, contentHash: contentHashOf(text) }
    } catch (error) {
      this.warn(`sqlite 索引跳过无法解析的文件 ${stat.file}: ${String(error)}`)
      return null
    }
  }

  private async getSqliteScopeIndex(
    scope: MemoryScope,
    options: { refresh?: boolean; validate?: boolean } = {}
  ): Promise<ScopeIndex> {
    const key = scopeKey(scope)
    const cached = this.cache.get(key)
    const meta = this.meta.get(key)
    const handle = this.sqliteFor(scope)
    const mtime = await handle.mtime()
    if (
      options.refresh !== true &&
      options.validate !== true &&
      cached !== undefined &&
      meta !== undefined &&
      mtime !== 0 &&
      mtime === meta.indexMtimeMs
    ) {
      meta.checkedAt = Date.now()
      return cached
    }

    const stats = await this.listMemoryFileStats(scope)
    const synced = await handle.sync(stats, (stat) => this.parseSqliteFile(stat, scope), {
      refresh: options.refresh === true
    })
    this.version += 1
    const index: ScopeIndex = {
      scopeKey: key,
      builtAt: Date.now(),
      sourceHash: synced.sourceHash,
      docs: synced.docs,
      postings: new Map(),
      records: synced.records,
      version: this.version,
      malformed: synced.malformed,
      hydrated: true,
      backend: 'sqlite'
    }
    this.cache.set(key, index)
    this.meta.set(key, {
      statSignature: computeStatSignature(stats),
      indexMtimeMs: await handle.mtime(),
      checkedAt: Date.now()
    })
    await this.persistIndex(scope, index)
    return index
  }

  /** 关闭 SQLite 索引连接（收尾时调用）。 */
  close(): void {
    for (const index of this.sqliteIndexes.values()) index.close()
    this.sqliteIndexes.clear()
    this.cache.clear()
    this.meta.clear()
  }

  /** 强制重建一个或所有作用域的索引。 */
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

  /** 写入或更新一条记忆。 */
  async write(
    input: MemoryWriteInput,
    options: { actor?: 'model' | 'user' | 'system'; allowCreateWithId?: boolean } = {}
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
      if (existingId !== undefined && existing === undefined && options.allowCreateWithId !== true) {
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
      let previousConflicts: string[] = []

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
        previousConflicts = existing.conflictOf ?? []
        operation = 'updated'
      }

      conflicts = this.detectConflicts(index, record)
      if (conflicts.length > 0) record.conflictOf = conflicts
      else delete record.conflictOf

      const file = this.findFile(scope, record.id) ?? join(memoriesDir(this.root, scope), `${record.id}.md`)
      await writeFileAtomic(file, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
      // 冲突标记是双向的：另一条记录也要指向本条；内容修改解除冲突时反向清理。
      await this.syncConflictMarkers(scope, record.id, previousConflicts, conflicts)
      // 文件写入成功即为提交点。索引刷新失败会在之后自动修复。
      try {
        if (this.useSqlite()) {
          this.invalidateScope(scope)
          const next = await this.getScopeIndex(scope)
          await this.persistIndex(scope, next)
        } else if (conflicts.length > 0 || previousConflicts.length > 0) {
          // 冲突标记会改动其他文件；这种情况回退全量重建。
          this.invalidateScope(scope)
          const next = await this.getScopeIndex(scope, { refresh: true })
          await this.persistIndex(scope, next)
        } else {
          await this.updateIndexAfterWrite(scope, record)
        }
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

  /** 按 id 或 slug 读取一条记忆，优先使用调用方所在的作用域。 */
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

  /** 只定位，不更新使用计数。 */
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

  /** 将一条记忆静音（muted）或永久删除。 */
  async forget(id: string, mode: 'mute' | 'delete', scope?: MemoryScope): Promise<{ id: string; mode: string }> {
    const located = await this.requireLocated(id, scope)
    if (mode === 'delete') {
      await this.withScopeLock(located.scope, async () => {
        await fs.rm(located.file, { force: true })
        if (this.useSqlite()) this.invalidateScope(located.scope)
        else await this.removeIndexRecord(located.scope, located.record.id)
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

  /** 把一条记忆标记为已验证。只有用户会调用。 */
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

  /** 把一条记忆标记为 disputed。disputed 的记忆会退出核心层。 */
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

  /** 把 disputed/superseded/muted 的记忆恢复为 candidate。 */
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

  /** 固定或取消固定一条记忆（用户操作）。 */
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

  /**
   * 用户解决冲突：
   * - `keep`：保留 keep，把 other 标记为被取代；
   * - `merge`：把 other 合并进 keep（可覆盖 title/summary/body/tags/importance），再把 other 标记为被取代；
   * - `both`：两条都保留，只清除双向 conflictOf 标记。
   */
  async resolveConflict(
    keepId: string,
    otherId: string,
    mode: 'keep' | 'merge' | 'both',
    merged: MemoryMergeInput = {}
  ): Promise<{ keep: MemoryRecord; other: MemoryRecord }> {
    const keepLocated = await this.requireLocated(keepId)
    const otherLocated = await this.requireLocated(otherId, keepLocated.scope)
    if (scopeKey(keepLocated.scope) !== scopeKey(otherLocated.scope)) {
      throw new MemoryError('SCOPE_FORBIDDEN', '冲突解决要求两条记忆在同一个作用域')
    }
    if (keepLocated.record.id === otherLocated.record.id) {
      throw new MemoryError('INVALID_ARGUMENT', '不能用一条记忆解决与自身的冲突')
    }

    const result = await this.withScopeLock(keepLocated.scope, async () => {
      const keep = await this.readInScope(keepLocated.record.id, keepLocated.scope)
      const other = await this.readInScope(otherLocated.record.id, otherLocated.scope)
      if (keep === undefined || other === undefined) {
        throw new MemoryError('NOT_FOUND', '解决冲突时记忆已不存在')
      }
      const now = this.now()

      if (mode === 'merge') {
        const title = singleLine(redactSecrets(merged.title ?? keep.title, this.redactOptions()), 80)
        const summary = singleLine(redactSecrets(merged.summary ?? keep.summary, this.redactOptions()), 200)
        const body = sanitizeBody(merged.body ?? keep.body, this.redactOptions())
        const tags =
          merged.tags !== undefined
            ? normalizeTags(merged.tags)
            : [...new Set([...keep.tags, ...other.tags])]
        const importance =
          merged.importance !== undefined
            ? clampImportance(merged.importance)
            : Math.max(keep.importance, other.importance)
        const contentChanged =
          keep.title !== title || keep.summary !== summary || keep.body !== body
        keep.title = title
        keep.summary = summary
        keep.body = body
        keep.tags = tags
        keep.importance = importance
        if (contentChanged) {
          keep.revision += 1
          if (keep.trust === 'verified') {
            keep.trust = 'candidate'
            delete keep.verifiedBy
            delete keep.verifiedAt
          }
        }
        if (merged.evidence !== undefined && merged.evidence.trim().length > 0) {
          const quote = singleLine(redactSecrets(merged.evidence, this.redactOptions()), 500)
          if (this.verifyEvidence(quote, undefined)) keep.evidence = evidenceFor(quote)
        } else if (contentChanged) {
          delete keep.evidence
        }
      }

      const otherConflicts = [...new Set(other.conflictOf ?? [])]
      keep.conflictOf = (keep.conflictOf ?? []).filter((id) => id !== other.id)
      if (keep.conflictOf.length === 0) delete keep.conflictOf
      if (mode !== 'both') {
        // 被取代的记录不再需要冲突标记：同时从其他冲突记录中移除它。
        for (const id of otherConflicts) {
          if (id === keep.id) continue
          const file = this.findFile(keep.scope, id)
          if (file === undefined) continue
          const sibling = await this.readInScope(id, keep.scope)
          if (sibling === undefined) continue
          const remaining = (sibling.conflictOf ?? []).filter((item) => item !== other.id)
          if (remaining.length > 0) sibling.conflictOf = remaining
          else delete sibling.conflictOf
          await writeFileAtomic(file, serializeMemoryFile(sibling), { mode: 0o600, dirMode: 0o700 })
        }
        delete other.conflictOf
        keep.supersedes = other.id
        other.supersededBy = keep.id
        other.trust = 'superseded'
      } else {
        other.conflictOf = otherConflicts.filter((id) => id !== keep.id)
        if (other.conflictOf.length === 0) delete other.conflictOf
      }
      keep.updatedAt = now
      other.updatedAt = now
      const keepFile = this.findFile(keep.scope, keep.id)!
      const otherFile = this.findFile(other.scope, other.id)!
      await writeFileAtomic(keepFile, serializeMemoryFile(keep), { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(otherFile, serializeMemoryFile(other), { mode: 0o600, dirMode: 0o700 })
      this.invalidateScope(keep.scope)
      try {
        const next = await this.getScopeIndex(keep.scope, this.useSqlite() ? {} : { refresh: true })
        await this.persistIndex(keep.scope, next)
      } catch (error) {
        this.warn(`index refresh after conflict resolution failed: ${String(error)}`)
      }
      return { keep, other }
    })

    await this.audit.append({
      ts: this.now(),
      event: 'resolve',
      actor: 'user',
      id: result.keep.id,
      scope: scopeKey(keepLocated.scope),
      details: { mode, otherId: result.other.id }
    })
    return result
  }

  /** 把 `oldId` 标记为已被 `newId` 取代；两侧都会写入。 */
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

  /** 更新使用计数（尽力而为，绝不改变 `updatedAt`）。 */
  async touch(id: string, scope?: MemoryScope): Promise<void> {
    const located = await this.requireLocated(id, scope)
    await this.withScopeLock(located.scope, async () => {
      const record = await this.readInScope(located.record.id, located.scope)
      if (record === undefined) return
      record.lastUsedAt = this.now()
      record.useCount += 1
      await writeFileAtomic(located.file, serializeMemoryFile(record), { mode: 0o600, dirMode: 0o700 })
      // 使用计数不属于内容：直接修补缓存的索引，
      // 而不是在下次搜索时强制完整重新解析。
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
        if (cached.files !== undefined) {
          const stat = await fs.stat(located.file)
          cached.files.set(record.id, {
            id: record.id,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            contentHash: contentHashOf(serializeMemoryFile(record))
          })
          cached.sourceHash = computeSourceHash([...cached.files.values()])
          cached.builtAt = Date.now()
        }
      }
      if (this.useSqlite()) {
        try {
          await this.sqliteFor(located.scope).updateUsage(record.id, record.lastUsedAt, record.useCount)
        } catch (error) {
          this.warn(`sqlite usage update failed: ${String(error)}`)
        }
      }
    })
  }

  /** 为一次查询对记忆排序。 */
  async search(options: MemorySearchOptions): Promise<MemorySearchHit[]> {
    if (options.query.trim().length === 0) return []
    if (this.useSqlite()) {
      try {
        return await this.searchSqlite(options)
      } catch (error) {
        this.sqliteFallbackUntil = Date.now() + 30_000
        this.warn(`sqlite 检索暂不可用，30 秒内回退 JSON: ${String(error)}`)
      }
    }
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
    const terms = [...new Set(tokenize(options.query, { cjkUnigrams: this.config.cjkUnigrams }))]
    if (terms.length === 0) return []

    // 只给包含查询词的文档打分；直接查 postings，
    // 而不是每次搜索都合并整个倒排索引。
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
    const offer = (raw: number, score: number, entry: (typeof entries)[number]): void => {
      if (top.length === TOP && !better(score, entry.doc, top[TOP - 1]!)) return
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
      offer(raw, score, entry)
    }
    // 关键词命中不足时，用其余文档的元数据分补足头部候选。
    // 查询完全无命中时仍返回空，避免“搜不到却给出无关记忆”的误导。
    if (options.includeMetadataFallback !== false && top.length > 0 && top.length < TOP) {
      for (let ordinal = 0; ordinal < docCount && top.length < TOP; ordinal += 1) {
        if (scores[ordinal]! > 0) continue
        const entry = entries[ordinal]!
        const score = scoreDoc(entry.doc, entry.scope, {
          bm25Norm: 0,
          now,
          halfLifeDays: this.config.decayHalfLifeDays,
          currentProjectKey
        })
        offer(0, score, entry)
      }
    }
    // 只对排名头部去重并做多样性选择；这样即使某个作用域里有几万条记忆，
    // 近似重复检查的代价仍是有界的。
    const pool: ScoredMemory[] = top.map((item) => ({
      record: partialRecord(item.doc, item.scopeKey),
      bm25: item.bm25,
      score: item.score
    }))
    const limit = Math.min(Math.max(1, options.limit ?? this.config.maxSearchResults), 20)
    return this.finalizeSearch(pool, options, limit)
  }

  /** JSON 与 SQLite 两条召回路径共享的去重、MMR、命中和审计。 */
  private finalizeSearch(
    scored: ScoredMemory[],
    options: MemorySearchOptions,
    limit: number
  ): MemorySearchHit[] {
    const deduped = dedupeCandidates(scored.slice(0, 40))
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
    if (options.audit !== false) {
      void this.audit.append({
        ts: this.now(),
        event: 'search',
        actor: options.actor ?? 'model',
        sessionId: options.sessionId,
        queryHash: sha256(options.query),
        resultIds: hits.map((hit) => hit.id)
      })
    }
    return hits
  }

  private async searchSqlite(options: MemorySearchOptions): Promise<MemorySearchHit[]> {
    const scopes = this.searchScopes(options)
    if (scopes.length === 0) return []
    for (const scope of scopes) {
      const handle = this.sqliteFor(scope)
      if (!(await handle.exists()) || (await handle.isEmpty())) {
        await this.withScopeLock(scope, () => this.getSqliteScopeIndex(scope, { refresh: true }))
      }
    }
    const now = this.now()
    const currentProjectKey = options.projectScope?.type === 'project' ? options.projectScope.key : undefined
    const limit = Math.min(Math.max(1, options.limit ?? this.config.maxSearchResults), 20)
    const candidates: Array<{ doc: IndexedDoc; scopeKey: string; bm25: number }> = []
    for (const scope of scopes) {
      const handle = this.sqliteFor(scope)
      const hits = await handle.search(options.query, {
        limit: Math.max(200, limit * 20),
        includeDisputed: options.includeDisputed === true,
        kinds: options.kinds,
        now
      })
      for (const hit of hits) {
        if (!this.isDocSearchable(hit.doc, options, now)) continue
        candidates.push({ doc: hit.doc, scopeKey: hit.scopeKey, bm25: hit.bm25 })
      }
    }
    if (candidates.length === 0) return []
    if (options.includeMetadataFallback !== false && candidates.length < 40) {
      const seen = new Set(candidates.map((candidate) => candidate.doc.id))
      for (const scope of scopes) {
        if (candidates.length >= 40) break
        const docs = await this.sqliteFor(scope).allDocs()
        for (const doc of docs) {
          if (candidates.length >= 40) break
          if (seen.has(doc.id) || !this.isDocSearchable(doc, options, now)) continue
          seen.add(doc.id)
          candidates.push({ doc, scopeKey: scopeKey(scope), bm25: 0 })
        }
      }
    }
    let maxBm25 = 0
    for (const candidate of candidates) if (candidate.bm25 > maxBm25) maxBm25 = candidate.bm25
    const scored = candidates.map((candidate) => {
      const record = partialRecord(candidate.doc, candidate.scopeKey)
      return {
        record,
        bm25: candidate.bm25,
        score: scoreDoc(candidate.doc, record.scope, {
          bm25Norm: maxBm25 > 0 ? candidate.bm25 / maxBm25 : 0,
          now,
          halfLifeDays: this.config.decayHalfLifeDays,
          currentProjectKey
        })
      } satisfies ScoredMemory
    })
    scored.sort(
      (a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt || a.record.id.localeCompare(b.record.id)
    )
    return this.finalizeSearch(scored, options, limit)
  }

  /** 列出摘要，供调试和侧边栏视图使用。 */
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

  /** 某个项目的评审队列所需的全部内容。 */
  async review(
    projectScope?: MemoryScope,
    scope: 'user' | 'project' | 'all' = 'project'
  ): Promise<{
    candidates: IndexedDoc[]
    conflicts: IndexedDoc[]
    stale: IndexedDoc[]
    expired: IndexedDoc[]
  }> {
    const scopes =
      scope === 'all'
        ? this.allScopes()
        : this.scopesToSearch({
            projectScope,
            scope: scope === 'user' ? { type: 'user' } : undefined
          })
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

  /** 供侧边栏使用的聚合计数。 */
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

  /** 从磁盘读取某个作用域的全部记录（含完整正文）。 */
  async recordsOf(scope: MemoryScope): Promise<{ records: MemoryRecord[]; malformed: MalformedFile[] }> {
    const { records, malformed } = await this.parseSourceFiles(scope, await this.readSourceFiles(scope))
    return { records, malformed }
  }

  /** 核心层需要的全部记录：用户作用域加上当前项目。 */
  async coreRecords(projectScope?: MemoryScope, options: { validate?: boolean } = {}): Promise<MemoryRecord[]> {
    const scopes = this.scopesToSearch({ projectScope })
    const out: MemoryRecord[] = []
    for (const scope of scopes) {
      const index = await this.getScopeIndex(scope, { validate: options.validate === true })
      out.push(...index.records)
    }
    return out
  }

  /** 把记录导入某个作用域，一律作为 candidate。 */
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
        const result = await this.write(
          {
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
          },
          { actor: 'user', allowCreateWithId: true }
        )
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

  /** 把一个作用域导出为 Markdown 文件、AGENTS.md 片段或 JSON。 */
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

  /** 在不修改任何内容的前提下执行一致性检查。 */
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

  /**
   * 扫描历史数据中的疑似冲突，并可选地补写双向 conflictOf。
   * 使用 summary token 倒排做候选对，避免对 10k 条记录做完整 O(n²)。
   */
  async scanConflicts(
    scope?: MemoryScope,
    options: { mark?: boolean } = {}
  ): Promise<{ scanned: number; pairs: Array<{ a: string; b: string; scope: string }>; marked: number }> {
    const scopes = scope !== undefined ? [scope] : this.allScopes()
    let scanned = 0
    let marked = 0
    const pairs: Array<{ a: string; b: string; scope: string }> = []

    for (const current of scopes) {
      await this.withScopeLock(current, async () => {
        const currentKey = scopeKey(current)
        const currentPairs: Array<{ a: string; b: string; scope: string }> = []
        const index = await this.getScopeIndex(current, { refresh: true })
        scanned += index.docs.size
        const byKind = new Map<string, IndexedDoc[]>()
        for (const doc of index.docs.values()) {
          if (doc.muted || doc.trust === 'superseded') continue
          const list = byKind.get(doc.kind) ?? []
          list.push(doc)
          byKind.set(doc.kind, list)
        }
        const seen = new Set<string>()
        for (const docs of byKind.values()) {
          const byToken = new Map<string, IndexedDoc[]>()
          for (const doc of docs) {
            for (const term of new Set(tokenize(doc.summary, { cjkUnigrams: this.config.cjkUnigrams }))) {
              const bucket = byToken.get(term) ?? []
              bucket.push(doc)
              byToken.set(term, bucket)
            }
          }
          for (const bucket of byToken.values()) {
            // 常见词桶过大，跳过；稀有词桶足以覆盖大多数冲突。
            if (bucket.length < 2 || bucket.length > 300) continue
            for (let i = 0; i < bucket.length; i += 1) {
              for (let j = i + 1; j < bucket.length; j += 1) {
                const a = bucket[i]!
                const b = bucket[j]!
                if (!summariesConflict(a.summary, b.summary)) continue
                const key = a.id < b.id ? `${a.id}\u0000${b.id}` : `${b.id}\u0000${a.id}`
                if (seen.has(key)) continue
                seen.add(key)
                const pair = { a: a.id, b: b.id, scope: currentKey }
                currentPairs.push(pair)
                pairs.push(pair)
              }
            }
          }
        }

        if (options.mark !== true) return
        let scopeMarked = 0
        for (const pair of currentPairs) {
          const a = await this.readInScope(pair.a, current)
          const b = await this.readInScope(pair.b, current)
          if (a === undefined || b === undefined) continue
          const aConf = new Set(a.conflictOf ?? [])
          const bConf = new Set(b.conflictOf ?? [])
          if (aConf.has(b.id) && bConf.has(a.id)) continue
          aConf.add(b.id)
          bConf.add(a.id)
          a.conflictOf = [...aConf]
          b.conflictOf = [...bConf]
          const aFile = this.findFile(current, a.id)
          const bFile = this.findFile(current, b.id)
          if (aFile === undefined || bFile === undefined) continue
          await writeFileAtomic(aFile, serializeMemoryFile(a), { mode: 0o600, dirMode: 0o700 })
          await writeFileAtomic(bFile, serializeMemoryFile(b), { mode: 0o600, dirMode: 0o700 })
          scopeMarked += 1
          marked += 1
        }
        if (scopeMarked > 0) {
          this.invalidateScope(current)
          await this.getScopeIndex(current, { refresh: true })
        }
      })
    }
    return { scanned, pairs, marked }
  }

  // -------------------------------------------------------------------------
  // 内部实现
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
      if (doc.muted || doc.trust === 'superseded') continue
      if (doc.kind !== record.kind) continue
      if (summariesConflict(doc.summary, record.summary)) out.push(doc.id)
    }
    return out
  }

  /**
   * 同步双向冲突标记。`previous` 是本条修改前的冲突集合，`next` 是修改后的集合；
   * 旧冲突被解除时，同时从对方记录中移除本条 ID。
   */
  private async syncConflictMarkers(
    scope: MemoryScope,
    id: string,
    previous: readonly string[],
    next: readonly string[]
  ): Promise<void> {
    const nextSet = new Set(next)
    const affected = new Set([...previous, ...next])
    for (const otherId of affected) {
      if (otherId === id) continue
      const file = this.findFile(scope, otherId)
      if (file === undefined) continue
      const other = await this.readInScope(otherId, scope)
      if (other === undefined) continue
      const current = new Set(other.conflictOf ?? [])
      const before = current.size
      if (nextSet.has(otherId)) current.add(id)
      else current.delete(id)
      if (current.size === before && (current.has(id) === nextSet.has(otherId))) continue
      if (current.size > 0) other.conflictOf = [...current]
      else delete other.conflictOf
      await writeFileAtomic(file, serializeMemoryFile(other), { mode: 0o600, dirMode: 0o700 })
    }
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
      // 索引可能比手工改名的文件更新。
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
      try {
        if (this.useSqlite()) {
          this.invalidateScope(located.scope)
          const next = await this.getScopeIndex(located.scope)
          await this.persistIndex(located.scope, next)
        } else {
          await this.updateIndexAfterWrite(located.scope, record)
        }
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
        if (options.scope === 'all' && options.includeOtherProjects !== false) {
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
        // 手写的文件可能没有 id；此时 ULID 文件名就是它的身份标识。
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
    const index = parseScopeIndexJson(text, key, scope, this.version, this.config.cjkUnigrams)
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

  private removeIndexPostings(index: ScopeIndex, id: string): void {
    for (const [term, posting] of index.postings) {
      if (!posting.delete(id)) continue
      if (posting.size === 0) index.postings.delete(term)
    }
  }

  private applyIndexRecord(index: ScopeIndex, record: MemoryRecord): void {
    this.removeIndexPostings(index, record.id)
    const terms = indexRecord(record, { cjkUnigrams: this.config.cjkUnigrams })
    index.docs.set(record.id, toIndexedDoc(record, terms.length))
    for (const [term, tf] of terms.terms) {
      let posting = index.postings.get(term)
      if (posting === undefined) {
        posting = new Map<string, number>()
        index.postings.set(term, posting)
      }
      posting.set(record.id, tf)
    }
    const at = index.records.findIndex((item) => item.id === record.id)
    if (at >= 0) index.records[at] = record
    else index.records.push(record)
    index.hydrated = true
  }

  private statSignatureOfFiles(files: Map<string, SourceFileEntry>): string {
    return computeStatSignature(
      [...files.values()].map((entry) => ({
        file: entry.id,
        filenameId: entry.id,
        size: entry.size,
        mtimeMs: entry.mtimeMs
      }))
    )
  }

  /**
   * 写入单条 Markdown 后增量更新 JSON 索引；不再重新解析整个作用域。
   * 没有文件指纹（旧 index.json）时回退一次全量重建。
   */
  private async updateIndexAfterWrite(scope: MemoryScope, record: MemoryRecord): Promise<void> {
    const key = scopeKey(scope)
    let index = this.cache.get(key)
    if (index === undefined) index = await this.getScopeIndex(scope)
    if (index.files === undefined) {
      index = await this.getScopeIndex(scope, { refresh: true })
    }
    if (index.files === undefined) return
    const file = this.findFile(scope, record.id)
    if (file === undefined) {
      this.invalidateScope(scope)
      return
    }
    const stat = await fs.stat(file)
    index.files.set(record.id, {
      id: record.id,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: contentHashOf(serializeMemoryFile(record))
    })
    this.applyIndexRecord(index, record)
    index.sourceHash = computeSourceHash([...index.files.values()])
    index.builtAt = Date.now()
    index.version = (this.version += 1)
    await this.persistIndex(scope, index)
    this.meta.set(key, {
      statSignature: this.statSignatureOfFiles(index.files),
      indexMtimeMs: await this.indexJsonMtime(scope),
      checkedAt: Date.now()
    })
  }

  private async removeIndexRecord(scope: MemoryScope, id: string): Promise<void> {
    const key = scopeKey(scope)
    const index = this.cache.get(key)
    if (index === undefined || index.files === undefined) {
      this.invalidateScope(scope)
      return
    }
    this.removeIndexPostings(index, id)
    index.docs.delete(id)
    index.records = index.records.filter((record) => record.id !== id)
    index.files.delete(id)
    index.sourceHash = computeSourceHash([...index.files.values()])
    index.builtAt = Date.now()
    index.version = (this.version += 1)
    await this.persistIndex(scope, index)
    this.meta.set(key, {
      statSignature: this.statSignatureOfFiles(index.files),
      indexMtimeMs: await this.indexJsonMtime(scope),
      checkedAt: Date.now()
    })
  }

  private async persistIndex(scope: MemoryScope, index: ScopeIndex): Promise<void> {    const dir = scopeDir(this.root, scope)
    if (index.backend !== 'sqlite') {
      const json = `${JSON.stringify(serializeScopeIndex(index), null, 2)}\n`
      try {
        await writeFileAtomic(join(dir, 'index.json'), json, { mode: 0o600, dirMode: 0o700 })
      } catch (error) {
        this.warn(`index.json write failed: ${String(error)}`)
      }
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
