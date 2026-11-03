/**
 * 最终排名、陈旧度与多样性选择。
 */
import type { MemoryKind, MemoryRecord, MemoryScope } from '../types.ts'
import { textSimilarity } from '../store/sanitize.ts'

/** §7.3 中固定的分数权重。 */
export const SCORE_WEIGHTS = {
  bm25: 0.55,
  recency: 0.15,
  trust: 0.12,
  importance: 0.08,
  scopeMatch: 0.05,
  kind: 0.05
} as const

/** trust 贡献。 */
export const TRUST_WEIGHT: Record<MemoryRecord['trust'], number> = {
  verified: 1,
  candidate: 0.5,
  disputed: 0,
  superseded: 0
}

/** 类型贡献。 */
export const KIND_WEIGHT: Record<MemoryKind, number> = {
  constraint: 1,
  decision: 1,
  preference: 0.9,
  fact: 0.7,
  artifact: 0.5,
  episode: 0.4
}

/** 不会自动变陈旧的长期类型。 */
const LONG_TERM_KINDS = new Set<MemoryKind>(['preference', 'constraint', 'decision'])

const DAY_MS = 24 * 60 * 60 * 1000

/** [0, 1] 区间内的指数式新近度。 */
export function recencyScore(
  record: { lastUsedAt?: number; updatedAt: number },
  now: number,
  halfLifeDays: number
): number {
  const anchor = record.lastUsedAt ?? record.updatedAt
  return recencyFrom(anchor, now, halfLifeDays)
}

/** 作用域贡献：当前项目为 1，用户作用域为 0.7，其他为 0.2。 */
export function scopeMatchScore(record: { scope: MemoryScope }, currentProjectKey?: string): number {
  if (record.scope.type === 'user') return 0.7
  if (currentProjectKey !== undefined && record.scope.key === currentProjectKey) return 1
  return 0.2
}

/** 把 importance 从 1–10 归一化到 [0, 1]。 */
export function importanceNorm(importance: number): number {
  return (Math.min(10, Math.max(1, importance)) - 1) / 9
}

/** 记录是否已超过 TTL。 */
export function isExpired(record: MemoryRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt < now
}

/** 记录是否已按配置的阈值判定为陈旧。 */
export function isStale(record: MemoryRecord, now: number, staleAfterDays: number): boolean {
  if (staleAfterDays <= 0) return false
  if (record.pinned) return false
  if (LONG_TERM_KINDS.has(record.kind)) return false
  const anchor = record.lastUsedAt ?? record.updatedAt
  return now - anchor > staleAfterDays * DAY_MS
}

/** 给记忆打分所需的最小元数据，无需构造完整记录。 */
export interface ScoreMeta {
  kind: MemoryKind
  trust: MemoryRecord['trust']
  importance: number
  updatedAt: number
  lastUsedAt?: number
  scope: MemoryScope
}

function recencyFrom(
  anchor: number,
  now: number,
  halfLifeDays: number
): number {
  const days = Math.max(0, (now - anchor) / DAY_MS)
  const halfLife = halfLifeDays > 0 ? halfLifeDays : 180
  return Math.exp(-days / halfLife)
}

/** 去掉作用域后的元数据，便于调用方直接给索引文档打分而不必复制它。 */
export type ScoreDocMeta = Omit<ScoreMeta, 'scope'> & {
  /** 可选的预计算值：trust + importance + kind 的贡献。 */
  priorScore?: number
}

/** 轻量元数据视图加上其作用域后的最终加权分数。 */
export function scoreDoc(
  meta: ScoreDocMeta,
  scope: MemoryScope,
  input: {
    bm25Norm: number
    now: number
    halfLifeDays: number
    currentProjectKey?: string
  }
): number {
  const anchor = meta.lastUsedAt ?? meta.updatedAt
  const prior =
    meta.priorScore ??
    (SCORE_WEIGHTS.trust * TRUST_WEIGHT[meta.trust] +
      SCORE_WEIGHTS.importance * importanceNorm(meta.importance) +
      SCORE_WEIGHTS.kind * KIND_WEIGHT[meta.kind])
  return (
    SCORE_WEIGHTS.bm25 * input.bm25Norm +
    SCORE_WEIGHTS.recency * recencyFrom(anchor, input.now, input.halfLifeDays) +
    prior +
    SCORE_WEIGHTS.scopeMatch * scopeMatchScore({ scope }, input.currentProjectKey)
  )
}

/** 轻量元数据视图的最终加权分数。 */
export function scoreMeta(
  meta: ScoreMeta,
  input: {
    bm25Norm: number
    now: number
    halfLifeDays: number
    currentProjectKey?: string
  }
): number {
  return scoreDoc(meta, meta.scope, input)
}

/** 单个候选的最终加权分数。 */
export function finalScore(
  record: MemoryRecord,
  input: {
    bm25Norm: number
    now: number
    halfLifeDays: number
    currentProjectKey?: string
  }
): number {
  return scoreMeta(record, input)
}

/** §8.2 中的核心层分数。 */
export function coreScore(
  record: MemoryRecord,
  now: number,
  halfLifeDays: number
): number {
  return (
    0.5 * TRUST_WEIGHT[record.trust] +
    0.2 * importanceNorm(record.importance) +
    0.2 * recencyScore(record, now, halfLifeDays) +
    0.1 * KIND_WEIGHT[record.kind]
  )
}

/** 一个已打分的候选。 */
export interface ScoredMemory {
  record: MemoryRecord
  score: number
  bm25: number
}

/** 去掉 slug 完全相同和摘要近似的重复项，保留分数更高的那条。 */
export function dedupeCandidates(candidates: readonly ScoredMemory[]): ScoredMemory[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
  const kept: ScoredMemory[] = []
  const slugKeys = new Set<string>()
  for (const candidate of sorted) {
    const slugKey = `${candidate.record.scope.type}:${candidate.record.slug}`
    if (slugKeys.has(slugKey)) continue
    const duplicate = kept.find((existing) => textSimilarity(existing.record.summary, candidate.record.summary) >= 0.9)
    if (duplicate !== undefined) continue
    slugKeys.add(slugKey)
    kept.push(candidate)
  }
  return kept
}

/**
 * 对头部候选做最大边际相关（MMR）选择。
 * `lambda = 0.7` 在相关性与冗余度之间取平衡。
 */
export function mmrSelect(
  candidates: readonly ScoredMemory[],
  limit: number,
  lambda = 0.7
): ScoredMemory[] {
  if (limit <= 0) return []
  const remaining = [...candidates]
  const selected: ScoredMemory[] = []
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0
    let bestValue = Number.NEGATIVE_INFINITY
    for (let i = 0; i < remaining.length; i += 1) {
      const item = remaining[i]!
      let maxSimilarity = 0
      for (const chosen of selected) {
        const similarity = textSimilarity(item.record.summary, chosen.record.summary)
        if (similarity > maxSimilarity) maxSimilarity = similarity
      }
      const value = lambda * item.score - (1 - lambda) * maxSimilarity
      if (value > bestValue) {
        bestValue = value
        bestIndex = i
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!)
  }
  return selected
}
