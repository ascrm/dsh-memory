import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore, type StoreHarness } from './helpers.ts'
import { MemoryStore } from '../src/store/store.ts'
import { memoriesDir, scopeDir } from '../src/store/paths.ts'
import type { MemoryScope } from '../src/types.ts'

const scope: MemoryScope = { type: 'project', key: 'repo-aaaaaaaaaaaa' }
let harness: StoreHarness | undefined

afterEach(async () => {
  if (harness !== undefined) await harness.cleanup()
  harness = undefined
})

describe('concurrency', () => {
  it('serializes two stores writing the same scope without losing memories', async () => {
    harness = await createStore()
    const first = new MemoryStore(harness.root, harness.config)
    const second = new MemoryStore(harness.root, harness.config)

    const writes = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const store = index % 2 === 0 ? first : second
        return store.write({
          slug: `parallel-${index}`,
          kind: 'fact',
          title: `Parallel ${index}`,
          summary: `Parallel memory ${index}`,
          body: 'body',
          scope
        })
      })
    )
    expect(new Set(writes.map((write) => write.record.id)).size).toBe(12)

    const docs = await first.list({ scope: 'project', projectScope: scope, limit: 50 })
    expect(docs).toHaveLength(12)
    const files = (await readdir(memoriesDir(harness.root, scope))).filter((name) => name.endsWith('.md'))
    expect(files).toHaveLength(12)
  })

  it('rejects concurrent writes to the same slug in one store', async () => {
    harness = await createStore()
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        harness!.store.write({
          slug: 'race',
          kind: 'fact',
          title: 'Race',
          summary: 'Race',
          body: 'body',
          scope
        })
      )
    )
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(3)
    expect(rejected.every((result) => (result.reason as { code?: string }).code === 'DUPLICATE_SLUG')).toBe(true)
  })

  it('recovers an orphan lock whose PID is dead', async () => {
    harness = await createStore()
    const store = new MemoryStore(harness.root, harness.config, { lockWaitMs: 60 })
    const dir = scopeDir(harness.root, scope)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.lock'), '999999\n')
    const result = await store.write({
      slug: 'after-orphan',
      kind: 'fact',
      title: 'After orphan',
      summary: 'Recovered',
      body: 'body',
      scope
    })
    expect(result.operation).toBe('created')
    const remaining = await readdir(dir)
    expect(remaining).not.toContain('index.lock')
  })
})
