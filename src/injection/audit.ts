/**
 * Injection audit.
 *
 * Records which memory IDs entered one session's prompt and how large the pack
 * was. The core cache deduplicates by set signature; this module only appends,
 * never blocks, and never records body text.
 */
import type { MemoryStore } from '../store/store.ts'
import type { CorePack, InjectionAudit } from './core.ts'

/** Build an injection auditor bound to a store. */
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
