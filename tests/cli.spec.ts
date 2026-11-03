import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { normalizeConfig } from '../src/config.ts'
import { MemoryStore } from '../src/store/store.ts'
import type { MemoryScope } from '../src/types.ts'

let root: string | undefined
let cwd: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  if (cwd !== undefined) await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  root = undefined
  cwd = undefined
})

async function setup(): Promise<{ root: string; cwd: string; store: MemoryStore }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-memory-cli-'))
  root = join(base, 'memory')
  cwd = join(base, 'project')
  await mkdir(cwd, { recursive: true })
  const config = normalizeConfig({ memoryDir: root })
  const store = new MemoryStore(root, config)
  await store.init()
  return { root, cwd, store }
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('CLI', () => {
  it('lists, searches, verifies, pins and shows a memory', async () => {
    const harness = await setup()
    const scope: MemoryScope = { type: 'user' }
    const written = await harness.store.write({
      slug: 'use-pnpm',
      kind: 'preference',
      title: 'Use pnpm',
      summary: 'The user prefers pnpm over npm',
      body: 'Always use pnpm.',
      scope
    })

    const list = await run(['--dir', harness.root, '--json', 'list'])
    expect(list.code).toBe(0)
    const parsed = JSON.parse(list.out) as { entries: Array<{ id: string; slug: string }> }
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.slug).toBe('use-pnpm')

    const search = await run(['--dir', harness.root, '--json', 'search', 'pnpm'])
    expect(search.code).toBe(0)
    const results = JSON.parse(search.out) as { results: Array<{ id: string }> }
    expect(results.results[0]?.id).toBe(written.record.id)

    const verify = await run(['--dir', harness.root, '--json', 'verify', written.record.id])
    expect(verify.code).toBe(0)
    const verified = JSON.parse(verify.out) as { trust: string }
    expect(verified.trust).toBe('verified')

    const pin = await run(['--dir', harness.root, '--json', 'pin', written.record.id])
    expect(pin.code).toBe(0)
    const pinned = JSON.parse(pin.out) as { pinned: boolean }
    expect(pinned.pinned).toBe(true)

    const show = await run(['--dir', harness.root, 'show', written.record.id])
    expect(show.code).toBe(0)
    expect(show.out).toContain('Always use pnpm.')
    expect(show.out).toContain('trust:     verified')
  })

  it('writes, edits, reviews and resolves conflicts from the CLI', async () => {
    const harness = await setup()
    const write = await run([
      '--dir',
      harness.root,
      '--json',
      'write',
      '--scope',
      'user',
      '--slug',
      'cli-write',
      '--kind',
      'preference',
      '--title',
      'CLI write',
      '--summary',
      'Use pnpm for the CLI test',
      '--body',
      'cli body'
    ])
    expect(write.code).toBe(0)
    const created = JSON.parse(write.out) as { id: string; trust: string }
    expect(created.trust).toBe('candidate')

    const edit = await run([
      '--dir',
      harness.root,
      '--json',
      'edit',
      created.id,
      '--summary',
      'Edited summary from CLI'
    ])
    expect(edit.code).toBe(0)
    expect((JSON.parse(edit.out) as { summary: string }).summary).toBe('Edited summary from CLI')

    const second = await run([
      '--dir',
      harness.root,
      '--json',
      'write',
      '--scope',
      'user',
      '--slug',
      'cli-conflict',
      '--kind',
      'preference',
      '--title',
      'CLI conflict',
      '--summary',
      'Edited summary from CLI',
      '--body',
      'other'
    ])
    const other = JSON.parse(second.out) as { id: string }
    const review = await run(['--dir', harness.root, '--json', 'review', '--scope', 'all'])
    expect(review.code).toBe(0)
    const queue = JSON.parse(review.out) as { conflicts: Array<{ id: string }> }
    expect(queue.conflicts.some((doc) => doc.id === created.id)).toBe(true)

    const resolved = await run([
      '--dir',
      harness.root,
      '--json',
      'resolve',
      created.id,
      other.id,
      '--mode',
      'merge',
      '--summary',
      'Merged by CLI'
    ])
    expect(resolved.code).toBe(0)
    const result = JSON.parse(resolved.out) as {
      keep: { summary: string }
      other: { trust: string }
    }
    expect(result.keep.summary).toBe('Merged by CLI')
    expect(result.other.trust).toBe('superseded')
  })

  it('exports to disk and imports Markdown back as candidates', async () => {
    const harness = await setup()
    const written = await harness.store.write({
      slug: 'export-me',
      kind: 'preference',
      title: 'Export me',
      summary: 'Verified preference',
      body: 'body',
      scope: { type: 'user' }
    })
    await harness.store.verify(written.record.id, { type: 'user' })
    const exportDir = join(cwd!, 'exported')

    const exported = await run([
      '--dir',
      harness.root,
      '--cwd',
      harness.cwd,
      'export',
      '--scope',
      'user',
      '--format',
      'md',
      '--out',
      exportDir
    ])
    expect(exported.code).toBe(0)
    expect((await stat(exportDir)).isDirectory()).toBe(true)
    const exportedFile = await readFile(join(exportDir, `${written.record.id}.md`), 'utf8')
    expect(exportedFile).toContain('slug: export-me')

    const importedRoot = join(cwd!, 'imported-memory')
    const imported = await run([
      '--dir',
      importedRoot,
      '--scope',
      'user',
      'import',
      exportDir
    ])
    expect(imported.code).toBe(0)
    const importedStore = new MemoryStore(importedRoot, normalizeConfig({ memoryDir: importedRoot }))
    const docs = await importedStore.list({ scope: 'user', limit: 10 })
    expect(docs).toHaveLength(1)
    expect(docs[0]?.trust).toBe('candidate')
  })

  it('reports doctor findings and rejects unknown options', async () => {
    const harness = await setup()
    const doctor = await run(['--dir', harness.root, '--json', 'doctor'])
    expect(doctor.code).toBe(0)
    expect(JSON.parse(doctor.out)).toMatchObject({ checked: 0, findings: [] })

    const fixed = await run(['--dir', harness.root, '--json', 'doctor', '--fix'])
    expect(fixed.code).toBe(0)
    expect(JSON.parse(fixed.out)).toMatchObject({ conflicts: { scanned: 0, marked: 0 } })

    const bad = await run(['--dir', harness.root, '--unknown'])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('未知选项')
  })
})
