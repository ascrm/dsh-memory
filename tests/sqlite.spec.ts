import { join } from 'node:path'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore, type StoreHarness } from './helpers.ts'
import { MemoryStore } from '../src/store/store.ts'
import type { MemoryScope } from '../src/types.ts'

const userScope: MemoryScope = { type: 'user' }
let harness: StoreHarness | undefined

afterEach(async () => {
  if (harness !== undefined) await harness.cleanup()
  harness = undefined
})

describe('SQLite FTS5 backend', () => {
  it('persists docs in index.sqlite and searches without parsing on cold start', async () => {
    harness = await createStore({ indexBackend: 'sqlite' })
    const written = await harness.store.write({
      slug: 'pnpm-build',
      kind: 'preference',
      title: 'Use pnpm',
      summary: 'Build the project with pnpm',
      body: 'Run pnpm build.',
      scope: userScope
    })
    await harness.store.write({
      slug: 'cjk-memory',
      kind: 'preference',
      title: '部署命令',
      summary: '部署使用 pnpm deploy',
      body: '部署流程',
      scope: userScope
    })
    expect((await stat(join(harness.root, 'user', 'index.sqlite'))).isFile()).toBe(true)
    await expect(stat(join(harness.root, 'user', 'index.json'))).rejects.toThrow()

    const hits = await harness.store.search({ query: 'pnpm build', scope: 'user' })
    expect(hits[0]?.id).toBe(written.record.id)
    const cjk = await harness.store.search({ query: '部署', scope: 'user' })
    expect(cjk.some((hit) => hit.slug === 'cjk-memory')).toBe(true)
    const unrelated = await harness.store.write({
      slug: 'sqlite-unrelated',
      kind: 'preference',
      title: 'Unrelated dashboard',
      summary: 'Deployment dashboard listens on port 9090',
      body: 'unrelated',
      scope: userScope
    })
    await harness.store.verify(unrelated.record.id, userScope)
    const fallback = await harness.store.search({ query: '部署', scope: 'user' })
    expect(fallback.some((hit) => hit.id === unrelated.record.id)).toBe(true)

    const reopened = new MemoryStore(harness.root, harness.config)
    try {
      const cold = await reopened.search({ query: 'pnpm build', scope: 'user' })
      expect(cold[0]?.id).toBe(written.record.id)
    } finally {
      reopened.close()
    }
  })

  it('detects changed files on validate and keeps usage counters in sqlite', async () => {
    harness = await createStore({ indexBackend: 'sqlite' })
    const written = await harness.store.write({
      slug: 'hand-edited',
      kind: 'preference',
      title: 'Hand edited',
      summary: 'Original summary',
      body: 'body',
      scope: userScope
    })
    const file = join(harness.root, 'user', 'memories', `${written.record.id}.md`)
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.replace('summary: Original summary', 'summary: Updated summary'))
    await harness.store.getScopeIndex(userScope, { validate: true })
    const hits = await harness.store.search({ query: 'updated summary', scope: 'user' })
    expect(hits.some((hit) => hit.summary === 'Updated summary')).toBe(true)

    await harness.store.touch(written.record.id, userScope)
    const reopened = new MemoryStore(harness.root, harness.config)
    try {
      const docs = await reopened.list({ scope: 'user' })
      expect(docs[0]?.useCount).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('rebuilds and removes deleted files', async () => {
    harness = await createStore({ indexBackend: 'sqlite' })
    const first = await harness.store.write({
      slug: 'first',
      kind: 'preference',
      title: 'First',
      summary: 'First memory',
      body: 'body',
      scope: userScope
    })
    await harness.store.forget(first.record.id, 'delete', userScope)
    const docs = await harness.store.list({ scope: 'user' })
    expect(docs).toHaveLength(0)
    const reopened = new MemoryStore(harness.root, harness.config)
    try {
      await reopened.refresh(userScope)
      expect(await reopened.list({ scope: 'user' })).toHaveLength(0)
    } finally {
      reopened.close()
    }
  })

  it('falls back to JSON when index.sqlite is unreadable', async () => {
    harness = await createStore({ indexBackend: 'sqlite' })
    await harness.store.write({
      slug: 'survives-corruption',
      kind: 'preference',
      title: 'Survives corruption',
      summary: 'Fallback should still find this memory',
      body: 'body',
      scope: userScope
    })
    harness.store.close()
    const file = join(harness.root, 'user', 'index.sqlite')
    await rm(`${file}-wal`, { force: true })
    await rm(`${file}-shm`, { force: true })
    await writeFile(file, 'not a sqlite database')
    const reopened = new MemoryStore(harness.root, harness.config)
    try {
      const hits = await reopened.search({ query: 'fallback find memory', scope: 'user' })
      expect(hits.some((hit) => hit.slug === 'survives-corruption')).toBe(true)
    } finally {
      reopened.close()
    }
  })
})
