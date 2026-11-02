/**
 * dsh-memory plugin entry.
 *
 * A local-first, file-based memory plugin for DeepSeek Harness: Markdown is the
 * source of truth, a derived BM25 index is the retrieval cache, and a two-tier
 * design keeps the system prompt under a hard byte budget while exposing the
 * recall layer through tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, normalizeConfig, resolveMemoryDir } from './config.ts'
import type { MemoryConfig } from './types.ts'
import { MemoryStore } from './store/store.ts'
import { CoreCache } from './injection/core.ts'
import { createInjectionAuditor } from './injection/audit.ts'
import { registerTools } from './tools.ts'
import { registerCapture } from './capture.ts'
import { registerMemoryApi } from './api.ts'
import { scopeKey } from './store/paths.ts'

export { Config }
export type { MemoryConfig } from './types.ts'

/** Plugin name used by the loader. */
export const name = 'dsh-memory'

/** Services this plugin requires at apply time. */
export const inject = ['tools', 'systemPrompt']

interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): unknown
  }
}

/** Plugin entry point. */
export function apply(ctx: Context, config: MemoryConfig): void {
  const merged = normalizeConfig(config)
  const root = resolveMemoryDir(merged)
  const store = new MemoryStore(root, merged, {
    warn: (message: string) => {
      try {
        ctx.logger.warn(`[dsh-memory] ${message}`)
      } catch {
        // Logging must never break a memory operation.
      }
    }
  })
  void store.init().catch((error: unknown) => {
    ctx.logger.warn(`[dsh-memory] failed to initialize ${root}: ${String(error)}`)
  })

  const core = new CoreCache(store, merged, createInjectionAuditor(store))
  registerTools(ctx, { store, core })

  const capture = registerCapture(ctx, store, merged, core)

  ctx.systemPrompt.section({
    name: 'memory:core',
    order: 4000,
    text: (context) => core.text(context.agent?.session)
  })

  ctx.on('agent/created', ({ agent }) => {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined && cwd.length > 0) {
      const scope = store.scopeForCwd(cwd)
      void store
        .ensureProject(scope, cwd)
        .catch((error: unknown) => ctx.logger.warn(`[dsh-memory] project metadata failed: ${String(error)}`))
    }
    void core.warm(agent.session, { validate: true })
  })

  ctx.on('session/disposed', (session) => {
    core.drop(session.id)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const args = exec.arguments as { hard?: unknown } | undefined
    if (exec.name === 'memory_forget' && args?.hard === true) {
      return { kind: 'ask', reason: 'memory_forget(hard=true) permanently deletes a memory' }
    }
    return decision
  })

  ctx.inject(['connection'], (fiberCtx) => {
    try {
      if (!merged.enablePanel) return
      const connection = (fiberCtx as unknown as { get(name: string): unknown }).get('connection') as
        | ConnectionLike
        | undefined
      if (connection === undefined || typeof connection.fetch?.register !== 'function') return
      registerMemoryApi(connection, { store, config: merged, core })
      ctx.logger.debug?.(`[dsh-memory] panel API registered for ${scopeKey({ type: 'user' })}`)
    } catch (error) {
      ctx.logger.warn(`[dsh-memory] panel API unavailable: ${String(error)}`)
    }
  })

  ctx.effect(
    function* () {
      yield async () => {
        capture.stop()
        await capture.drain()
        await store.audit.flush()
        core.clear()
      }
    },
    'dsh-memory teardown'
  )
}
