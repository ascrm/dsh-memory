/**
 * 面向中英混排文本和代码标识符的分词器。
 *
 * 连续的拉丁字符按小写单词切分，并做轻量词干化；连续的 CJK 字符同时切成
 * 单字和字符二元组，保证“单字查询”也能命中。代码标点作为分隔符。
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'of', 'to', 'and', 'or'])

/** 轻量英文词干：只处理常见复数/进行时/过去式，避免引入完整词干库。 */
function stemLatin(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses')) return word.slice(0, -2)
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1)
  return word
}

/** 把文本切分为小写拉丁词干和 CJK 单字/二元组。 */
export function tokenize(text: string, options: { keepStopwords?: boolean } = {}): string[] {
  const lower = text.toLowerCase()
  const parts = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    if (/^[a-z0-9]+$/.test(part)) {
      if (options.keepStopwords === true || !STOPWORDS.has(part)) out.push(stemLatin(part))
    } else {
      const chars = [...part]
      for (const char of chars) out.push(char)
      for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!)
    }
  }
  return out
}

/** 单段文本的词频表。 */
export function termFrequencies(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const token of tokenize(text)) {
    out.set(token, (out.get(token) ?? 0) + 1)
  }
  return out
}
