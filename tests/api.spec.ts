import { afterEach, describe, expect, it } from 'vitest'
import { createStore, type StoreHarness } from './helpers.ts'
import { registerMemoryApi } from '../src/api.ts'
import { CoreCache } from '../src/injection/core.ts'

let harness: StoreHarness | undefined

afterEach(async () => {
  if (harness !== undefined) await harness.cleanup()
  harness = undefined
})

function makeApi() {
  const harnessValue = harness!
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const connection = {
    fetch: {
      register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route.fetch)
        return () => {}
      }
    }
  }
  const core = new CoreCache(harnessValue.store, harnessValue.config)
  registerMemoryApi(connection as never, { store: harnessValue.store, config: harnessValue.config, core })
  return {
    call: async (path: string, init?: RequestInit) => {
      const url = `http://localhost/api/memory${path}`
      const routePath = new URL(url).pathname
      const handler = routes.get(routePath)
      if (handler === undefined) throw new Error(`route not found: ${routePath}`)
      return handler(new Request(url, init))
    }
  }
}

describe('panel API', () => {
  it('writes, reads, verifies, injects and mutes', async () => {
    harness = await createStore()
    const api = makeApi()

    const write = await api.call('/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'api-memory',
        kind: 'preference',
        title: 'API memory',
        summary: 'Written through the panel API',
        body: 'Use pnpm.',
        scope: 'user'
      })
    })
    expect(write.status).toBe(200)
    const created = (await write.json()) as { record: { id: string; trust: string } }
    expect(created.record.trust).toBe('candidate')

    const list = await api.call('/list?scope=user')
    const listed = (await list.json()) as { entries: Array<{ id: string }> }
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]?.id).toBe(created.record.id)

    const read = await api.call(`/read?id=${encodeURIComponent(created.record.id)}`)
    const readBody = (await read.json()) as { record: { body: string } }
    expect(readBody.record.body).toContain('Use pnpm.')

    const verify = await api.call('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.record.id })
    })
    const verified = (await verify.json()) as { record: { trust: string } }
    expect(verified.record.trust).toBe('verified')

    const coreResponse = await api.call('/core')
    const core = (await coreResponse.json()) as { text: string; bytes: number; maxCoreBytes: number }
    expect(core.text).toContain('Written through the panel API')
    expect(core.bytes).toBeLessThanOrEqual(core.maxCoreBytes)

    const mute = await api.call('/forget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.record.id, hard: false })
    })
    expect(((await mute.json()) as { mode: string }).mode).toBe('mute')
    const afterMute = (await (await api.call('/list?scope=user')).json()) as { entries: unknown[] }
    expect(afterMute.entries).toHaveLength(0)
  })

  it('serves the minimal panel page', async () => {
    harness = await createStore()
    const api = makeApi()
    const response = await api.call('/panel')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await response.text()).toContain('dsh-memory')
    const scan = await api.call('/scan-conflicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'user' })
    })
    expect(scan.status).toBe(200)
    expect((await scan.json()) as { scanned: number }).toMatchObject({ scanned: 0 })
  })

  it('resolves a bidirectional conflict through the panel API', async () => {
    harness = await createStore()
    const api = makeApi()
    const first = await harness.store.write({
      slug: 'conflict-a',
      kind: 'preference',
      title: 'Conflict A',
      summary: 'Use pnpm for package management',
      body: 'a',
      scope: { type: 'user' }
    })
    const second = await harness.store.write({
      slug: 'conflict-b',
      kind: 'preference',
      title: 'Conflict B',
      summary: 'Use pnpm for package management',
      body: 'b',
      scope: { type: 'user' }
    })
    const response = await api.call('/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keepId: first.record.id,
        otherId: second.record.id,
        mode: 'keep'
      })
    })
    expect(response.status).toBe(200)
    const resolved = (await response.json()) as { keep: { trust: string }; other: { trust: string } }
    expect(resolved.keep.trust).toBe('candidate')
    expect(resolved.other.trust).toBe('superseded')
    const keep = await harness.store.locate(first.record.id, { scope: { type: 'user' } })
    expect(keep?.record.conflictOf).toBeUndefined()
    const review = (await (await api.call('/review')).json()) as { conflicts: unknown[] }
    expect(review.conflicts).toHaveLength(0)
  })

  it('reports stats, review, doctor and export', async () => {
    harness = await createStore()
    const api = makeApi()
    await harness.store.write({
      slug: 'export-me',
      kind: 'preference',
      title: 'Export me',
      summary: 'Verified preference for export',
      body: 'body',
      scope: { type: 'user' }
    })
    const located = await harness.store.locate('export-me', { scope: { type: 'user' } })
    await harness.store.verify(located!.record.id, { type: 'user' })

    const stats = (await (await api.call('/stats')).json()) as { scopes: Array<{ docs: number }> }
    expect(stats.scopes[0]?.docs).toBe(1)

    const review = (await (await api.call('/review')).json()) as { candidates: unknown[] }
    expect(Array.isArray(review.candidates)).toBe(true)

    const doctor = (await (await api.call('/doctor')).json()) as { checked: number; findings: unknown[] }
    expect(doctor.checked).toBe(1)
    expect(Array.isArray(doctor.findings)).toBe(true)

    const exported = (await (await api.call('/export?scope=user&format=agents')).json()) as { content: string }
    expect(exported.content).toContain('Export me')

    const config = (await (await api.call('/config')).json()) as { config: Record<string, unknown>; root: string }
    expect(config.root).toBe(harness.store.root)
    expect(config.config.maxCoreBytes).toBe(1024)
  })
})
