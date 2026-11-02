/**
 * Append-only JSONL audit log.
 *
 * Auditing is a side effect: a failed append is reported through the optional
 * warning callback and never blocks a memory operation. Events never carry
 * memory bodies, query text or secrets.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { auditFile } from './paths.ts'

/** Maximum size before the log is rotated. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024

/** One audit event. */
export interface AuditEvent {
  ts: number
  event:
    | 'write'
    | 'forget'
    | 'verify'
    | 'dispute'
    | 'restore'
    | 'pin'
    | 'supersede'
    | 'inject'
    | 'search'
    | 'refresh'
    | 'import'
    | 'migrate'
  actor?: 'model' | 'user' | 'system'
  id?: string
  scope?: string
  trust?: string
  sessionId?: string
  bytes?: number
  ids?: string[]
  queryHash?: string
  resultIds?: string[]
  mode?: string
  details?: Record<string, string | number | boolean>
}

/** Buffered, serialized audit writer. */
export class MemoryAudit {
  private readonly root: string
  private readonly warn: (message: string) => void
  private chain: Promise<void> = Promise.resolve()

  constructor(root: string, warn?: (message: string) => void) {
    this.root = root
    this.warn = warn ?? (() => {})
  }

  /** Append one event; resolves once the line is written (or failed). */
  append(event: AuditEvent): Promise<void> {
    const line = `${JSON.stringify({ ...event, ts: event.ts ?? Date.now() })}\n`
    this.chain = this.chain.then(() => this.writeLine(line)).catch((error: unknown) => {
      this.warn(`audit append failed: ${String(error)}`)
    })
    return this.chain
  }

  /** Remaining queued appends. */
  flush(): Promise<void> {
    return this.chain
  }

  /** Read all parseable events (bad lines are skipped). */
  async read(): Promise<AuditEvent[]> {
    let raw: string
    try {
      raw = await fs.readFile(auditFile(this.root), 'utf8')
    } catch {
      return []
    }
    const out: AuditEvent[] = []
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as AuditEvent
        if (typeof parsed.ts === 'number' && typeof parsed.event === 'string') out.push(parsed)
      } catch {
        // Tolerate a torn final line or a hand edit.
      }
    }
    return out
  }

  private async writeLine(line: string): Promise<void> {
    const file = auditFile(this.root)
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await withFileLock(
      file,
      async () => {
        await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
        let size = 0
        try {
          size = (await fs.stat(file)).size
        } catch {
          return
        }
        if (size > AUDIT_MAX_BYTES) await this.rotate(file)
      },
      { waitMs: 5000 }
    )
  }

  private async rotate(file: string): Promise<void> {
    try {
      const raw = await fs.readFile(file, 'utf8')
      const lines = raw.split('\n').filter((line) => line.length > 0)
      const kept: string[] = []
      let bytes = 0
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (bytes > AUDIT_MAX_BYTES / 2) break
        kept.unshift(lines[i]!)
        bytes += Buffer.byteLength(lines[i]!, 'utf8') + 1
      }
      await writeFileAtomic(file, `${kept.join('\n')}\n`, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      this.warn(`audit rotation failed: ${String(error)}`)
    }
  }
}

/** Convenience: audit file path for a root. */
export function auditPathFor(root: string): string {
  return join(root, 'audit.jsonl')
}
