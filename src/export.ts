/**
 * 导入/导出辅助函数。
 *
 * 导出永远不会改动源数据。AGENTS.md 的输出只包含已通过验证的
 * preference/constraint/decision 摘要，绝不包含正文。
 */
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { MemoryRecord, MemoryScope } from './types.ts'
import type { MemoryStore } from './store/store.ts'
import { parseMemoryFile, serializeMemoryFile } from './store/parse.ts'
import { singleLine } from './store/sanitize.ts'

/** 为一组记录渲染 AGENTS.md 片段。 */
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

/** 导出一个作用域。 */
export async function exportScope(store: MemoryStore, scope: MemoryScope, format: 'md' | 'agents' | 'json') {
  return store.exportScope(scope, format)
}

/** 从目录中导入 Markdown 文件，作为候选记忆。 */
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
      // 格式错误的导入文件会被跳过，由调用方报告数量。
    }
  }
  return store.importRecords(scope, records)
}

/** 导入一份 JSON 备份。 */
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

/** 为 `md` 导出条目序列化一条记录。 */
export function exportRecordMarkdown(record: MemoryRecord): { name: string; content: string } {
  return { name: `${record.id}.md`, content: serializeMemoryFile(record) }
}
