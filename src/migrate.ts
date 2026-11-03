/**
 * schema 版本迁移钩子。
 *
 * 比本插件更新的文件会被拒绝（侧边栏中显示只读提示）；较旧的文件会先备份到
 * `memory.bak/`，然后再重写。当前 schema 为 1，因此正常运行时这里是空操作。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION, type MemoryScope } from './types.ts'
import type { MemoryStore } from './store/store.ts'
import { backupDir, memoriesDir } from './store/paths.ts'

/** 拒绝由更新版本插件写入的数据。 */
export function assertReadableSchema(version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new Error(`SCHEMA_TOO_NEW: memory schema ${version} is newer than supported ${SCHEMA_VERSION}`)
  }
}

/** 把一个作用域的所有记忆文件复制到 `memory.bak/<timestamp>/`。 */
export async function backupScope(store: MemoryStore, scope: MemoryScope): Promise<string | undefined> {
  const source = memoriesDir(store.root, scope)
  let entries
  try {
    entries = await fs.readdir(source, { withFileTypes: true })
  } catch {
    return undefined
  }
  const target = join(backupDir(store.root), String(Date.now()), scope.type === 'user' ? 'user' : scope.key)
  let copied = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    await fs.mkdir(target, { recursive: true, mode: 0o700 })
    await fs.copyFile(join(source, entry.name), join(target, entry.name))
    copied += 1
  }
  return copied > 0 ? target : undefined
}

/** 对一个作用域执行启动迁移（版本 1 目前为空操作）。 */
export async function migrateScope(store: MemoryStore, scope: MemoryScope): Promise<{ migrated: number; backup?: string }> {
  const { records } = await store.recordsOf(scope)
  const stale = records.filter((record) => record.schemaVersion < SCHEMA_VERSION)
  if (stale.length === 0) return { migrated: 0 }
  // 版本 1 是唯一发布过的 schema。未来 schema 版本的字段级迁移在这里添加，
  // 此时备份已经落盘。
  const backup = await backupScope(store, scope)
  await store.audit.append({
    ts: Date.now(),
    event: 'migrate',
    actor: 'system',
    scope: scope.type === 'user' ? 'user' : `project:${scope.key}`,
    details: { migrated: stale.length }
  })
  return { migrated: stale.length, backup }
}
