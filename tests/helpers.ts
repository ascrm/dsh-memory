import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../src/config.ts'
import { MemoryStore, type MemoryStoreOptions } from '../src/store/store.ts'
import type { MemoryConfig } from '../src/types.ts'

export interface StoreHarness {
  root: string
  config: MemoryConfig
  store: MemoryStore
  cleanup: () => Promise<void>
}

/** 在操作系统临时目录中创建一个隔离的记忆存储。 */
export async function createStore(
  overrides: Partial<MemoryConfig> = {},
  options: MemoryStoreOptions = {}
): Promise<StoreHarness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  const config = normalizeConfig({ memoryDir: root, ...overrides })
  const store = new MemoryStore(root, config, options)
  await store.init()
  return {
    root,
    config,
    store,
    cleanup: async () => {
      await store.audit.flush()
      store.close()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

/** 记录注册项和事件处理器的最小伪造 context。 */
export interface FakeContext {
  tools: { register: (definition: any) => () => void }
  systemPrompt: { section: (section: any) => () => void }
  toolDefinitions: Map<string, any>
  sections: any[]
  handlers: Map<string, Array<(...args: any[]) => any>>
  effects: Array<() => Promise<void>>
  logger: { warn: (...args: any[]) => void; debug: (...args: any[]) => void }
}

/** 为插件集成测试构建一个伪造的 Cordis context。 */
export function createFakeContext(): FakeContext {
  const toolDefinitions = new Map<string, any>()
  const sections: any[] = []
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  const effects: Array<() => Promise<void>> = []
  return {
    tools: {
      register: (definition: any) => {
        toolDefinitions.set(definition.name, definition)
        return () => {}
      }
    },
    systemPrompt: {
      section: (section: any) => {
        sections.push(section)
        return () => {}
      }
    },
    on: (name: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    inject: (_deps: string[], callback: (fiber: any) => void) => {
      callback({ get: () => undefined })
    },
    effect: (factory: () => Generator<any>, _label: string) => {
      const generator = factory()
      const first = generator.next()
      if (first.done === false && typeof first.value === 'function') effects.push(first.value)
      return () => {}
    },
    logger: { warn: () => {}, debug: () => {} },
    toolDefinitions,
    sections,
    handlers,
    effects
  } as unknown as FakeContext
}

/** 取出一个假的工具定义。 */
export function tool(context: FakeContext, name: string): any {
  const definition = context.toolDefinitions.get(name)
  if (definition === undefined) throw new Error(`tool ${name} not registered`)
  return definition
}

/** 向所有处理器发送一个已记录的事件。 */
export async function emit(context: FakeContext, name: string, ...args: any[]): Promise<void> {
  for (const handler of context.handlers.get(name) ?? []) {
    await handler(...args)
  }
}

/** 轮询直到 `check` 通过（用于异步预热路径）。 */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
