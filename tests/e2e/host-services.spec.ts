import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Fiber } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../../src/index.ts'
import { normalizeConfig } from '../../src/config.ts'

let base: string | undefined
const fibers: Fiber[] = []

afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  if (base !== undefined) await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  base = undefined
})

async function waitForSocket(check: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitForSocket timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function memoryFile(
  id: string,
  slug: string,
  kind: string,
  title: string,
  summary: string,
  body: string,
  trust: string,
  importance: number
): string {
  return `---
schemaVersion: 1
id: ${id}
slug: ${slug}
kind: ${kind}
scope: user
title: ${title}
summary: ${summary}
tags: []
trust: ${trust}
importance: ${importance}
createdAt: 2026-11-02T00:00:00.000Z
updatedAt: 2026-11-02T00:00:00.000Z
useCount: 0
source: {}
pinned: false
muted: false
revision: 1
---

${body}
`
}

describe('真实宿主 services e2e', () => {
  it('registers tools, injects core and recall through actual SystemPrompt/ToolRuntime', async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-memory-host-e2e-'))
    const memoryRoot = join(base, 'memory')
    const memories = join(memoryRoot, 'user', 'memories')
    await mkdir(memories, { recursive: true })
    await writeFile(
      join(memories, '01JABCDEFGHJKMNPQRSTVWXYZ1.md'),
      memoryFile(
        '01JABCDEFGHJKMNPQRSTVWXYZ1',
        'health',
        'constraint',
        'Health',
        'Health check is /healthz',
        '/healthz',
        'verified',
        9
      )
    )
    await writeFile(
      join(memories, '01JABCDEFGHJKMNPQRSTVWXYZ2.md'),
      memoryFile(
        '01JABCDEFGHJKMNPQRSTVWXYZ2',
        'build',
        'fact',
        'Build',
        'Build with pnpm',
        'pnpm build',
        'verified',
        6
      )
    )

    const ctx = new Context()
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(
      await ctx.plugin(
        { inject: ['tools', 'systemPrompt'], apply },
        normalizeConfig({ memoryDir: memoryRoot, enableRecall: true, maxCoreItems: 1, enablePanel: false })
      )
    )

    const session = { id: 'host-e2e', header: { cwd: base } }
    const agent = { session, options: {} } as never
    ctx.emit('agent/created', { agent })
    await waitForSocket(async () => {
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
      const core = assembly.sections.find((section) => section.name === 'memory:core')?.text ?? ''
      return core.includes('Health check is /healthz')
    })

    ctx.emit('agent/inbox/claimed', {
      agent,
      message: createUserMessage({
        content: [{ type: 'text', text: 'how do I build this project?' }],
        source: { kind: 'user' }
      }),
      turn: 1
    })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const core = assembly.sections.find((section) => section.name === 'memory:core')?.text ?? ''
    const recall = assembly.sections.find((section) => section.name === 'memory:recall')?.text ?? ''
    expect(core).toContain('Health check is /healthz')
    expect(core).not.toContain('Build with pnpm')
    expect(recall).toContain('Build with pnpm')

    const execute = (name: string, args: Record<string, unknown>, callId: string) =>
      ctx.tools.execute({
        callId: callId as never,
        name,
        arguments: args,
        agent: agent,
        signal: new AbortController().signal
      })

    const search = await execute('memory_search', { query: 'pnpm build', scope: 'all' }, 'search-1')
    expect(search.isError).toBe(false)
    const results = (search.value as { results: Array<{ id: string; summary: string }> }).results
    expect(results.some((hit) => hit.summary === 'Build with pnpm')).toBe(true)

    const read = await execute('memory_read', { id: results[0]!.id }, 'read-1')
    expect(read.isError).toBe(false)
    expect((read.value as { body: string }).body.length).toBeGreaterThan(0)
  }, 20_000)
})
