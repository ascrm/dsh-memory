/**
 * Final ranking, staleness and diversity selection.
 */
import type { MemoryKind, MemoryRecord, MemoryScope } from '../types.ts'
import { textSimilarity } from '../store/sanitize.ts'

/** Fixed score weights from §7.3. */
export const SCORE_WEIGHTS = {
  bm25: 0.55,
  recency: 0.15,
  trust: 0.12,
  importance: 0.08,
  scopeMatch: 0.05,
  kind: 0.05
} as const

/** Trust contribution. */
export const TRUST_WEIGHT: Record<MemoryRecord['trust'], number> = {
  verified: 1,
  candidate: 0.5,
  disputed: 0,
  superseded: 0
}

/** Kind contribution. */
export const KIND_WEIGHT: Record<MemoryKind, number> = {
  constraint: 1,
  decision: 1,
  preference: 0.9,
  fact: 0.7,
  artifact: 0.5,
  episode: 0.4
}

/** Long-lived kinds that do not go stale automatically. */
const LONG_TERM_KINDS = new Set<MemoryKind>(['preference', 'constraint', 'decision'])

const DAY_MS = 24 * 60 * 60 * 1000

/** Exponential recency in [0, 1]. */
export function recencyScore(
  record: { lastUsedAt?: number; updatedAt: number },
  now: number,
  halfLifeDays: number
): number {
  const anchor = record.lastUsedAt ?? record.updatedAt
  return recencyFrom(anchor, now, halfLifeDays)
}

/** Scope contribution: 1 for the current project, 0.7 for user, 0.2 otherwise. */
export function scopeMatchScore(record: { scope: MemoryScope }, currentProjectKey?: string): number {
  if (record.scope.type === 'user') return 0.7
  if (currentProjectKey !== undefined && record.scope.key === currentProjectKey) return 1
  return 0.2
}

/** Importance normalized from 1–10 into [0, 1]. */
export function importanceNorm(importance: number): number {
  return (Math.min(10, Math.max(1, importance)) - 1) / 9
}

/** Whether a record's TTL elapsed. */
export function isExpired(record: MemoryRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt < now
}

/** Whether a record is stale by the configured threshold. */
export function isStale(record: MemoryRecord, now: number, staleAfterDays: number): boolean {
  if (staleAfterDays <= 0) return false
  if (record.pinned) return false
  if (LONG_TERM_KINDS.has(record.kind)) return false
  const anchor = record.lastUsedAt ?? record.updatedAt
  return now - anchor > staleAfterDays * DAY_MS
}

/** Minimal metadata needed to score a memory without constructing a full record. */
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

/** Metadata minus the scope, so callers can score an indexed doc without copying it. */
export type ScoreDocMeta = Omit<ScoreMeta, 'scope'> & {
  /** Optional precomputed trust + importance + kind contribution. */
  priorScore?: number
}

/** Final weighted score for a lightweight metadata view plus its scope. */
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

/** Final weighted score for a lightweight metadata view. */
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

/** Final weighted score for one candidate. */
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

/** Core-layer score from §8.2. */
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

/** One scored candidate. */
export interface ScoredMemory {
  record: MemoryRecord
  score: number
  bm25: number
}

/** Remove exact-slug and near-duplicate summaries, keeping the higher score. */
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
 * Maximal marginal relevance over the top candidates.
 * `lambda = 0.7` balances relevance against redundancy.
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
