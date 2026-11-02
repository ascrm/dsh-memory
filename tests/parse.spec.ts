import { describe, expect, it } from 'vitest'
import { parseMemoryFile, serializeMemoryFile } from '../src/store/parse.ts'
import { SCHEMA_VERSION, type MemoryRecord, type MemoryScope } from '../src/types.ts'

const userScope: MemoryScope = { type: 'user' }

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    slug: 'use-pnpm',
    kind: 'preference',
    scope: userScope,
    title: '使用 pnpm',
    summary: '用户偏好 pnpm，不使用 npm',
    body: '用户明确要求使用 pnpm。\n\n相关：[[mem_01JABCDEFGHJKMNPQRSTVWXYZ1]]',
    tags: ['tooling', 'package-manager'],
    source: { sessionId: '01JSESSION', tool: 'memory_write' },
    evidence: { quote: '以后都用 pnpm', hash: 'abc' },
    trust: 'verified',
    importance: 9,
    createdAt: Date.UTC(2026, 10, 2, 9, 0, 0),
    updatedAt: Date.UTC(2026, 10, 2, 9, 5, 0),
    lastUsedAt: Date.UTC(2026, 10, 2, 9, 6, 0),
    useCount: 3,
    pinned: true,
    muted: false,
    verifiedBy: 'user',
    verifiedAt: Date.UTC(2026, 10, 2, 9, 5, 0),
    revision: 2,
    ...overrides
  }
}

describe('frontmatter round trip', () => {
  it('preserves every known field', () => {
    const original = record()
    const parsed = parseMemoryFile(serializeMemoryFile(original), userScope)
    expect(parsed.record).toMatchObject({
      id: original.id,
      slug: original.slug,
      kind: original.kind,
      title: original.title,
      summary: original.summary,
      body: original.body,
      tags: original.tags,
      trust: original.trust,
      importance: original.importance,
      pinned: true,
      muted: false,
      revision: 2,
      useCount: 3
    })
    expect(parsed.record.scope).toEqual(userScope)
    expect(parsed.record.createdAt).toBe(original.createdAt)
    expect(parsed.record.expiresAt).toBeUndefined()
    expect(parsed.record.evidence?.quote).toBe('以后都用 pnpm')
    expect(parsed.needsWrite).toBe(false)
  })

  it('preserves unknown frontmatter keys', () => {
    const original = record({ rawFrontmatter: { customField: 'kept', nested: { a: 1 } } })
    const parsed = parseMemoryFile(serializeMemoryFile(original), userScope)
    expect(parsed.rawFrontmatter).toEqual({ customField: 'kept', nested: { a: 1 } })
    expect(serializeMemoryFile({ ...original, rawFrontmatter: parsed.rawFrontmatter })).toContain('customField: kept')
  })

  it('collapses newlines in title and summary on parse', () => {
    const text = serializeMemoryFile(record()).replace('title: 使用 pnpm', 'title: "使用\\npnpm"')
    const parsed = parseMemoryFile(text, userScope)
    expect(parsed.record.title).toBe('使用 pnpm')
  })
})

describe('repair paths', () => {
  it('generates an id when frontmatter has none', () => {
    const text = `---
schemaVersion: 1
slug: no-id
kind: fact
title: No id
summary: Missing identifier
---

body
`
    const parsed = parseMemoryFile(text, userScope)
    expect(parsed.generatedId).toBe(true)
    expect(parsed.needsWrite).toBe(true)
    expect(parsed.record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('derives a slug from the title when missing', () => {
    const text = `---
schemaVersion: 1
id: 01JABCDEFGHJKMNPQRSTVWXYZ2
kind: fact
title: Build uses Turbo
summary: Build runs through Turbo
---
`
    const parsed = parseMemoryFile(text, userScope)
    expect(parsed.record.slug).toBe('build-uses-turbo')
    expect(parsed.needsWrite).toBe(true)
  })

  it('warns but uses the directory scope on mismatch', () => {
    const text = `---
schemaVersion: 1
id: 01JABCDEFGHJKMNPQRSTVWXYZ3
slug: scoped
kind: fact
scope: project:other
title: Scoped
summary: Mismatch
---
`
    const parsed = parseMemoryFile(text, userScope)
    expect(parsed.record.scope).toEqual(userScope)
    expect(parsed.warnings.join('\n')).toContain('does not match directory scope')
  })
})

describe('malformed input', () => {
  it('rejects missing frontmatter', () => {
    expect(() => parseMemoryFile('just markdown', userScope)).toThrow(/MALFORMED_MEMORY/)
  })

  it('rejects invalid YAML', () => {
    const text = '---\nslug: [unclosed\n---\nbody\n'
    expect(() => parseMemoryFile(text, userScope)).toThrow(/MALFORMED_MEMORY/)
  })

  it('rejects an unknown kind', () => {
    const text = `---
schemaVersion: 1
id: 01JABCDEFGHJKMNPQRSTVWXYZ4
slug: k
kind: nonsense
title: K
summary: S
---
`
    expect(() => parseMemoryFile(text, userScope)).toThrow(/MALFORMED_MEMORY/)
  })

  it('rejects files from a newer schema', () => {
    const text = `---
schemaVersion: 99
id: 01JABCDEFGHJKMNPQRSTVWXYZ5
slug: future
kind: fact
title: Future
summary: Future
---
`
    expect(() => parseMemoryFile(text, userScope)).toThrow(/SCHEMA_TOO_NEW/)
  })
})
