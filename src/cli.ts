#!/usr/bin/env node
/**
 * dsh-memory 的命令行工具。
 *
 * 面向命令行和脚本用户：直接操作同一个 $DSH_HOME/memory 存储。
 * 所有写操作仍然走 MemoryStore，因此锁、原子写、审计和信任规则与插件完全一致。
 */
import { promises as fs, realpathSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, resolveMemoryDir } from './config.ts'
import { MemoryStore } from './store/store.ts'
import { MEMORY_KINDS, MemoryError, type MemoryKind, type MemoryMergeInput, type MemoryRecord, type MemoryScope } from './types.ts'
import { selectCore } from './injection/core.ts'
import { exportScope, importJsonFile, importMarkdownDir } from './export.ts'

/** 输出目标，便于测试时注入。 */
export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const VALUE_FLAGS = new Set([
  'dir',
  'cwd',
  'scope',
  'kind',
  'limit',
  'format',
  'out',
  'mode',
  'slug',
  'title',
  'summary',
  'body',
  'body-file',
  'tags',
  'importance',
  'evidence'
])
const BOOLEAN_FLAGS = new Set(['json', 'hard', 'all', 'disputed', 'help', 'version', 'fix'])

interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: Map<string, string | true>
}

function usage(): string {
  return `用法: dsh-memory [选项] <命令> [参数]

全局选项:
  --dir <path>      记忆根目录（默认 $DSH_HOME/memory）
  --cwd <path>      项目目录（默认当前目录）
  --json            以 JSON 输出
  --help            显示帮助

命令:
  list              列出记忆摘要
  search <query>    检索记忆
  show <id|slug>    查看一条记忆
  write --slug <s> --title <t> --summary <s> [--kind <k>] [--body <b>|--body-file <p>]
  edit <id|slug> [--title <t>] [--summary <s>] [--body <b>|--body-file <p>]
  review [--scope user|project|all]  列出待审核候选/冲突
  verify <id|slug>  标记为已验证（用户操作）
  dispute <id|slug> 标记为有争议
  restore <id|slug> 恢复为 candidate
  pin <id|slug>     置顶
  unpin <id|slug>   取消置顶
  forget <id|slug>  静音（--hard 永久删除）
  resolve <keep> <other> [--mode keep|merge|both] [--summary <s>] [--body <b>]  解决冲突
  supersede <old> <new>  标记旧记忆被新记忆取代
  refresh           重建索引
  core              打印当前核心层
  stats             统计信息
  doctor            一致性检查（--fix 同时扫描历史冲突）
  export [--scope user|project] [--format md|json|agents] [--out <path>]
  import <path> [--scope user|project]
  version           显示版本
`
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  let command: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token === '-h') {
      flags.set('help', true)
      continue
    }
    if (token === '-v') {
      flags.set('version', true)
      continue
    }
    if (!token.startsWith('--')) {
      if (command === undefined) command = token
      else positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    if (name.length === 0) throw new Error('无效的选项')
    if (VALUE_FLAGS.has(name)) {
      let value: string | undefined
      if (equals !== -1) {
        value = token.slice(equals + 1)
      } else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) throw new Error(`选项 --${name} 需要一个值`)
        value = next
        i += 1
      }
      flags.set(name, value)
      continue
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) throw new Error(`选项 --${name} 不接受值`)
      flags.set(name, true)
      continue
    }
    throw new Error(`未知选项: --${name}`)
  }
  return { command, positionals, flags }
}

function jsonIo(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2))
}

function textOut(io: CliIo, flags: Map<string, string | true>, value: unknown, text: string): void {
  if (flags.get('json') === true) jsonIo(io, value)
  else io.out(text)
}

function limitOf(flags: Map<string, string | true>, fallback: number): number {
  const raw = flags.get('limit')
  if (raw === undefined || raw === true) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--limit 必须是正整数')
  return parsed
}

function scopeOf(flags: Map<string, string | true>, fallback: 'user' | 'project' | 'all'): 'user' | 'project' | 'all' {
  const raw = flags.get('scope')
  if (raw === undefined || raw === true) return fallback
  if (raw === 'user' || raw === 'project' || raw === 'all') return raw
  throw new Error('--scope 只能是 user、project 或 all')
}

function projectScope(store: MemoryStore, cwd: string): MemoryScope {
  return store.scopeForCwd(cwd)
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]
  if (id === undefined || id.length === 0) throw new Error(`${command} 需要一个 id 或 slug`)
  return id
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function requireFlag(flags: Map<string, string | true>, name: string, command: string): string {
  const value = flagString(flags, name)
  if (value === undefined || value.length === 0) throw new Error(`${command} 需要 --${name}`)
  return value
}

function tagsOf(flags: Map<string, string | true>): string[] | undefined {
  const raw = flagString(flags, 'tags')
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function importanceOf(flags: Map<string, string | true>): number | undefined {
  const raw = flagString(flags, 'importance')
  if (raw === undefined) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new Error('--importance 必须是 1..10')
  }
  return value
}

async function bodyOf(flags: Map<string, string | true>, cwd: string): Promise<string | undefined> {
  const bodyFile = flagString(flags, 'body-file')
  if (bodyFile !== undefined) return fs.readFile(resolve(cwd, bodyFile), 'utf8')
  return flagString(flags, 'body')
}

function writeScope(store: MemoryStore, flags: Map<string, string | true>, cwd: string): MemoryScope {
  const scope = scopeOf(flags, 'user')
  if (scope === 'all') throw new Error('write/edit 需要 --scope user 或 --scope project')
  return scope === 'user' ? { type: 'user' } : projectScope(store, cwd)
}

function formatScope(scope: MemoryScope): string {
  return scope.type === 'user' ? 'user' : `project:${scope.key}`
}

function formatLocate(record: MemoryRecord): string {
  const lines = [
    `id:        ${record.id}`,
    `slug:      ${record.slug}`,
    `kind:      ${record.kind}`,
    `trust:     ${record.trust}`,
    `scope:     ${formatScope(record.scope)}`,
    `title:     ${record.title}`,
    `summary:   ${record.summary}`,
    `tags:      ${record.tags.join(', ') || '(none)'}`,
    `importance:${record.importance}`,
    `pinned:    ${record.pinned}`,
    `muted:     ${record.muted}`,
    `revision:  ${record.revision}`,
    `createdAt: ${new Date(record.createdAt).toISOString()}`,
    `updatedAt: ${new Date(record.updatedAt).toISOString()}`,
    `source:    ${JSON.stringify(record.source)}`
  ]
  if (record.evidence !== undefined) lines.push(`evidence:  "${record.evidence.quote}"`)
  if (record.supersededBy !== undefined) lines.push(`supersededBy: ${record.supersededBy}`)
  if ((record.conflictOf?.length ?? 0) > 0) lines.push(`conflictOf: ${record.conflictOf!.join(', ')}`)
  lines.push('', record.body)
  return lines.join('\n')
}

async function readVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * CLI 主函数。返回进程退出码；测试可注入 io。
 */
export async function main(argv: string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error))
    io.err(usage())
    return 2
  }

  if (parsed.flags.get('version') === true || parsed.command === 'version') {
    io.out(await readVersion())
    return 0
  }
  if (parsed.flags.get('help') === true || parsed.command === undefined || parsed.command === 'help') {
    io.out(usage())
    return 0
  }

  const command = parsed.command
  if (command === undefined) return 0

  const dirFlag = parsed.flags.get('dir')
  const cwdFlag = parsed.flags.get('cwd')
  const config = normalizeConfig({ memoryDir: typeof dirFlag === 'string' ? dirFlag : undefined })
  const root = resolveMemoryDir(config)
  const cwd = resolve(typeof cwdFlag === 'string' ? cwdFlag : process.cwd())
  let store: MemoryStore
  try {
    store = new MemoryStore(root, config, { warn: (message) => io.err(`[warn] ${message}`) })
    await store.init()
  } catch (error) {
    io.err(`无法初始化记忆库 ${root}: ${String(error instanceof Error ? error.message : error)}`)
    return 1
  }

  try {
    switch (command) {
      case 'list': {
        const scope = scopeOf(parsed.flags, 'all')
        const kindFlag = parsed.flags.get('kind')
        const kind =
          typeof kindFlag === 'string' && MEMORY_KINDS.includes(kindFlag as MemoryKind)
            ? (kindFlag as MemoryKind)
            : undefined
        const docs = await store.list({
          scope,
          projectScope: projectScope(store, cwd),
          kind,
          includeAll: parsed.flags.get('all') === true,
          limit: limitOf(parsed.flags, 20)
        })
        textOut(
          io,
          parsed.flags,
          { entries: docs },
          docs.length === 0
            ? '没有记忆。'
            : docs.map((doc) => `${doc.id}  ${doc.trust.padEnd(10)} ${doc.kind.padEnd(10)} ${doc.scope}  ${doc.title} — ${doc.summary}`).join('\n')
        )
        return 0
      }

      case 'search': {
        const query = parsed.positionals.join(' ').trim()
        if (query.length === 0) throw new Error('search 需要一个查询字符串')
        const scope = scopeOf(parsed.flags, 'all')
        const kindFlag = parsed.flags.get('kind')
        const kinds =
          typeof kindFlag === 'string'
            ? kindFlag
                .split(',')
                .map((item) => item.trim())
                .filter((item): item is MemoryKind => MEMORY_KINDS.includes(item as MemoryKind))
            : undefined
        const hits = await store.search({
          query,
          scope,
          projectScope: projectScope(store, cwd),
          kinds: kinds !== undefined && kinds.length > 0 ? kinds : undefined,
          limit: limitOf(parsed.flags, 8),
          includeDisputed: parsed.flags.get('disputed') === true,
          actor: 'user'
        })
        textOut(
          io,
          parsed.flags,
          { results: hits },
          hits.length === 0
            ? '没有匹配的记忆。'
            : hits.map((hit) => `${hit.score.toFixed(3)}  ${hit.id}  ${hit.trust}  ${hit.kind}  ${hit.title} — ${hit.summary}`).join('\n')
        )
        return 0
      }

      case 'show': {
        const located = await store.locate(requireId(parsed.positionals, 'show'), { allProjects: true })
        if (located === undefined) throw new MemoryError('NOT_FOUND', '记忆不存在')
        textOut(io, parsed.flags, located.record, formatLocate(located.record))
        return 0
      }

      case 'write': {
        const slug = requireFlag(parsed.flags, 'slug', 'write')
        const title = requireFlag(parsed.flags, 'title', 'write')
        const summary = requireFlag(parsed.flags, 'summary', 'write')
        const kindRaw = flagString(parsed.flags, 'kind') ?? 'preference'
        if (!MEMORY_KINDS.includes(kindRaw as MemoryKind)) {
          throw new Error(`--kind 必须是 ${MEMORY_KINDS.join(', ')}`)
        }
        const result = await store.write({
          slug,
          kind: kindRaw as MemoryKind,
          title,
          summary,
          body: (await bodyOf(parsed.flags, cwd)) ?? '',
          tags: tagsOf(parsed.flags),
          importance: importanceOf(parsed.flags),
          evidence: flagString(parsed.flags, 'evidence'),
          scope: writeScope(store, parsed.flags, cwd),
          source: { tool: 'dsh-memory-cli' }
        })
        textOut(io, parsed.flags, result.record, `${result.record.id}  trust=${result.record.trust}`)
        return 0
      }

      case 'edit': {
        const located = await store.locate(requireId(parsed.positionals, 'edit'), { allProjects: true })
        if (located === undefined) throw new MemoryError('NOT_FOUND', '记忆不存在')
        const kindRaw = flagString(parsed.flags, 'kind') ?? located.record.kind
        if (!MEMORY_KINDS.includes(kindRaw as MemoryKind)) {
          throw new Error(`--kind 必须是 ${MEMORY_KINDS.join(', ')}`)
        }
        const body = await bodyOf(parsed.flags, cwd)
        const result = await store.write({
          id: located.record.id,
          slug: flagString(parsed.flags, 'slug') ?? located.record.slug,
          kind: kindRaw as MemoryKind,
          title: flagString(parsed.flags, 'title') ?? located.record.title,
          summary: flagString(parsed.flags, 'summary') ?? located.record.summary,
          body: body ?? located.record.body,
          tags: tagsOf(parsed.flags) ?? located.record.tags,
          importance: importanceOf(parsed.flags) ?? located.record.importance,
          evidence: flagString(parsed.flags, 'evidence'),
          scope: located.scope
        })
        textOut(io, parsed.flags, result.record, `${result.record.id}  trust=${result.record.trust}`)
        return 0
      }

      case 'review': {
        const scope = scopeOf(parsed.flags, 'project')
        const review = await store.review(
          scope === 'all' ? undefined : scope === 'user' ? { type: 'user' } : projectScope(store, cwd),
          scope
        )
        textOut(
          io,
          parsed.flags,
          review,
          [
            `候选: ${review.candidates.length}`,
            ...review.candidates.map((doc) => `  ${doc.id}  ${doc.title} — ${doc.summary}`),
            `冲突: ${review.conflicts.length}`,
            ...review.conflicts.map((doc) => `  ${doc.id}  conflictOf=${(doc.conflictOf ?? []).join(',')}`)
          ].join('\n')
        )
        return 0
      }

      case 'verify':
      case 'dispute':
      case 'restore': {
        const located = await store.locate(requireId(parsed.positionals, command), { allProjects: true })
        if (located === undefined) throw new MemoryError('NOT_FOUND', '记忆不存在')
        const record =
          command === 'verify'
            ? await store.verify(located.record.id, located.scope)
            : command === 'dispute'
              ? await store.dispute(located.record.id, located.scope)
              : await store.restore(located.record.id, located.scope)
        textOut(io, parsed.flags, record, `${record.id}  trust=${record.trust}`)
        return 0
      }

      case 'pin':
      case 'unpin': {
        const located = await store.locate(requireId(parsed.positionals, command), { allProjects: true })
        if (located === undefined) throw new MemoryError('NOT_FOUND', '记忆不存在')
        const record = await store.setPinned(located.record.id, command === 'pin', located.scope)
        textOut(io, parsed.flags, record, `${record.id}  pinned=${record.pinned}`)
        return 0
      }

      case 'forget': {
        const located = await store.locate(requireId(parsed.positionals, 'forget'), { allProjects: true })
        if (located === undefined) throw new MemoryError('NOT_FOUND', '记忆不存在')
        const hard = parsed.flags.get('hard') === true
        await store.forget(located.record.id, hard ? 'delete' : 'mute', located.scope)
        textOut(io, parsed.flags, { id: located.record.id, mode: hard ? 'delete' : 'mute' }, hard ? '已永久删除。' : '已静音（文件保留）。')
        return 0
      }

      case 'resolve': {
        const keepId = requireId(parsed.positionals, 'resolve')
        const otherId = parsed.positionals[1]
        if (otherId === undefined) throw new Error('resolve 需要保留方和另一方两个 id')
        const modeFlag = parsed.flags.get('mode')
        const mode = modeFlag === 'merge' || modeFlag === 'both' ? modeFlag : 'keep'
        const merged: MemoryMergeInput = {}
        const title = flagString(parsed.flags, 'title')
        const summary = flagString(parsed.flags, 'summary')
        const body = await bodyOf(parsed.flags, cwd)
        const tags = tagsOf(parsed.flags)
        const importance = importanceOf(parsed.flags)
        const evidence = flagString(parsed.flags, 'evidence')
        if (title !== undefined) merged.title = title
        if (summary !== undefined) merged.summary = summary
        if (body !== undefined) merged.body = body
        if (tags !== undefined) merged.tags = tags
        if (importance !== undefined) merged.importance = importance
        if (evidence !== undefined) merged.evidence = evidence
        const result = await store.resolveConflict(keepId, otherId, mode, merged)
        textOut(
          io,
          parsed.flags,
          {
            keep: { id: result.keep.id, trust: result.keep.trust, summary: result.keep.summary },
            other: { id: result.other.id, trust: result.other.trust }
          },
          `已解决冲突（${mode}）：保留 ${result.keep.id}，另一方状态 ${result.other.trust}`
        )
        return 0
      }

      case 'supersede': {
        const oldId = requireId(parsed.positionals, 'supersede')
        const newId = parsed.positionals[1]
        if (newId === undefined) throw new Error('supersede 需要旧 id 和新 id')
        const oldLocated = await store.locate(oldId, { allProjects: true })
        const newLocated = await store.locate(newId, { allProjects: true })
        if (oldLocated === undefined || newLocated === undefined) throw new MemoryError('NOT_FOUND', '记忆不存在')
        await store.supersede(oldLocated.record.id, newLocated.record.id, oldLocated.scope)
        textOut(io, parsed.flags, { oldId: oldLocated.record.id, newId: newLocated.record.id }, '已标记取代关系。')
        return 0
      }

      case 'refresh': {
        const scope = scopeOf(parsed.flags, 'all')
        const result =
          scope === 'all'
            ? await store.refresh()
            : await store.refresh(scope === 'user' ? { type: 'user' } : projectScope(store, cwd))
        textOut(io, parsed.flags, result, result.scopes.map((item) => `${item.scope}: ${item.docs} 条`).join('\n'))
        return 0
      }

      case 'core': {
        const scope = scopeOf(parsed.flags, 'project')
        const project = scope === 'user' ? undefined : projectScope(store, cwd)
        const records = await store.coreRecords(project)
        const pack = selectCore(records, config, Date.now(), project)
        textOut(io, parsed.flags, pack, pack.text.length > 0 ? pack.text : '(核心层为空)')
        return 0
      }

      case 'stats': {
        const scope = scopeOf(parsed.flags, 'all')
        const target =
          scope === 'user'
            ? ({ type: 'user' } as MemoryScope)
            : scope === 'project'
              ? projectScope(store, cwd)
              : undefined
        const result = await store.stats(target)
        textOut(io, parsed.flags, result, JSON.stringify(result, null, 2))
        return 0
      }

      case 'doctor': {
        const scope = scopeOf(parsed.flags, 'all')
        const target =
          scope === 'user'
            ? ({ type: 'user' } as MemoryScope)
            : scope === 'project'
              ? projectScope(store, cwd)
              : undefined
        const result = await store.doctor(target)
        const fix = parsed.flags.get('fix') === true
        const scan = fix ? await store.scanConflicts(target, { mark: true }) : undefined
        const text =
          result.findings.length === 0
            ? `检查 ${result.checked} 条记忆，未发现问题。`
            : result.findings
                .map((finding) => `[${finding.level}] ${finding.code}${finding.scope !== undefined ? ` (${finding.scope})` : ''}: ${finding.message}`)
                .join('\n')
        const merged =
          scan === undefined
            ? text
            : `${text}\n扫描冲突 ${scan.pairs.length} 对，标记 ${scan.marked} 对。`
        textOut(io, parsed.flags, scan === undefined ? result : { ...result, conflicts: scan }, merged)
        return result.findings.some((finding) => finding.level === 'error') ? 1 : 0
      }

      case 'export': {
        const scope = scopeOf(parsed.flags, 'project')
        if (scope === 'all') throw new Error('export 需要 --scope user 或 --scope project')
        const formatFlag = parsed.flags.get('format')
        const format = formatFlag === 'md' || formatFlag === 'agents' ? formatFlag : 'json'
        const target = scope === 'user' ? ({ type: 'user' } as MemoryScope) : projectScope(store, cwd)
        const result = await exportScope(store, target, format)
        const outFlag = parsed.flags.get('out')
        if (typeof outFlag === 'string') {
          const output = resolve(cwd, outFlag)
          if (format === 'md') {
            await fs.mkdir(output, { recursive: true })
            for (const file of result.files ?? []) {
              await fs.writeFile(resolve(output, file.name), file.content, 'utf8')
            }
            textOut(io, parsed.flags, { output, files: result.files?.length ?? 0 }, `已导出 ${result.files?.length ?? 0} 个文件到 ${output}`)
          } else {
            await fs.mkdir(dirname(output), { recursive: true })
            await fs.writeFile(output, result.content ?? '', 'utf8')
            textOut(io, parsed.flags, { output }, `已导出到 ${output}`)
          }
        } else if (format === 'md') {
          for (const file of result.files ?? []) io.out(`=== ${file.name} ===\n${file.content}`)
        } else {
          io.out(result.content ?? '')
        }
        return 0
      }

      case 'import': {
        const targetPath = parsed.positionals[0]
        if (targetPath === undefined) throw new Error('import 需要一个文件或目录路径')
        const scope = scopeOf(parsed.flags, 'project')
        if (scope === 'all') throw new Error('import 需要 --scope user 或 --scope project')
        const target = scope === 'user' ? ({ type: 'user' } as MemoryScope) : projectScope(store, cwd)
        const fullPath = resolve(cwd, targetPath)
        const info = await fs.stat(fullPath)
        const result = info.isDirectory()
          ? await importMarkdownDir(store, target, fullPath)
          : extname(fullPath).toLowerCase() === '.json'
            ? await importJsonFile(store, target, fullPath)
            : (() => {
                throw new Error('import 只支持 Markdown 目录或 JSON 文件')
              })()
        textOut(io, parsed.flags, result, `导入 ${result.imported.length} 条，跳过 ${result.skipped.length} 条。`)
        return 0
      }

      default:
        io.err(`未知命令: ${command}`)
        io.err(usage())
        return 2
    }
  } catch (error) {
    if (error instanceof MemoryError) io.err(error.message)
    else io.err(String(error instanceof Error ? error.message : error))
    return 1
  } finally {
    await store.audit.flush()
    store.close()
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const canonical = (value: string): string => {
    try {
      return realpathSync(value)
    } catch {
      return resolve(value)
    }
  }
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  return normalize(canonical(entry)) === normalize(canonical(fileURLToPath(import.meta.url)))
}

if (isEntryPoint()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(String(error))
      process.exitCode = 1
    }
  )
}
