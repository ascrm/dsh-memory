/**
 * 可选的自动捕获（第二阶段）。
 *
 * 缓冲根会话的文本，并在 `agent/disposed` 时请求所配置的模型返回一个小型 JSON 数组，
 * 其中是值得长期保留的记忆。所有内容都以 candidate 身份经由 store 写入；验证始终只由
 * 用户完成。任何失败都会被隔离：捕获绝不影响会话。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MEMORY_KINDS, MemoryError, type MemoryConfig, type MemoryKind, type MemoryScope } from './types.ts'
import { normalizeSlug, singleLine, textSimilarity } from './store/sanitize.ts'
import type { MemoryStore } from './store/store.ts'
import type { CoreCache } from './injection/core.ts'

const MAX_TURNS = 40
const MAX_TOTAL_CHARS = 24_000
const USER_CHAR_CAP = 2000
const ASSISTANT_CHAR_CAP = 500

interface CaptureBuffer {
  cwd?: string
  entries: Array<{ role: 'user' | 'assistant'; text: string }>
  chars: number
}

interface SessionEventLike {
  type: string
  data?: unknown
}

interface AssistantEventData {
  message?: UserMessage
}

interface CandidateItem {
  slug?: unknown
  kind?: unknown
  title?: unknown
  summary?: unknown
  body?: unknown
  importance?: unknown
  evidence?: unknown
}

/** {@link registerCapture} 返回的句柄。 */
export interface CaptureHandle {
  verifyEvidence: (quote: string, sessionId?: string) => boolean
  stop: () => void
  drain: () => Promise<void>
}

function messageText(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  const text = parts.join('\n').trim()
  return text.length > 0 ? text : null
}

function normalizeForEvidence(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function quoteInBuffer(quote: string, buffer: CaptureBuffer): boolean {
  const needle = normalizeForEvidence(quote).slice(0, 40)
  if (needle.length === 0) return false
  return buffer.entries.some((entry) => normalizeForEvidence(entry.text).includes(needle))
}

function appendCapped(buffer: CaptureBuffer, role: 'user' | 'assistant', text: string): void {
  const cap = role === 'user' ? USER_CHAR_CAP : ASSISTANT_CHAR_CAP
  const clipped = text.slice(0, cap)
  buffer.entries.push({ role, text: clipped })
  buffer.chars += clipped.length
  while (buffer.entries.length > MAX_TURNS || buffer.chars > MAX_TOTAL_CHARS) {
    const dropped = buffer.entries.shift()
    if (dropped === undefined) break
    buffer.chars -= dropped.text.length
  }
}

function parseCandidates(raw: string): CandidateItem[] {
  let text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced !== null) text = fenced[1]!.trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is CandidateItem => item !== null && typeof item === 'object')
  } catch {
    return []
  }
}

/** 构建提取用的提示词。 */
export function buildCapturePrompt(existing: Array<{ slug: string; summary: string }>, transcript: string): string {
  const digest = existing
    .slice(0, 60)
    .map((item) => `- ${item.slug}: ${item.summary}`)
    .join('\n')
  return `You extract durable cross-session memories from a finished coding session.

Rules:
- Only facts that will matter in future sessions. Do not summarize the conversation.
- Do not duplicate the existing memories listed below.
- Do not repeat stable constraints already recorded in AGENTS.md/CLAUDE.md.
- Provide a verbatim evidence quote from the transcript when possible.
- Return ONLY a JSON array. Return [] when nothing is worth remembering.
- Each item: {"slug":"kebab-case","kind":"preference|constraint|decision|fact|artifact|episode","title":"one line","summary":"one line","body":"markdown","importance":1-10,"evidence":"verbatim quote"}.

Existing memories:
${digest.length > 0 ? digest : '(none)'}

<transcript>
${transcript}
</transcript>`
}

/** 注册捕获监听器，并安装 evidence 校验器。 */
export function registerCapture(
  ctx: Context,
  store: MemoryStore,
  config: MemoryConfig,
  core: CoreCache
): CaptureHandle {
  const buffers = new Map<string, CaptureBuffer>()
  const active = new Set<Promise<void>>()
  const abort = new AbortController()
  let stopped = false

  ctx.on('session/event', (session, event: SessionEventLike) => {
    if (stopped) return
    const header = session.header
    if ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent') return
    const buffer = buffers.get(session.id) ?? { cwd: header.cwd, entries: [], chars: 0 }
    buffer.cwd = header.cwd ?? buffer.cwd
    if (event.type === 'user/message') {
      const message = event.data as { source?: { kind?: string } } | undefined
      if (message?.source?.kind !== 'user') return
      const text = messageText(message)
      if (text === null) return
      appendCapped(buffer, 'user', text)
      buffers.set(session.id, buffer)
    } else if (event.type === 'assistant/message') {
      const text = messageText((event.data as AssistantEventData | undefined)?.message)
      if (text === null) return
      appendCapped(buffer, 'assistant', text)
      buffers.set(session.id, buffer)
    }
  })

  const verifyEvidence = (quote: string, sessionId?: string): boolean => {
    const targets =
      sessionId !== undefined && buffers.has(sessionId)
        ? [buffers.get(sessionId)!]
        : [...buffers.values()]
    if (targets.length === 0) return true
    const needle = normalizeForEvidence(quote).slice(0, 40)
    if (needle.length === 0) return false
    return targets.some((buffer) => quoteInBuffer(quote, buffer))
  }
  store.setEvidenceVerifier(verifyEvidence)

  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    const session = agent.session
    const buffer = buffers.get(session.id)
    if (buffer === undefined) return
    buffers.delete(session.id)
    if (!config.enableAutoCapture || stopped) return
    if ((session.header.delegationDepth ?? 0) > 0 || session.header.origin === 'subagent') return
    const cwd = buffer.cwd ?? session.header.cwd
    if (cwd === undefined) return
    const provider = (agent as unknown as { options?: { provider?: string; model?: string } }).options?.provider
    const model = (agent as unknown as { options?: { model?: string } }).options?.model
    if (provider === undefined || model === undefined) return
    const llm = (ctx as unknown as { get(name: string): unknown }).get('llm') as
      | { stream(options: Record<string, unknown>): AsyncIterable<{ type: string; text?: string }> }
      | undefined
    if (llm === undefined || typeof llm.stream !== 'function') return

    const task = (async () => {
      try {
        const projectScope = store.scopeForCwd(cwd)
        const existingDocs = await store.list({ scope: 'all', projectScope, limit: 50 })
        const digest = existingDocs.map((doc) => ({ slug: doc.slug, summary: doc.summary }))
        const transcript = buffer.entries.map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`).join('\n\n')
        const prompt = buildCapturePrompt(digest, transcript)
        const messages = [
          createUserMessage({
            content: [{ type: 'text', text: 'Extract durable memories from this session as JSON.' }],
            source: { kind: 'user' }
          })
        ]
        let raw = ''
        for await (const chunk of llm.stream({
          provider,
          model,
          system: prompt,
          messages,
          maxTokens: config.autoCaptureMaxTokens,
          signal: abort.signal
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        }
        if (raw.length === 0) return
        const candidates = parseCandidates(raw).slice(0, config.autoCaptureMaxItems)
        if (candidates.length === 0) return
        const existingSlugs = new Set(digest.map((item) => item.slug))
        const existingSummaries = digest.map((item) => item.summary)
        let written = 0
        const changedScopes = new Set<string>()
        const changed: MemoryScope[] = []
        for (const candidate of candidates) {
          const kind = MEMORY_KINDS.includes(candidate.kind as MemoryKind) ? (candidate.kind as MemoryKind) : 'fact'
          const title = typeof candidate.title === 'string' ? singleLine(candidate.title, 80) : ''
          const summary = typeof candidate.summary === 'string' ? singleLine(candidate.summary, 200) : ''
          if (title.length === 0 || summary.length === 0) continue
          let slug: string
          try {
            slug = normalizeSlug(typeof candidate.slug === 'string' ? candidate.slug : title)
          } catch {
            continue
          }
          if (existingSlugs.has(slug)) continue
          if (existingSummaries.some((existing) => textSimilarity(existing, summary) >= 0.7)) continue
          const body = typeof candidate.body === 'string' ? candidate.body : summary
          if (Buffer.byteLength(body, 'utf8') > config.maxBodyBytes) continue
          const scope: MemoryScope =
            kind === 'preference' || kind === 'artifact'
              ? config.enableUserScope
                ? { type: 'user' }
                : projectScope
              : projectScope
          const evidence =
            typeof candidate.evidence === 'string' && quoteInBuffer(candidate.evidence, buffer)
              ? candidate.evidence
              : undefined
          try {
            await store.write({
              slug,
              kind,
              title,
              summary,
              body,
              scope,
              importance: typeof candidate.importance === 'number' ? candidate.importance : undefined,
              evidence,
              source: { sessionId: session.id, tool: 'memory_capture' }
            })
            existingSlugs.add(slug)
            existingSummaries.push(summary)
            written += 1
            const key = `${scope.type}:${scope.type === 'project' ? scope.key : ''}`
            if (!changedScopes.has(key)) {
              changedScopes.add(key)
              changed.push(scope)
            }
          } catch (error) {
            if (!(error instanceof MemoryError)) throw error
          }
        }
        if (written > 0) for (const scope of changed) core.invalidate(scope)
      } catch {
        // 提取是尽力而为的，绝不能干扰会话的收尾流程。
      }
    })()
    active.add(task)
    void task.finally(() => active.delete(task))
  })

  ctx.on('session/disposed', (session) => {
    buffers.delete(session.id)
  })

  return {
    verifyEvidence,
    stop: () => {
      stopped = true
      abort.abort()
      buffers.clear()
    },
    drain: async () => {
      await Promise.allSettled([...active])
    }
  }
}
