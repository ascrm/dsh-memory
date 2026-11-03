import { describe, expect, it } from 'vitest'
import { termFrequencies, tokenize } from '../src/retrieval/tokenize.ts'

describe('tokenize', () => {
  it('lowercases latin words and splits code punctuation', () => {
    expect(tokenize('Use PNPM --filter app_name/path')).toEqual(['use', 'pnpm', 'filter', 'app', 'name', 'path'])
  })

  it('removes tiny English stopwords by default', () => {
    expect(tokenize('the build is part of the app')).toEqual(['build', 'part', 'app'])
    expect(tokenize('the build is part of the app', { keepStopwords: true })).toContain('the')
  })

  it('produces CJK bigrams by default', () => {
    expect(tokenize('记忆插件')).toEqual(['记忆', '忆插', '插件'])
  })

  it('optionally indexes CJK unigrams', () => {
    expect(tokenize('记忆插件', { cjkUnigrams: true })).toEqual(['记', '忆', '插', '件', '记忆', '忆插', '插件'])
  })

  it('handles mixed Chinese and English', () => {
    expect(tokenize('使用 pnpm 管理')).toEqual(['使用', 'pnpm', '管理'])
  })

  it('applies light latin stemming', () => {
    expect(tokenize('builds building deployed')).toEqual(['build', 'build', 'deploy'])
  })

  it('returns no tokens for punctuation-only input', () => {
    expect(tokenize('!@#$%^&*()')).toEqual([])
  })

  it('counts weighted frequencies', () => {
    const frequencies = termFrequencies('pnpm pnpm build')
    expect(frequencies.get('pnpm')).toBe(2)
    expect(frequencies.get('build')).toBe(1)
  })
})
