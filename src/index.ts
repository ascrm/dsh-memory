/**
 * dsh-memory 插件入口。
 *
 * 面向 DeepSeek Harness 的本地优先、基于文件的记忆插件：Markdown 是唯一事实来源，
 * 派生的 BM25 索引是检索缓存；两层设计让系统提示词始终处在硬性字节预算之内，
 * 同时通过工具暴露召回层。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, normalizeConfig, resolveMemoryDir } from './config.ts'
import type { MemoryConfig } from './types.ts'
import { MemoryStore } from './store/store.ts'
import { CoreCache } from './injection/core.ts'
import { RECALL_SECTION_NAME, RecallService } from './injection/recall.ts'
import { createInjectionAuditor } from './injection/audit.ts'
import { registerTools } from './tools.ts'
import { registerCapture } from './capture.ts'
import { registerMemoryApi } from './api.ts'
import { scopeKey } from './store/paths.ts'

export { Config }
export { normalizeConfig, resolveMemoryDir } from './config.ts'
export { MemoryStore } from './store/store.ts'
export type { MemoryStoreOptions } from './store/store.ts'
export { MemoryError } from './types.ts'
export { selectCore } from './injection/core.ts'
export type {
  MemoryConfig,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryListOptions,
  TrustState
} from './types.ts'

/** 加载器使用的插件名。 */
export const name = 'dsh-memory'

/** 本插件在 apply 时需要的服务。 */
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

/** 插件入口点。 */
export function apply(ctx: Context, config: MemoryConfig): void {
  const merged = normalizeConfig(config)
  const root = resolveMemoryDir(merged)
  const store = new MemoryStore(root, merged, {
    warn: (message: string) => {
      try {
        ctx.logger.warn(`[dsh-memory] ${message}`)
      } catch {
        // 日志记录绝不能破坏记忆操作。
      }
    }
  })
  void store.init().catch((error: unknown) => {
    ctx.logger.warn(`[dsh-memory] failed to initialize ${root}: ${String(error)}`)
  })

  const core = new CoreCache(store, merged, createInjectionAuditor(store))
  void core.warmUser()
  const recall = new RecallService(store, merged, core)
  registerTools(ctx, { store, core })

  const capture = registerCapture(ctx, store, merged, core)

  ctx.systemPrompt.section({
    name: 'memory:core',
    order: 4000,
    text: (context) => core.text(context.agent?.session)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    recall.noteClaim(agent, message, turn)
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const base = await next()
    if (!merged.enableRecall || context.agent === undefined) return base
    const pack = await recall.packFor(context.agent)
    if (pack === null) return base
    const sections = [...base.sections]
    const coreAt = sections.findIndex((section) => section.name === 'memory:core')
    sections.splice(coreAt === -1 ? sections.length : coreAt + 1, 0, {
      name: RECALL_SECTION_NAME,
      text: pack.text
    })
    return { ...base, sections }
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
    recall.drop(session.id)
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
      ctx.logger.debug?.(`[dsh-memory] client API registered for ${scopeKey({ type: 'user' })}`)
    } catch (error) {
      ctx.logger.warn(`[dsh-memory] client API unavailable: ${String(error)}`)
    }
  })

  ctx.effect(
    function* () {
      yield async () => {
        capture.stop()
        await capture.drain()
        await store.audit.flush()
        core.clear()
        recall.clear()
        store.close()
      }
    },
    'dsh-memory teardown'
  )
}
