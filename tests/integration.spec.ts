import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { normalizeConfig } from '../src/config.ts'
import { createFakeContext, emit, tool, waitFor, type FakeContext } from './helpers.ts'
import type { MemoryConfig } from '../src/types.ts'

let dir: string | undefined
let ctx: FakeContext | undefined

afterEach(async () => {
  if (ctx !== undefined) {
    for (const effect of ctx.effects) await effect()
  }
  if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
  ctx = undefined
})

interface Exec {
  agent: {
    session: {
      id: string
      header: { cwd: string; delegationDepth?: number }
    }
  }
  signal: AbortSignal
  arguments: Record<string, unknown>
}

function execFor(cwd: string, sessionId = 'session-1'): Exec {
  return {
    agent: { session: { id: sessionId, header: { cwd } } },
    signal: new AbortController().signal,
    arguments: {}
  }
}

async function setup(overrides: Partial<MemoryConfig> = {}): Promise<{ ctx: FakeContext; cwd: string; root: string }> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-memory-integration-'))
  const root = join(dir, 'memory')
  const cwd = join(dir, 'project')
  await mkdir(cwd, { recursive: true })
  ctx = createFakeContext()
  apply(ctx as any, normalizeConfig({ memoryDir: root, ...overrides }))
  return { ctx, cwd, root }
}

describe('plugin integration', () => {
  it('registers tools and an empty core section', async () => {
    const { ctx: context } = await setup()
    expect([...context.toolDefinitions.keys()].sort()).toEqual([
      'memory_forget',
      'memory_list',
      'memory_read',
      'memory_refresh',
      'memory_search',
      'memory_write'
    ])
    expect(context.sections).toHaveLength(1)
    expect(context.sections[0]?.name).toBe('memory:core')
    expect(context.sections[0]?.order).toBe(4000)
    expect(context.sections[0]?.text({})).toBe('')
  })

  it('writes, warms the core cache and clears it on dispose', async () => {
    const { ctx: context, cwd } = await setup({ trustCandidatesInCore: true })
    const write = tool(context, 'memory_write')
    const result = await write.execute(
      {
        slug: 'use-pnpm',
        kind: 'preference',
        title: 'Use pnpm',
        summary: 'The user prefers pnpm',
        body: 'Use pnpm.',
        scope: 'user'
      },
      execFor(cwd)
    )
    expect(result.operation).toBe('created')
    expect(result.trust).toBe('candidate')

    const session = { id: 'session-1', header: { cwd } }
    await emit(context, 'agent/created', { agent: { session, options: {} } })
    await waitFor(() => context.sections[0]?.text({ agent: { session } }) !== '')
    expect(context.sections[0]?.text({ agent: { session } })).toContain('The user prefers pnpm')

    // Write a project fact so the core has project-scoped content too.
    const fact = await tool(context, 'memory_write').execute(
      {
        slug: 'health-endpoint',
        kind: 'constraint',
        title: 'Health endpoint',
        summary: 'Health check is /healthz',
        body: '/healthz',
        scope: 'project'
      },
      execFor(cwd)
    )
    expect(fact.operation).toBe('created')
    await emit(context, 'agent/created', { agent: { session, options: {} } })
    await waitFor(() => context.sections[0]?.text({ agent: { session } }).includes('Health check is /healthz'))

    await emit(context, 'session/disposed', session)
    expect(context.sections[0]?.text({ agent: { session } })).toBe('')
  })

  it('searches and reads through tools', async () => {
    const { ctx: context, cwd } = await setup()
    await tool(context, 'memory_write').execute(
      {
        slug: 'migration-caveat',
        kind: 'episode',
        title: 'Migration caveat',
        summary: 'Last release failed because of migration ordering',
        body: 'Run migrations after the new binary starts.',
        scope: 'project'
      },
      execFor(cwd)
    )
    const search = await tool(context, 'memory_search').execute(
      { query: 'migration ordering', scope: 'project', limit: 5 },
      execFor(cwd)
    )
    expect(search.results).toHaveLength(1)
    const read = await tool(context, 'memory_read').execute({ id: search.results[0].id }, execFor(cwd))
    expect(read.summary).toContain('migration ordering')
    expect(read.body).toContain('Run migrations')
  })

  it('asks for approval before a hard forget and mutes by default', async () => {
    const { ctx: context, cwd } = await setup()
    const written = await tool(context, 'memory_write').execute(
      {
        slug: 'temporary',
        kind: 'episode',
        title: 'Temporary',
        summary: 'Temporary note',
        body: 'body',
        scope: 'project'
      },
      execFor(cwd)
    )
    const pre = context.handlers.get('tools/pre-execute')?.[0]
    expect(pre).toBeDefined()
    const allow = await pre!({ name: 'memory_forget', arguments: { id: written.id, hard: true } }, async () => ({ kind: 'allow' }))
    expect(allow).toEqual({ kind: 'ask', reason: 'memory_forget(hard=true) permanently deletes a memory' })

    const soft = await tool(context, 'memory_forget').execute({ id: written.id, hard: false }, execFor(cwd))
    expect(soft.mode).toBe('mute')
    const list = await tool(context, 'memory_list').execute({ scope: 'project' }, execFor(cwd))
    expect(list.entries).toHaveLength(0)
  })
})
