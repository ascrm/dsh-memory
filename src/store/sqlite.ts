/**
 * 可选的 SQLite FTS5 派生索引。
 *
 * Markdown 仍是唯一事实来源；`index.sqlite` 只是可删除、可重建的检索缓存。
 * 与 `index.json` 不同，FTS5 不把 postings 全量加载进内存，适合 10k+ 条记忆。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryRecord, MemoryScope } from '../types.ts'
import type { IndexedDoc } from './index.ts'
import { computeSourceHash, docToPartialRecord, toIndexedDoc, type MalformedFile } from './index.ts'
import { scopeDir } from './paths.ts'
import { tokenize } from '../retrieval/tokenize.ts'
import { indexRecord } from '../retrieval/bm25.ts'

/** 文件 stat，供增量同步使用。 */
export interface SqliteFileStat {
  file: string
  filenameId: string
  size: number
  mtimeMs: number
}

/** 同步结果。 */
export interface SqliteSyncResult {
  docs: Map<string, IndexedDoc>
  records: MemoryRecord[]
  sourceHash: string
  malformed: MalformedFile[]
}

/** FTS5 检索命中的候选。 */
export interface SqliteHit {
  doc: IndexedDoc
  scopeKey: string
  bm25: number
}

const FTS_COLUMNS = 'id, title, summary, tags, body'
const BM25_WEIGHTS = '0.0, 3.0, 2.0, 2.0, 1.0'

/**
 * 一个作用域的 SQLite 索引。DatabaseSync 是同步 API，因此打开/查询会短暂阻塞；
 * 解析 Markdown 仍然走异步文件读取。
 */
export class SqliteIndex {
  private readonly root: string
  private readonly scope: MemoryScope
  private readonly cjkUnigrams: boolean
  private db: DatabaseSync | undefined

  constructor(root: string, scope: MemoryScope, cjkUnigrams = false) {
    this.root = root
    this.scope = scope
    this.cjkUnigrams = cjkUnigrams
  }

  /** 数据库文件路径。 */
  get file(): string {
    return join(scopeDir(this.root, this.scope), 'index.sqlite')
  }

  /** 打开数据库并确保 schema 存在。 */
  async open(): Promise<void> {
    if (this.db !== undefined) return
    await fs.mkdir(scopeDir(this.root, this.scope), { recursive: true, mode: 0o700 })
    await assertSqliteHeader(this.file)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(this.file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_docs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL,
        trust TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL,
        importance INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL,
        expires_at INTEGER,
        pinned INTEGER NOT NULL,
        muted INTEGER NOT NULL,
        conflict_of TEXT,
        prior_score REAL,
        length INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_files (
        id TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        title,
        summary,
        tags,
        body
      );
      CREATE INDEX IF NOT EXISTS memory_docs_kind ON memory_docs(kind);
      CREATE INDEX IF NOT EXISTS memory_docs_trust ON memory_docs(trust);
    `)
    const meta = db
      .prepare("SELECT value FROM memory_meta WHERE key = 'cjkUnigrams'")
      .get() as { value?: string } | undefined
    const storedUnigrams = meta?.value === '1'
    if (meta === undefined) {
      const row = db.prepare('SELECT COUNT(*) AS count FROM memory_docs').get() as
        | { count?: number }
        | undefined
      if (this.cjkUnigrams && Number(row?.count ?? 0) > 0) {
        db.exec('DELETE FROM memory_fts; DELETE FROM memory_docs; DELETE FROM memory_files;')
      }
      db.prepare("INSERT INTO memory_meta (key, value) VALUES ('cjkUnigrams', ?)").run(
        this.cjkUnigrams ? '1' : '0'
      )
    } else if (storedUnigrams !== this.cjkUnigrams) {
      // tokenizer 配置变了：旧索引的 FTS/postings 不能复用，清空后由下一次 sync 重建。
      db.exec('DELETE FROM memory_fts; DELETE FROM memory_docs; DELETE FROM memory_files;')
      db.prepare("UPDATE memory_meta SET value = ? WHERE key = 'cjkUnigrams'").run(
        this.cjkUnigrams ? '1' : '0'
      )
    }
    this.db = db
    await hardenSqlitePermissions(this.file)
  }

  /** 数据库文件是否已存在。 */
  async exists(): Promise<boolean> {
    try {
      await fs.stat(this.file)
      return true
    } catch {
      return false
    }
  }

  /** 数据库里是否还没有任何文档。 */
  async isEmpty(): Promise<boolean> {
    await this.open()
    const row = this.db!.prepare('SELECT COUNT(*) AS count FROM memory_docs').get() as
      | { count?: number }
      | undefined
    return Number(row?.count ?? 0) === 0
  }

  /** 数据库文件 mtime（含 WAL），用于跨进程快速失效判断。 */
  async mtime(): Promise<number> {
    let latest = 0
    for (const file of [this.file, `${this.file}-wal`]) {
      try {
        const value = (await fs.stat(file)).mtimeMs
        if (value > latest) latest = value
      } catch {
        // 文件不存在时跳过。
      }
    }
    return latest
  }

  /**
   * 增量同步文件与索引。
   * `parse` 只在文件新增或 size/mtime 变化时调用；`refresh` 为 true 时强制重解析全部文件。
   */
  async sync(
    stats: readonly SqliteFileStat[],
    parse: (stat: SqliteFileStat) => Promise<{ record: MemoryRecord; contentHash: string } | null>,
    options: { refresh?: boolean } = {}
  ): Promise<SqliteSyncResult> {
    await this.open()
    const db = this.db!
    const existing = new Map<string, { size: number; mtime: number }>()
    for (const row of db.prepare('SELECT id, size, mtime FROM memory_files').all() as Array<Record<string, unknown>>) {
      existing.set(String(row.id), { size: Number(row.size), mtime: Number(row.mtime) })
    }
    const current = new Map(stats.map((stat) => [stat.filenameId, stat]))
    const changed: Array<{ stat: SqliteFileStat; record: MemoryRecord; contentHash: string }> = []
    const malformed: MalformedFile[] = []
    const malformedIds = new Set<string>()
    const pending: SqliteFileStat[] = []

    for (const stat of stats) {
      const previous = existing.get(stat.filenameId)
      const unchanged =
        options.refresh !== true &&
        previous !== undefined &&
        previous.size === stat.size &&
        Math.abs(previous.mtime - stat.mtimeMs) < 1
      if (unchanged) continue
      pending.push(stat)
    }

    // 解析是 IO 密集的；分批并行，避免 10k 条冷启动完全串行。
    for (let start = 0; start < pending.length; start += 128) {
      const batch = pending.slice(start, start + 128)
      const parsed = await Promise.all(
        batch.map(async (stat) => ({ stat, value: await parse(stat) }))
      )
      for (const item of parsed) {
        if (item.value === null) {
          malformed.push({ file: item.stat.file, id: item.stat.filenameId, message: 'unparseable memory file' })
          malformedIds.add(item.stat.filenameId)
        } else {
          changed.push({
            stat: item.stat,
            record: item.value.record,
            contentHash: item.value.contentHash
          })
        }
      }
    }

    const removed = [...existing.keys()].filter((id) => !current.has(id))
    const upsertDoc = db.prepare(`
      INSERT INTO memory_docs (
        id, scope, slug, kind, trust, title, summary, tags, importance,
        created_at, updated_at, last_used_at, use_count, expires_at,
        pinned, muted, conflict_of, prior_score, length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        slug = excluded.slug,
        kind = excluded.kind,
        trust = excluded.trust,
        title = excluded.title,
        summary = excluded.summary,
        tags = excluded.tags,
        importance = excluded.importance,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at,
        use_count = excluded.use_count,
        expires_at = excluded.expires_at,
        pinned = excluded.pinned,
        muted = excluded.muted,
        conflict_of = excluded.conflict_of,
        prior_score = excluded.prior_score,
        length = excluded.length
    `)
    const deleteFts = db.prepare('DELETE FROM memory_fts WHERE id = ?')
    const insertFts = db.prepare(`INSERT INTO memory_fts (${FTS_COLUMNS}) VALUES (?, ?, ?, ?, ?)`)
    const deleteDoc = db.prepare('DELETE FROM memory_docs WHERE id = ?')
    const upsertFile = db.prepare(`
      INSERT INTO memory_files (id, size, mtime, content_hash) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash
    `)
    const deleteFile = db.prepare('DELETE FROM memory_files WHERE id = ?')
    const scopeKey = this.scope.type === 'user' ? 'user' : `project:${this.scope.key}`

    db.exec('BEGIN')
    try {
      for (const { stat, record, contentHash } of changed) {
        const doc = toIndexedDoc(record, indexRecord(record, { cjkUnigrams: this.cjkUnigrams }).length)
        upsertDoc.run(
          record.id,
          scopeKey,
          record.slug,
          record.kind,
          record.trust,
          record.title,
          record.summary,
          JSON.stringify(record.tags),
          record.importance,
          record.createdAt,
          record.updatedAt,
          record.lastUsedAt ?? null,
          record.useCount,
          record.expiresAt ?? null,
          record.pinned ? 1 : 0,
          record.muted ? 1 : 0,
          record.conflictOf !== undefined ? JSON.stringify(record.conflictOf) : null,
          doc.priorScore ?? null,
          doc.length
        )
        deleteFts.run(record.id)
        insertFts.run(
          record.id,
          tokenize(record.title, { cjkUnigrams: this.cjkUnigrams }).join(' '),
          tokenize(record.summary, { cjkUnigrams: this.cjkUnigrams }).join(' '),
          tokenize(record.tags.join(' '), { cjkUnigrams: this.cjkUnigrams }).join(' '),
          tokenize(record.body, { cjkUnigrams: this.cjkUnigrams }).join(' ')
        )
        upsertFile.run(record.id, stat.size, stat.mtimeMs, contentHash)
      }
      for (const id of removed) {
        deleteDoc.run(id)
        deleteFts.run(id)
        deleteFile.run(id)
      }
      for (const id of malformedIds) {
        deleteDoc.run(id)
        deleteFts.run(id)
        deleteFile.run(id)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const docs = new Map<string, IndexedDoc>()
    const records: MemoryRecord[] = []
    for (const row of db.prepare('SELECT * FROM memory_docs').all() as Array<Record<string, unknown>>) {
      const doc: IndexedDoc = {
        id: String(row.id),
        slug: String(row.slug),
        kind: String(row.kind) as IndexedDoc['kind'],
        trust: String(row.trust) as IndexedDoc['trust'],
        title: String(row.title),
        summary: String(row.summary),
        tags: parseStringArray(row.tags),
        importance: Number(row.importance),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastUsedAt: row.last_used_at === null ? undefined : Number(row.last_used_at),
        useCount: Number(row.use_count),
        expiresAt: row.expires_at === null ? undefined : Number(row.expires_at),
        pinned: Number(row.pinned) === 1,
        muted: Number(row.muted) === 1,
        conflictOf: row.conflict_of === null ? undefined : parseStringArray(row.conflict_of),
        priorScore: row.prior_score === null ? undefined : Number(row.prior_score),
        length: Number(row.length)
      }
      docs.set(doc.id, doc)
      records.push(docToPartialRecord(doc, this.scope))
    }
    const fileEntries = (db.prepare('SELECT id, size, mtime, content_hash FROM memory_files').all() as Array<
      Record<string, unknown>
    >).map((row) => ({
      id: String(row.id),
      size: Number(row.size),
      mtimeMs: Number(row.mtime),
      contentHash: String(row.content_hash)
    }))
    return {
      docs,
      records,
      sourceHash: computeSourceHash(fileEntries),
      malformed
    }
  }

  /** FTS5 检索；返回按 FTS bm25 排序的候选。 */
  async search(
    query: string,
    options: {
      limit: number
      includeDisputed: boolean
      kinds?: readonly string[]
      now: number
    }
  ): Promise<SqliteHit[]> {
    await this.open()
    const terms = [...new Set(tokenize(query, { cjkUnigrams: this.cjkUnigrams }))]
    if (terms.length === 0) return []
    const match = terms.map((term) => `"${term}"`).join(' OR ')
    const clauses = [
      'memory_fts MATCH ?',
      'd.muted = 0',
      "d.trust <> 'superseded'",
      '(d.expires_at IS NULL OR d.expires_at >= ?)'
    ]
    const params: Array<string | number> = [match, options.now]
    if (!options.includeDisputed) clauses.push("d.trust <> 'disputed'")
    if (options.kinds !== undefined && options.kinds.length > 0) {
      clauses.push(`d.kind IN (${options.kinds.map(() => '?').join(', ')})`)
      params.push(...options.kinds)
    }
    params.push(options.limit)
    const rows = this.db!
      .prepare(`
        SELECT d.*, -bm25(memory_fts, ${BM25_WEIGHTS}) AS bm25_rank
        FROM memory_fts
        JOIN memory_docs d ON d.id = memory_fts.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY bm25_rank DESC
        LIMIT ?
      `)
      .all(...params) as Array<Record<string, unknown>>
    const scopeKey = this.scope.type === 'user' ? 'user' : `project:${this.scope.key}`
    return rows.map((row) => ({
      scopeKey,
      bm25: Number(row.bm25_rank),
      doc: docFromRow(row)
    }))
  }

  /** 读取全部文档，供元数据 fallback 使用。 */
  async allDocs(): Promise<IndexedDoc[]> {
    await this.open()
    const rows = this.db!.prepare('SELECT * FROM memory_docs').all() as Array<Record<string, unknown>>
    return rows.map((row) => docFromRow(row))
  }

  /** 只更新使用计数，不触碰 FTS。 */
  async updateUsage(id: string, lastUsedAt: number, useCount: number): Promise<void> {
    await this.open()
    this.db!.prepare('UPDATE memory_docs SET last_used_at = ?, use_count = ? WHERE id = ?').run(
      lastUsedAt,
      useCount,
      id
    )
  }

  /** 关闭数据库（收尾时调用）。 */
  close(): void {
    this.db?.close()
    this.db = undefined
    void hardenSqlitePermissions(this.file)
  }
}

/** 尽力收紧索引文件权限；目录本身已是 0700。 */
async function hardenSqlitePermissions(file: string): Promise<void> {
  for (const target of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      await fs.chmod(target, 0o600)
    } catch {
      // Windows ACL 或文件尚未创建时忽略。
    }
  }
}

/** 在交给 SQLite 之前检查文件头，损坏文件可以快速回退而不是等待恢复。 */
async function assertSqliteHeader(file: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, 16, 0)
    if (bytesRead < 16 || buffer.toString('latin1') !== 'SQLite format 3\u0000') {
      throw new Error('index.sqlite 文件头无效')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    await handle?.close()
  }
}

function docFromRow(row: Record<string, unknown>): IndexedDoc {
  return {
    id: String(row.id),
    slug: String(row.slug),
    kind: String(row.kind) as IndexedDoc['kind'],
    trust: String(row.trust) as IndexedDoc['trust'],
    title: String(row.title),
    summary: String(row.summary),
    tags: parseStringArray(row.tags),
    importance: Number(row.importance),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at === null ? undefined : Number(row.last_used_at),
    useCount: Number(row.use_count),
    expiresAt: row.expires_at === null ? undefined : Number(row.expires_at),
    pinned: Number(row.pinned) === 1,
    muted: Number(row.muted) === 1,
    conflictOf: row.conflict_of === null ? undefined : parseStringArray(row.conflict_of),
    priorScore: row.prior_score === null ? undefined : Number(row.prior_score),
    length: Number(row.length)
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
