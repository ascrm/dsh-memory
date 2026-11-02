/**
 * BM25 over weighted fields.
 *
 * Field weights are applied to term frequencies at index build time:
 * title ×3, summary ×2, tags ×2, body ×1. `dl` is the weighted token count so
 * the length normalization matches the stored frequencies.
 */
import type { MemoryRecord } from '../types.ts'
import { tokenize } from './tokenize.ts'

/** BM25 tuning constants from the design. */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

/** Field weights. */
export const FIELD_WEIGHTS = {
  title: 3,
  summary: 2,
  tags: 2,
  body: 1
} as const

/** One document's weighted terms and length. */
export interface Bm25Document {
  terms: Map<string, number>
  length: number
}

/** Postings plus corpus statistics. */
export interface Bm25Corpus {
  docs: Map<string, Bm25Document>
  postings: Map<string, Map<string, number>>
  docCount: number
  avgdl: number
}

function addWeighted(target: Map<string, number>, text: string, weight: number): number {
  let added = 0
  for (const token of tokenize(text)) {
    target.set(token, (target.get(token) ?? 0) + weight)
    added += weight
  }
  return added
}

/** Build the weighted term map and length for one record. */
export function indexRecord(record: MemoryRecord): Bm25Document {
  const terms = new Map<string, number>()
  let length = 0
  length += addWeighted(terms, record.title, FIELD_WEIGHTS.title)
  length += addWeighted(terms, record.summary, FIELD_WEIGHTS.summary)
  length += addWeighted(terms, record.tags.join(' '), FIELD_WEIGHTS.tags)
  length += addWeighted(terms, record.body, FIELD_WEIGHTS.body)
  return { terms, length }
}

/** Build a full corpus from records. */
export function buildBm25Corpus(records: readonly MemoryRecord[]): Bm25Corpus {
  const docs = new Map<string, Bm25Document>()
  const postings = new Map<string, Map<string, number>>()
  let totalLength = 0
  for (const record of records) {
    const doc = indexRecord(record)
    docs.set(record.id, doc)
    totalLength += doc.length
    for (const [term, tf] of doc.terms) {
      let posting = postings.get(term)
      if (posting === undefined) {
        posting = new Map<string, number>()
        postings.set(term, posting)
      }
      posting.set(record.id, tf)
    }
  }
  const docCount = docs.size
  return {
    docs,
    postings,
    docCount,
    avgdl: docCount === 0 ? 0 : totalLength / docCount
  }
}

/** Whether a token is indexed. */
export function hasTerm(corpus: Bm25Corpus, term: string): boolean {
  return corpus.postings.has(term)
}

/** Compute raw BM25 scores for one query. */
export function bm25Scores(query: string, corpus: Bm25Corpus): Map<string, number> {
  const scores = new Map<string, number>()
  if (corpus.docCount === 0 || corpus.avgdl <= 0) return scores
  const terms = tokenize(query)
  if (terms.length === 0) return scores
  const unique = [...new Set(terms)]
  for (const term of unique) {
    const posting = corpus.postings.get(term)
    if (posting === undefined) continue
    const df = posting.size
    const idf = Math.log(1 + (corpus.docCount - df + 0.5) / (df + 0.5))
    for (const [id, tf] of posting) {
      const doc = corpus.docs.get(id)
      if (doc === undefined) continue
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / corpus.avgdl))
      const contribution = idf * ((tf * (BM25_K1 + 1)) / (denom === 0 ? 1 : denom))
      scores.set(id, (scores.get(id) ?? 0) + contribution)
    }
  }
  return scores
}

/** Normalize BM25 scores into [0, 1] by dividing by the maximum. */
export function normalizeBm25(scores: Map<string, number>): Map<string, number> {
  let max = 0
  for (const score of scores.values()) if (score > max) max = score
  if (max <= 0) return new Map()
  const out = new Map<string, number>()
  for (const [id, score] of scores) out.set(id, score / max)
  return out
}
