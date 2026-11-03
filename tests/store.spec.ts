import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore, type StoreHarness } from './helpers.ts'
import { MemoryError, type MemoryScope } from '../src/types.ts'
import { memoriesDir } from '../src/store/paths.ts'
import { parseMemoryFile, serializeMemoryFile } from '../src/store/parse.ts'

const projectScope: MemoryScope = { type: 'project', key: 'repo-0123456789ab' }
const userScope: MemoryScope = { type: 'user' }

let harness: StoreHarness | undefined

async function setup(overrides = {}): Promise<StoreHarness> {
  harness = await createStore(overrides)
  return harness
}

afterEach(async () => {
  if (harness !== undefined) await harness.cleanup()
  harness = undefined
})

async function writePreference(store: StoreHarness['store'], overrides: Record<string, unknown> = {}) {
  return store.write({
    slug: 'use-pnpm',
    kind: 'preference',
    title: 'Use pnpm',
    summary: 'The user prefers pnpm over npm',
    body: 'Always use pnpm.',
    scope: userScope,
    tags: ['tooling'],
    ...overrides
  })
}

describe('write and read', () => {
  it('writes a candidate file and derived index', async () => {
    const { store, root } = await setup()
    const result = await writePreference(store)
    expect(result.operation).toBe('created')
    expect(result.record.trust).toBe('candidate')
    expect(result.record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    const file = join(memoriesDir(root, userScope), `${result.record.id}.md`)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('slug: use-pnpm')
    expect(text).toContain('trust: candidate')
    expect((await stat(join(root, 'user', 'index.json'))).isFile()).toBe(true)
    expect((await stat(join(root, 'user', 'index.md'))).isFile()).toBe(true)
  })

  it('reads by id and slug', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store)
    const byId = await store.locate(record.id, { scope: userScope })
    const bySlug = await store.locate('use-pnpm', { scope: userScope })
    expect(byId?.record.id).toBe(record.id)
    expect(bySlug?.record.summary).toBe(record.summary)
  })

  it('updates in place and keeps the id', async () => {
    const { store } = await setup()
    const first = await writePreference(store)
    const second = await store.write(
      {
        id: first.record.id,
        slug: 'use-pnpm',
        kind: 'preference',
        title: 'Use pnpm',
        summary: 'Updated summary',
        body: 'Updated body',
        scope: userScope
      },
      { actor: 'user' }
    )
    expect(second.operation).toBe('updated')
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.revision).toBe(2)
    expect(second.record.createdAt).toBe(first.record.createdAt)
    expect(second.record.tags).toEqual(['tooling'])
    expect(second.record.importance).toBe(first.record.importance)
  })

  it('rejects duplicate slugs with the existing id', async () => {
    const { store } = await setup()
    const first = await writePreference(store)
    await expect(
      store.write({
        slug: 'use-pnpm',
        kind: 'preference',
        title: 'Other',
        summary: 'Other',
        body: 'Other',
        scope: userScope
      })
    ).rejects.toMatchObject({ code: 'DUPLICATE_SLUG', details: { id: first.record.id } })
  })

  it('rejects user-scoped constraints and oversized bodies', async () => {
    const { store } = await setup({ maxBodyBytes: 32 })
    await expect(
      store.write({
        slug: 'no-deps',
        kind: 'constraint',
        title: 'No deps',
        summary: 'No new deps',
        body: 'x',
        scope: userScope
      })
    ).rejects.toMatchObject({ code: 'SCOPE_FORBIDDEN' })

    await expect(
      store.write({
        slug: 'long-body',
        kind: 'preference',
        title: 'Long',
        summary: 'Long',
        body: 'x'.repeat(64),
        scope: userScope
      })
    ).rejects.toBeInstanceOf(MemoryError)
  })
})

describe('trust lifecycle', () => {
  it('downgrades verified memories on content change and clears evidence', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store, { evidence: '以后都用 pnpm' })
    await store.verify(record.id, userScope)
    const verified = await store.locate(record.id, { scope: userScope })
    expect(verified?.record.trust).toBe('verified')
    expect(verified?.record.verifiedBy).toBe('user')

    const updated = await store.write({
      id: record.id,
      slug: 'use-pnpm',
      kind: 'preference',
      title: 'Use pnpm',
      summary: 'The user prefers pnpm over npm',
      body: 'A changed body',
      scope: userScope
    })
    expect(updated.record.trust).toBe('candidate')
    expect(updated.record.verifiedBy).toBeUndefined()
    expect(updated.record.evidence).toBeUndefined()
  })

  it('does not downgrade on a metadata-only write', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store)
    await store.verify(record.id, userScope)
    const updated = await store.write({
      id: record.id,
      slug: 'use-pnpm',
      kind: 'preference',
      title: 'Use pnpm',
      summary: 'The user prefers pnpm over npm',
      body: 'Always use pnpm.',
      scope: userScope,
      tags: ['tooling', 'new-tag']
    })
    expect(updated.record.trust).toBe('verified')
    expect(updated.record.revision).toBe(1)
  })

  it('pins only through the user operation', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store)
    expect(record.pinned).toBe(false)
    const pinned = await store.setPinned(record.id, true, userScope)
    expect(pinned.pinned).toBe(true)
    const reloaded = await store.locate(record.id, { scope: userScope })
    expect(reloaded?.record.pinned).toBe(true)
    const unpinned = await store.setPinned(record.id, false, userScope)
    expect(unpinned.pinned).toBe(false)
  })

  it('disputes, restores and supersedes', async () => {
    const { store } = await setup()
    const first = await writePreference(store)
    const disputed = await store.dispute(first.record.id, userScope)
    expect(disputed.trust).toBe('disputed')

    const restored = await store.restore(first.record.id, userScope)
    expect(restored.trust).toBe('candidate')

    const second = await writePreference(store, { slug: 'use-yarn', title: 'Use yarn', summary: 'Yarn instead' })
    await store.supersede(first.record.id, second.record.id, userScope)
    const old = await store.locate(first.record.id, { scope: userScope })
    const next = await store.locate(second.record.id, { scope: userScope })
    expect(old?.record.trust).toBe('superseded')
    expect(old?.record.supersededBy).toBe(second.record.id)
    expect(next?.record.supersedes).toBe(first.record.id)
  })

  it('marks conflicts on both sides and resolves keep/merge/both', async () => {
    const { store } = await setup()
    const first = await store.write({
      slug: 'pnpm-first',
      kind: 'preference',
      title: 'PNPM first',
      summary: 'Use pnpm for package management',
      body: 'body',
      scope: userScope
    })
    const second = await store.write({
      slug: 'pnpm-second',
      kind: 'preference',
      title: 'PNPM second',
      summary: 'Use pnpm for package management',
      body: 'body',
      scope: userScope
    })
    const firstLoc = await store.locate(first.record.id, { scope: userScope })
    const secondLoc = await store.locate(second.record.id, { scope: userScope })
    expect(firstLoc?.record.conflictOf).toContain(second.record.id)
    expect(secondLoc?.record.conflictOf).toContain(first.record.id)

    await store.resolveConflict(first.record.id, second.record.id, 'both')
    expect((await store.locate(first.record.id, { scope: userScope }))?.record.conflictOf).toBeUndefined()
    expect((await store.locate(second.record.id, { scope: userScope }))?.record.conflictOf).toBeUndefined()
    expect((await store.locate(second.record.id, { scope: userScope }))?.record.trust).toBe('candidate')

    const third = await store.write({
      slug: 'pnpm-third',
      kind: 'preference',
      title: 'PNPM third',
      summary: 'Use pnpm for package management',
      body: 'body',
      scope: userScope
    })
    const merged = await store.resolveConflict(first.record.id, third.record.id, 'merge', {
      summary: 'Merged pnpm guidance',
      tags: ['merged']
    })
    expect(merged.keep.summary).toBe('Merged pnpm guidance')
    expect(merged.keep.tags).toEqual(['merged'])
    expect(merged.other.trust).toBe('superseded')
    expect(merged.other.supersededBy).toBe(first.record.id)
    expect(merged.keep.supersedes).toBe(third.record.id)
    expect((await store.locate(third.record.id, { scope: userScope }))?.record.conflictOf).toBeUndefined()
  })
})

describe('forget', () => {
  it('mutes by default and keeps the file', async () => {
    const { store, root } = await setup()
    const { record } = await writePreference(store)
    await store.forget(record.id, 'mute', userScope)
    const muted = await store.locate(record.id, { scope: userScope })
    expect(muted?.record.muted).toBe(true)
    await stat(join(memoriesDir(root, userScope), `${record.id}.md`))
  })

  it('hard deletes the file', async () => {
    const { store, root } = await setup()
    const { record } = await writePreference(store)
    await store.forget(record.id, 'delete', userScope)
    await expect(stat(join(memoriesDir(root, userScope), `${record.id}.md`))).rejects.toThrow()
    expect(await store.locate(record.id, { scope: userScope })).toBeUndefined()
  })
})

describe('search and core', () => {
  it('ranks relevant project memories and excludes disputed by default', async () => {
    const { store } = await setup()
    const { record: pnpm } = await store.write({
      slug: 'pnpm-build',
      kind: 'fact',
      title: 'Build uses pnpm',
      summary: 'Run the build with pnpm',
      body: 'pnpm build',
      scope: projectScope
    })
    await store.write({
      slug: 'database',
      kind: 'fact',
      title: 'Database',
      summary: 'Postgres runs locally',
      body: 'docker compose up postgres',
      scope: projectScope
    })
    const hits = await store.search({ query: 'pnpm build', scope: 'project', projectScope })
    expect(hits[0]?.id).toBe(pnpm.id)

    await store.dispute(pnpm.id, projectScope)
    const normal = await store.search({ query: 'pnpm build', scope: 'project', projectScope })
    expect(normal.some((hit) => hit.id === pnpm.id)).toBe(false)
    const withDisputed = await store.search({
      query: 'pnpm build',
      scope: 'project',
      projectScope,
      includeDisputed: true
    })
    expect(withDisputed.some((hit) => hit.id === pnpm.id)).toBe(true)
  })

  it('returns [] for an empty query', async () => {
    const { store } = await setup()
    await writePreference(store)
    expect(await store.search({ query: '   ', scope: 'all', projectScope })).toEqual([])
  })

  it('fills the head with metadata-ranked memories when keyword hits are scarce', async () => {
    const { store } = await setup()
    const keyword = await writePreference(store)
    const metadataOnly = await store.write({
      slug: 'dashboard',
      kind: 'artifact',
      title: 'Dashboard',
      summary: 'Monitoring dashboard URL',
      body: 'https://example.com/dashboard',
      scope: userScope,
      importance: 10
    })
    const hits = await store.search({ query: 'pnpm', scope: 'user', limit: 8 })
    expect(hits.some((hit) => hit.id === keyword.record.id)).toBe(true)
    expect(hits.some((hit) => hit.id === metadataOnly.record.id)).toBe(true)
  })

  it('only injects verified records and honors the budget', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store)
    expect(await store.coreRecords()).toHaveLength(1)
    expect((await store.coreRecords())[0]?.trust).toBe('candidate')
    await store.verify(record.id, userScope)
    const records = await store.coreRecords()
    expect(records[0]?.trust).toBe('verified')
  })

  it('updates useCount without changing updatedAt', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store)
    await store.touch(record.id, userScope)
    const touched = await store.locate(record.id, { scope: userScope })
    expect(touched?.record.useCount).toBe(1)
    expect(touched?.record.updatedAt).toBe(record.updatedAt)
    expect(touched?.record.lastUsedAt).toBeGreaterThanOrEqual(record.updatedAt)
  })
})

describe('index robustness', () => {
  it('rebuilds after an external hand edit', async () => {
    const { store, root } = await setup()
    const { record } = await writePreference(store)
    const file = join(memoriesDir(root, userScope), `${record.id}.md`)
    const text = await readFile(file, 'utf8')
    const changed = text.replace('summary: The user prefers pnpm over npm', 'summary: Hand-edited summary')
    await writeFile(file, changed)
    await store.getScopeIndex(userScope, { validate: true })
    const hits = await store.search({ query: 'hand edited summary', scope: 'user' })
    expect(hits.some((hit) => hit.summary === 'Hand-edited summary')).toBe(true)
  })

  it('skips malformed files and reports them', async () => {
    const { store, root } = await setup()
    await writePreference(store)
    const dir = memoriesDir(root, userScope)
    await writeFile(join(dir, 'broken.md'), '---\nslug: [unclosed\n---\n')
    const { records, malformed } = await store.recordsOf(userScope)
    expect(records).toHaveLength(1)
    expect(malformed).toHaveLength(1)
  })

  it('repairs a file whose ULID filename has no id in frontmatter', async () => {
    const { store, root } = await setup()
    const id = '01JABCDEFGHJKMNPQRSTVWXYZ9'
    const dir = memoriesDir(root, userScope)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${id}.md`),
      `---
schemaVersion: 1
slug: repaired
kind: fact
title: Repaired
summary: Repaired file
---

body
`
    )
    const index = await store.getScopeIndex(userScope)
    expect(index.docs.has(id)).toBe(true)
    const text = await readFile(join(dir, `${id}.md`), 'utf8')
    expect(text).toContain(`id: ${id}`)
  })

  it('deletes and rebuilds index.json', async () => {
    const { store, root } = await setup()
    await writePreference(store)
    await rm(join(root, 'user', 'index.json'), { force: true })
    const index = await store.getScopeIndex(userScope, { refresh: true })
    expect(index.docs.size).toBe(1)
    expect((await stat(join(root, 'user', 'index.json'))).isFile()).toBe(true)
  })
})

describe('project metadata and export', () => {
  it('writes project.json for a git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-proj-'))
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(
        join(root, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/service.git\n'
      )
      const store = (await createStore()).store
      try {
        const scope = store.scopeForCwd(root)
        await store.ensureProject(scope, root)
        const metadata = JSON.parse(
          await readFile(join(store.root, 'projects', (scope as { key: string }).key, 'project.json'), 'utf8')
        ) as Record<string, unknown>
        expect(metadata.remote).toBe('github.com/acme/service')
        expect(metadata.label).toBe(root.split(/[\\/]/).pop())
        expect(metadata.key).toBe((scope as { key: string }).key)
      } finally {
        await store.audit.flush()
        await rm(store.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it('exports markdown, json and an AGENTS fragment with verified summaries only', async () => {
    const { store } = await setup()
    const { record } = await writePreference(store)
    await store.verify(record.id, userScope)
    await store.write({
      slug: 'candidate',
      kind: 'preference',
      title: 'Candidate',
      summary: 'Not verified',
      body: 'body',
      scope: userScope
    })

    const markdown = await store.exportScope(userScope, 'md')
    expect(markdown.files).toHaveLength(2)
    expect(markdown.files?.[0]?.content).toContain('slug:')

    const json = await store.exportScope(userScope, 'json')
    const parsed = JSON.parse(json.content ?? '{}') as { memories: unknown[] }
    expect(parsed.memories).toHaveLength(2)

    const agents = await store.exportScope(userScope, 'agents')
    expect(agents.content).toContain('Use pnpm')
    expect(agents.content).not.toContain('Not verified')
  })

  it('imports records as candidates, preserves free ids and skips duplicate slugs', async () => {
    const { store } = await setup()
    const importedId = '01JABCDEFGHJKMNPQRSTVWXYZ7'
    const result = await store.importRecords(userScope, [
      { id: importedId, slug: 'imported', kind: 'preference', title: 'Imported', summary: 'Imported summary', body: 'b' },
      { slug: 'imported', kind: 'preference', title: 'Imported again', summary: 'Duplicate', body: 'b' }
    ])
    expect(result.imported).toEqual([importedId])
    expect(result.skipped).toHaveLength(1)
    const located = await store.locate(result.imported[0]!, { scope: userScope })
    expect(located?.record.id).toBe(importedId)
    expect(located?.record.trust).toBe('candidate')
  })
})

describe('doctor and schema', () => {
  it('reports duplicate slugs and broken supersede links', async () => {
    const { store, root } = await setup()
    const { record } = await writePreference(store)
    const dir = memoriesDir(root, userScope)
    const clone = parseMemoryFile(await readFile(join(dir, `${record.id}.md`), 'utf8'), userScope).record
    clone.id = '01JABCDEFGHJKMNPQRSTVWXYZ8'
    clone.supersededBy = '01JABCDEFGHJKMNPQRSTVWXYZ7'
    await writeFile(join(dir, `${clone.id}.md`), serializeMemoryFile(clone))

    const report = await store.doctor()
    expect(report.findings.some((finding) => finding.code === 'DUPLICATE_SLUG')).toBe(true)
    expect(report.findings.some((finding) => finding.code === 'BROKEN_SUPERSEDE_LINK')).toBe(true)
  })
})
