/**
 * Import/export helpers.
 *
 * Export never mutates the source. AGENTS.md output only includes verified
 * preference/constraint/decision summaries, never bodies.
 */
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { MemoryRecord, MemoryScope } from './types.ts'
import type { MemoryStore } from './store/store.ts'
import { parseMemoryFile, serializeMemoryFile } from './store/parse.ts'
import { singleLine } from './store/sanitize.ts'

/** Render the AGENTS.md fragment for a set of records. */
export function renderAgentsFragment(records: readonly MemoryRecord[]): string {
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
    lines.push(`- **${singleLine(record.title, 80)}** — ${singleLine(record.summary, 200)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Export one scope. */
export async function exportScope(store: MemoryStore, scope: MemoryScope, format: 'md' | 'agents' | 'json') {
  return store.exportScope(scope, format)
}

/** Import Markdown files from a directory as candidates. */
export async function importMarkdownDir(
  store: MemoryStore,
  scope: MemoryScope,
  directory: string
): Promise<{ imported: string[]; skipped: string[] }> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const records: MemoryRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = join(directory, entry.name)
    try {
      const text = await fs.readFile(file, 'utf8')
      records.push(parseMemoryFile(text, scope).record)
    } catch {
      // Malformed import files are skipped; the caller reports the count.
    }
  }
  return store.importRecords(scope, records)
}

/** Import one JSON backup. */
export async function importJsonFile(
  store: MemoryStore,
  scope: MemoryScope,
  file: string
): Promise<{ imported: string[]; skipped: string[] }> {
  const text = await fs.readFile(file, 'utf8')
  const parsed = JSON.parse(text) as { memories?: unknown }
  if (!Array.isArray(parsed.memories)) return { imported: [], skipped: [basename(file)] }
  return store.importRecords(scope, parsed.memories as MemoryRecord[])
}

/** Serialize a record for a `md` export entry. */
export function exportRecordMarkdown(record: MemoryRecord): { name: string; content: string } {
  return { name: `${record.id}.md`, content: serializeMemoryFile(record) }
}
