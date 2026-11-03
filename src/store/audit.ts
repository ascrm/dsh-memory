/**
 * 追加写入的 JSONL 审计日志。
 *
 * 审计只是一种副作用：追加失败会通过可选的警告回调上报，并且绝不阻塞记忆操作。
 * 事件永远不携带记忆正文、查询文本或密钥。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { auditFile } from './paths.ts'

/** 日志轮转前的最大大小。 */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024

/** 一条审计事件。 */
export interface AuditEvent {
  ts: number
  event:
    | 'write'
    | 'forget'
    | 'verify'
    | 'dispute'
    | 'restore'
    | 'pin'
    | 'resolve'
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

/** 带缓冲、串行写入的审计写入器。 */
export class MemoryAudit {
  private readonly root: string
  private readonly warn: (message: string) => void
  private chain: Promise<void> = Promise.resolve()

  constructor(root: string, warn?: (message: string) => void) {
    this.root = root
    this.warn = warn ?? (() => {})
  }

  /** 追加一条事件；该行写入完成（或失败）后 resolve。 */
  append(event: AuditEvent): Promise<void> {
    const line = `${JSON.stringify({ ...event, ts: event.ts ?? Date.now() })}\n`
    this.chain = this.chain.then(() => this.writeLine(line)).catch((error: unknown) => {
      this.warn(`audit append failed: ${String(error)}`)
    })
    return this.chain
  }

  /** 仍在排队的追加操作。 */
  flush(): Promise<void> {
    return this.chain
  }

  /** 读取所有可解析的事件（坏行会被跳过）。 */
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
        // 容忍末尾被截断的行，或因手工编辑而损坏的行。
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

/** 便捷函数：某个根目录对应的审计文件路径。 */
export function auditPathFor(root: string): string {
  return join(root, 'audit.jsonl')
}
