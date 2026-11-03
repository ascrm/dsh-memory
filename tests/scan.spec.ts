import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore, type StoreHarness } from './helpers.ts'
import type { MemoryScope } from '../src/types.ts'

const userScope: MemoryScope = { type: 'user' }
let harness: StoreHarness | undefined

afterEach(async () => {
  if (harness !== undefined) await harness.cleanup()
  harness = undefined
})

function historical(id: string, slug: string, summary: string): string {
  return `---
schemaVersion: 1
id: ${id}
slug: ${slug}
kind: preference
scope: user
title: ${slug}
summary: ${summary}
tags: []
trust: verified
importance: 5
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
useCount: 0
source: {}
pinned: false
muted: false
revision: 1
---

body
`
}

describe('historical conflict scan', () => {
  it('finds and marks conflicts that predate conflict detection', async () => {
    harness = await createStore()
    const dir = join(harness.root, 'user', 'memories')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, '01JABCDEFGHJKMNPQRSTVWXYZ1.md'),
      historical('01JABCDEFGHJKMNPQRSTVWXYZ1', 'scan-a', 'Deploy the service with pnpm')
    )
    await writeFile(
      join(dir, '01JABCDEFGHJKMNPQRSTVWXYZ2.md'),
      historical('01JABCDEFGHJKMNPQRSTVWXYZ2', 'scan-b', 'Deploy the service with pnpm')
    )
    const result = await harness.store.scanConflicts(userScope, { mark: true })
    expect(result.scanned).toBe(2)
    expect(result.pairs).toHaveLength(1)
    expect(result.marked).toBe(1)
    const first = await harness.store.locate('01JABCDEFGHJKMNPQRSTVWXYZ1', { scope: userScope })
    const second = await harness.store.locate('01JABCDEFGHJKMNPQRSTVWXYZ2', { scope: userScope })
    expect(first?.record.conflictOf).toContain('01JABCDEFGHJKMNPQRSTVWXYZ2')
    expect(second?.record.conflictOf).toContain('01JABCDEFGHJKMNPQRSTVWXYZ1')
    const review = await harness.store.review(userScope, 'user')
    expect(review.conflicts).toHaveLength(2)
  })
})
