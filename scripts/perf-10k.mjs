#!/usr/bin/env node
/**
 * 10k 条记忆的性能回归。
 *
 * 用法：pnpm build && node scripts/perf-10k.mjs [sqlite|json]
 * 阈值可用环境变量覆盖：
 *   PERF_MAX_COLD_MS / PERF_MAX_REOPEN_MS / PERF_MAX_SEARCH_P95_MS
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MemoryStore, normalizeConfig } from '../lib/index.js'

const backend = process.argv[2] === 'sqlite' ? 'sqlite' : 'json'
const COUNT = 10_000
const SEARCHES = 30
const MAX_COLD_MS = Number(process.env.PERF_MAX_COLD_MS ?? 60_000)
const MAX_REOPEN_MS = Number(process.env.PERF_MAX_REOPEN_MS ?? 10_000)
const MAX_SEARCH_P95_MS = Number(process.env.PERF_MAX_SEARCH_P95_MS ?? 100)
const MAX_WRITE_MS = Number(process.env.PERF_MAX_WRITE_MS ?? 1_000)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulid(now = Date.now()) {
  let time = Math.floor(now)
  let prefix = ''
  for (let i = 0; i < 10; i += 1) {
    prefix = CROCKFORD[time % 32] + prefix
    time = Math.floor(time / 32)
  }
  const random = randomBytes(16)
  let suffix = ''
  for (let i = 0; i < 16; i += 1) suffix += CROCKFORD[random[i] % 32]
  return prefix + suffix
}

const KINDS = ['fact', 'decision', 'constraint', 'preference', 'artifact']
const base = await mkdtemp(join(tmpdir(), 'dsh-memory-perf-'))
const root = join(base, 'memory')
const scope = { type: 'user' }
const memories = join(root, 'user', 'memories')
await mkdir(memories, { recursive: true })

function memoryText(index) {
  const id = ulid()
  const kind = KINDS[index % KINDS.length]
  return {
    id,
    text: `---
schemaVersion: 1
id: ${id}
slug: perf-memory-${index}
kind: ${kind}
scope: user
title: Performance memory ${index}
summary: Build and deployment guidance number ${index % 200} for the service
tags: [perf, build]
trust: verified
importance: ${(index % 10) + 1}
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
useCount: 0
source: {}
pinned: false
muted: false
revision: 1
---

The quick brown fox builds service number ${index} with pnpm and deploys it.
`
  }
}

for (let start = 0; start < COUNT; start += 200) {
  const batch = []
  for (let index = start; index < Math.min(COUNT, start + 200); index += 1) {
    const item = memoryText(index)
    batch.push(writeFile(join(memories, `${item.id}.md`), item.text, 'utf8'))
  }
  await Promise.all(batch)
}

const config = normalizeConfig({ memoryDir: root, indexBackend: backend, enableRecall: false })
const store = new MemoryStore(root, config)
const query = 'build service pnpm deployment'

async function timed(fn) {
  const start = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - start }
}

const cold = await timed(() => store.getScopeIndex(scope, { refresh: true }))
const searchTimes = []
for (let i = 0; i < SEARCHES; i += 1) {
  const result = await timed(() =>
    store.search({ query, scope: 'user', limit: 8 })
  )
  searchTimes.push(result.ms)
}
searchTimes.sort((a, b) => a - b)
const p50 = searchTimes[Math.floor(searchTimes.length * 0.5)]
const p95 = searchTimes[Math.floor(searchTimes.length * 0.95)]
const docs = cold.value.docs.size
const write = await timed(() =>
  store.write({
    slug: 'perf-after-10k',
    kind: 'preference',
    title: 'Perf write after 10k',
    summary: 'Incremental write should stay fast after ten thousand memories',
    body: 'one extra memory',
    scope: { type: 'user' }
  })
)
const rssMb = process.memoryUsage().rss / 1024 / 1024
store.close()

const reopened = new MemoryStore(root, config)
const reopen = await timed(() => reopened.search({ query, scope: 'user', limit: 8 }))
reopened.close()
await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

const result = {
  backend,
  count: docs,
  coldMs: Math.round(cold.ms),
  reopenMs: Math.round(reopen.ms),
  searchP50Ms: Math.round(p50 * 100) / 100,
  searchP95Ms: Math.round(p95 * 100) / 100,
  writeMs: Math.round(write.ms * 100) / 100,
  rssMb: Math.round(rssMb),
  limits: {
    coldMs: MAX_COLD_MS,
    reopenMs: MAX_REOPEN_MS,
    searchP95Ms: MAX_SEARCH_P95_MS,
    writeMs: MAX_WRITE_MS
  }
}
console.log(JSON.stringify(result, null, 2))

const failures = []
if (cold.ms > MAX_COLD_MS) failures.push(`cold ${cold.ms.toFixed(0)}ms > ${MAX_COLD_MS}ms`)
if (reopen.ms > MAX_REOPEN_MS) failures.push(`reopen ${reopen.ms.toFixed(0)}ms > ${MAX_REOPEN_MS}ms`)
if (p95 > MAX_SEARCH_P95_MS) failures.push(`search p95 ${p95.toFixed(1)}ms > ${MAX_SEARCH_P95_MS}ms`)
if (write.ms > MAX_WRITE_MS) failures.push(`single write ${write.ms.toFixed(0)}ms > ${MAX_WRITE_MS}ms`)
if (docs !== COUNT) failures.push(`indexed ${docs} != ${COUNT}`)
if (failures.length > 0) {
  console.error(`PERF FAIL (${backend}): ${failures.join('; ')}`)
  process.exitCode = 1
}
