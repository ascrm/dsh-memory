import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore, type StoreHarness } from './helpers.ts'
import { registerCapture } from '../src/capture.ts'
import { CoreCache } from '../src/injection/core.ts'
import type { MemoryConfig } from '../src/types.ts'

let harness: StoreHarness | undefined
let projectDir: string | undefined

afterEach(async () => {
  if (harness !== undefined) await harness.cleanup()
  if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5 })
  harness = undefined
  projectDir = undefined
})

function fakeContext(llm: unknown) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  return {
    handlers,
    ctx: {
      on: (name: string, handler: (...args: any[]) => any) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
        return () => {}
      },
      get: (name: string) => (name === 'llm' ? llm : undefined)
    }
  }
}

async function emit(
  handlers: Map<string, Array<(...args: any[]) => any>>,
  name: string,
  ...args: any[]
): Promise<void> {
  for (const handler of handlers.get(name) ?? []) await handler(...args)
}

describe('auto capture', () => {
  it('writes extracted candidates and drops unsupported evidence', async () => {
    harness = await createStore({ enableAutoCapture: true })
    projectDir = await mkdtemp(join(tmpdir(), 'dsh-memory-capture-'))
    await mkdir(projectDir, { recursive: true })
    const session = { id: 'capture-session', header: { cwd: projectDir } }
    const extracted = [
      {
        slug: 'health-endpoint',
        kind: 'constraint',
        title: 'Health endpoint',
        summary: 'Health check is /healthz',
        body: '/healthz',
        importance: 9,
        evidence: 'health check is /healthz'
      },
      {
        slug: 'invented-quote',
        kind: 'fact',
        title: 'Invented',
        summary: 'A fabricated memory',
        body: 'body',
        evidence: 'this quote never appeared in the transcript'
      }
    ]
    const llm = {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(extracted) }
      }
    }
    const { ctx, handlers } = fakeContext(llm)
    const core = new CoreCache(harness.store, harness.config)
    const capture = registerCapture(ctx as never, harness.store, harness.config as MemoryConfig, core)
    try {
      await emit(handlers, 'session/event', session, {
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Remember that the health check is /healthz' }]
        }
      })
      await emit(handlers, 'agent/disposed', {
        agent: { session, options: { provider: 'test', model: 'test-model' } }
      })
      await capture.drain()
      const docs = await harness.store.list({
        scope: 'project',
        projectScope: harness.store.scopeForCwd(projectDir!)
      })
      expect(docs).toHaveLength(2)
      expect(docs.every((doc) => doc.trust === 'candidate')).toBe(true)
      const health = await harness.store.locate('health-endpoint', {
        projectScope: harness.store.scopeForCwd(projectDir!)
      })
      expect(health?.record.evidence?.quote).toBe('health check is /healthz')
      const invented = await harness.store.locate('invented-quote', {
        projectScope: harness.store.scopeForCwd(projectDir!)
      })
      expect(invented?.record.evidence).toBeUndefined()
    } finally {
      capture.stop()
      await capture.drain()
    }
  })

  it('does nothing when auto capture is disabled', async () => {
    harness = await createStore()
    projectDir = await mkdtemp(join(tmpdir(), 'dsh-memory-capture-off-'))
    const session = { id: 'off-session', header: { cwd: projectDir } }
    const llm = {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '[]' }
      }
    }
    const { ctx, handlers } = fakeContext(llm)
    const core = new CoreCache(harness.store, harness.config)
    const capture = registerCapture(ctx as never, harness.store, harness.config as MemoryConfig, core)
    try {
      await emit(handlers, 'session/event', session, {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'remember this' }] }
      })
      await emit(handlers, 'agent/disposed', {
        agent: { session, options: { provider: 'test', model: 'test-model' } }
      })
      capture.stop()
      await capture.drain()
      const docs = await harness.store.list({ scope: 'all' })
      expect(docs).toHaveLength(0)
    } finally {
      capture.stop()
    }
  })
})
