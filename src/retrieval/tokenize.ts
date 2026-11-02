/**
 * Tokenizer for mixed English/CJK and code identifiers.
 *
 * Latin runs are lowercased words; CJK runs become character bigrams. Code
 * punctuation (`-`, `_`, `/`, `--flag`) is a separator, as specified.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'of', 'to', 'and', 'or'])

/** Split text into lowercase latin words and CJK bigrams. */
export function tokenize(text: string, options: { keepStopwords?: boolean } = {}): string[] {
  const lower = text.toLowerCase()
  const parts = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    if (/^[a-z0-9]+$/.test(part)) {
      if (options.keepStopwords === true || !STOPWORDS.has(part)) out.push(part)
    } else {
      for (let i = 0; i + 1 < part.length; i += 1) out.push(part.slice(i, i + 2))
    }
  }
  return out
}

/** Token frequency map for one text. */
export function termFrequencies(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const token of tokenize(text)) {
    out.set(token, (out.get(token) ?? 0) + 1)
  }
  return out
}
