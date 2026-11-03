/**
 * 注入审计。
 *
 * 记录哪些记忆 ID 进入了某个会话的提示词，以及该 pack 有多大。核心缓存会按集合签名
 * 去重；本模块只负责追加，从不阻塞，也从不记录正文。
 */
import type { MemoryStore } from '../store/store.ts'
import type { CorePack, InjectionAudit } from './core.ts'

/** 构建一个绑定到某个 store 的注入审计器。 */
export function createInjectionAuditor(store: MemoryStore): InjectionAudit {
  return (sessionId: string, scope: string, pack: CorePack): void => {
    void store.audit
      .append({
        ts: Date.now(),
        event: 'inject',
        sessionId,
        scope,
        ids: pack.ids,
        bytes: pack.bytes
      })
      .catch(() => {})
  }
}
