import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createStore, emit, createFakeContext, waitFor, type FakeContext, type StoreHarness } from './helpers.ts'
import { RecallService } from '../src/injection/recall.ts'
import { CoreCache } from '../src/injection/core.ts'
import { apply } from '../src/index.ts'
import { normalizeConfig } from '../src/config.ts'
import { MemoryStore } from '../src/store/store.ts'

let harness: StoreHarness | undefined
let dir: string | undefined
let ctx: FakeContext | undefined

afterEach(async () => {
  if (ctx !== undefined) for (const effect of ctx.effects) await effect()
  if (harness !== undefined) await harness.cleanup()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  harness = undefined
  dir = undefined
  ctx = undefined
})

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function agentOf(cwd: string, id = 'recall-session') {
  return { session: { id, header: { cwd } } }
}

describe('per-turn recall', () => {
  it('uses claimed user text to build a verified-only recall pack', async () => {
    harness = await createStore({ enableRecall: true, recallMaxItems: 5 })
    const agent = agentOf(harness.root)
    const verified = await harness.store.write({
      slug: 'pnpm-build',
      kind: 'preference',
      title: 'Use pnpm',
      summary: 'Build the project with pnpm',
      body: 'pnpm build',
      scope: { type: 'user' }
    })
    await harness.store.verify(verified.record.id, { type: 'user' })
    const candidate = await harness.store.write({
      slug: 'candidate-only',
      kind: 'preference',
      title: 'Candidate only',
      summary: 'Candidate memory about pnpm',
      body: 'candidate',
      scope: { type: 'user' }
    })
    const unrelated = await harness.store.write({
      slug: 'unrelated-verified',
      kind: 'preference',
      title: 'Unrelated deployment',
      summary: 'Deployment dashboard is on port 9090',
      body: 'unrelated',
      scope: { type: 'user' }
    })
    await harness.store.verify(unrelated.record.id, { type: 'user' })

    const service = new RecallService(harness.store, harness.config)
    service.noteClaim(agent, message('how do I build with pnpm?'), 1)
    const pack = await service.packFor(agent)
    expect(pack).not.toBeNull()
    expect(pack!.text).toContain('<memory_recall>')
    expect(pack!.text).toContain('Build the project with pnpm')
    expect(pack!.ids).toContain(verified.record.id)
    expect(pack!.ids).not.toContain(candidate.record.id)
    expect(pack!.ids).not.toContain(unrelated.record.id)

    service.noteClaim(agent, message('health endpoint'), 2)
    const next = await service.packFor(agent)
    expect(next?.text ?? '').not.toContain('Build the project with pnpm')
  })

  it('excludes core memories and can include candidates when configured', async () => {
    harness = await createStore({ enableRecall: true, recallIncludeCandidates: true })
    const agent = agentOf(harness.root)
    const first = await harness.store.write({
      slug: 'core-only',
      kind: 'preference',
      title: 'Core memory',
      summary: 'Already in the core layer',
      body: 'core',
      scope: { type: 'user' }
    })
    const second = await harness.store.write({
      slug: 'recall-only',
      kind: 'preference',
      title: 'Recall memory',
      summary: 'Should be recalled',
      body: 'recall',
      scope: { type: 'user' }
    })
    const core = {
      entry: () => ({ ids: [first.record.id] }),
      activeIds: () => [first.record.id]
    } as unknown as CoreCache
    const service = new RecallService(harness.store, harness.config, core)
    service.noteClaim(agent, message('core memory recall'), 1)
    const pack = await service.packFor(agent)
    expect(pack?.ids).toContain(second.record.id)
    expect(pack?.ids).not.toContain(first.record.id)
  })

  it('injects the recall section during assembly for the current step', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-memory-recall-integration-'))
    const root = join(dir, 'memory')
    const cwd = join(dir, 'project')
    await mkdir(cwd, { recursive: true })
    const config = normalizeConfig({ memoryDir: root, enableRecall: true, maxCoreItems: 1 })
    ctx = createFakeContext()
    apply(ctx as never, config)

    const store = new MemoryStore(root, config)
    await store.init()
    const projectScope = store.scopeForCwd(cwd)
    if (projectScope.type !== 'project') throw new Error('expected a project scope')
    const health = await store.write({
      slug: 'health-endpoint',
      kind: 'constraint',
      title: 'Health endpoint',
      summary: 'Health check is /healthz',
      body: '/healthz',
      scope: projectScope
    })
    await store.verify(health.record.id, projectScope)
    const build = await store.write({
      slug: 'build-command',
      kind: 'fact',
      title: 'Build command',
      summary: 'Build the project with pnpm',
      body: 'pnpm build',
      scope: projectScope
    })
    await store.verify(build.record.id, projectScope)
    const session = { id: 'recall-session', header: { cwd } }
    const agent = { session }
    await emit(ctx, 'agent/created', { agent: { ...agent, options: {} } })
    await waitFor(() => ctx?.sections[0]?.text({ agent })?.includes('Health check is /healthz') ?? false)

    await emit(ctx, 'agent/inbox/claimed', {
      agent: { ...agent, options: {} },
      message: message('how do I build with pnpm?'),
      turn: 1
    })
    const assemblyHandler = ctx.handlers.get('system-prompt/assemble')?.[0]
    expect(assemblyHandler).toBeDefined()
    const base = { sections: [{ name: 'memory:core', text: 'core' }], contexts: [], tools: [], variables: {} }
    const assembled = await assemblyHandler!(base, { agent }, async () => base)
    const recall = assembled.sections.find((section: { name: string }) => section.name === 'memory:recall')
    expect(recall?.text).toContain('Build the project with pnpm')
    await store.audit.flush()
  })
})
