import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
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

describe('JSON incremental index', () => {
  it('updates docs, postings and sourceHash without rebuilding from disk', async () => {
    harness = await createStore()
    let firstId = ''
    for (let index = 0; index < 120; index += 1) {
      const { record } = await harness.store.write({
        slug: `incremental-${index}`,
        kind: 'preference',
        title: `Incremental ${index}`,
        summary: `Unique token alpha${index}`,
        body: `body ${index}`,
        scope: userScope
      })
      if (index === 0) firstId = record.id
    }
    const hit = await harness.store.search({ query: 'alpha0', scope: 'user' })
    expect(hit[0]?.id).toBe(firstId)

    await harness.store.write({
      id: firstId,
      slug: 'incremental-0',
      kind: 'preference',
      title: 'Incremental renamed',
      summary: 'Unique term omega0 after update',
      body: 'updated body',
      scope: userScope
    })
    expect(await harness.store.search({ query: 'alpha0', scope: 'user' })).toHaveLength(0)
    const updated = await harness.store.search({ query: 'omega0', scope: 'user' })
    expect(updated[0]?.id).toBe(firstId)
    expect(updated[0]?.summary).toBe('Unique term omega0 after update')

    const json = JSON.parse(await readFile(join(harness.root, 'user', 'index.json'), 'utf8')) as {
      files?: Record<string, unknown>
      docs: Record<string, unknown>
    }
    expect(Object.keys(json.files ?? {})).toHaveLength(120)
    expect(Object.keys(json.docs)).toHaveLength(120)

    const reopened = new MemoryStore(harness.root, harness.config)
    try {
      const cold = await reopened.search({ query: 'omega0', scope: 'user' })
      expect(cold[0]?.id).toBe(firstId)
      expect(await reopened.search({ query: 'alpha0', scope: 'user' })).toHaveLength(0)
    } finally {
      reopened.close()
    }

    await harness.store.forget(firstId, 'delete', userScope)
    expect((await harness.store.getScopeIndex(userScope)).docs.size).toBe(119)
    const after = JSON.parse(await readFile(join(harness.root, 'user', 'index.json'), 'utf8')) as {
      files?: Record<string, unknown>
      docs: Record<string, unknown>
    }
    expect(Object.keys(after.files ?? {})).toHaveLength(119)
    expect(Object.keys(after.docs)).toHaveLength(119)
  })
})
