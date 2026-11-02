/**
 * Schema-version migration hooks.
 *
 * Files newer than this plugin are rejected (read-only note in the panel);
 * older files are backed up under `memory.bak/` before being rewritten. Current
 * schema is 1, so normal operation is a no-op.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION, type MemoryScope } from './types.ts'
import type { MemoryStore } from './store/store.ts'
import { backupDir, memoriesDir } from './store/paths.ts'

/** Reject data written by a newer plugin. */
export function assertReadableSchema(version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new Error(`SCHEMA_TOO_NEW: memory schema ${version} is newer than supported ${SCHEMA_VERSION}`)
  }
}

/** Copy every memory file of a scope into `memory.bak/<timestamp>/`. */
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

/** Run startup migrations for a scope (currently a no-op for version 1). */
export async function migrateScope(store: MemoryStore, scope: MemoryScope): Promise<{ migrated: number; backup?: string }> {
  const { records } = await store.recordsOf(scope)
  const stale = records.filter((record) => record.schemaVersion < SCHEMA_VERSION)
  if (stale.length === 0) return { migrated: 0 }
  // Version 1 is the only released schema. Field-level migrations for a future
  // schema version are added here, after the backup is on disk.
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
