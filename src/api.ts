/**
 * Optional HTTP panel API, registered on the host `connection` service.
 *
 * Routes live inside dsh's authenticated fence (loopback by default). The API
 * never accepts filesystem paths: project files are always derived from the
 * `cwd` query/body field, and ids are validated by the store.
 */
import type { MemoryConfig, MemoryRecord, MemoryScope } from './types.ts'
import { MemoryError, MEMORY_KINDS, type MemoryKind } from './types.ts'
import type { MemoryStore } from './store/store.ts'
import type { CoreCache } from './injection/core.ts'
import { displayId } from './ids.ts'
import { scopeKey } from './store/paths.ts'
import { sanitizeBody, sanitizeInjectionText, singleLine } from './store/sanitize.ts'
import { detectSuspicious } from './store/sanitize.ts'
import { selectCore } from './injection/core.ts'

interface PanelRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

interface ConnectionLike {
  fetch: {
    register(route: PanelRoute): unknown
  }
}

/** Dependencies for the panel API. */
export interface PanelDeps {
  store: MemoryStore
  config: MemoryConfig
  core: CoreCache
}

const BASE = '/api/memory'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

function errorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404
    case 'DUPLICATE_SLUG':
      return 409
    case 'BODY_TOO_LARGE':
      return 413
    case 'LOCK_TIMEOUT':
      return 503
    case 'INVALID_SLUG':
    case 'RESERVED_SLUG':
    case 'SCOPE_REQUIRED':
    case 'SCOPE_FORBIDDEN':
    case 'INVALID_ARGUMENT':
      return 400
    case 'SCHEMA_TOO_NEW':
      return 409
    default:
      return 500
  }
}

function failure(error: unknown): Response {
  if (error instanceof MemoryError) {
    return json({ error: error.code, message: error.message, details: error.details }, errorStatus(error.code))
  }
  return json({ error: 'INTERNAL', message: String(error) }, 500)
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json()
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function panelRecord(record: MemoryRecord): Record<string, unknown> {
  return {
    id: displayId(record.id),
    slug: record.slug,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    body: sanitizeBody(record.body),
    trust: record.trust,
    scope: scopeKey(record.scope),
    tags: record.tags,
    importance: record.importance,
    pinned: record.pinned,
    muted: record.muted,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt ?? null,
    useCount: record.useCount,
    expiresAt: record.expiresAt ?? null,
    source: record.source,
    evidence: record.evidence ?? null,
    supersedes: record.supersedes !== undefined ? displayId(record.supersedes) : null,
    supersededBy: record.supersededBy !== undefined ? displayId(record.supersededBy) : null,
    conflictOf: (record.conflictOf ?? []).map(displayId),
    verifiedBy: record.verifiedBy ?? null,
    verifiedAt: record.verifiedAt ?? null,
    revision: record.revision,
    flags: detectSuspicious(`${record.title}\n${record.summary}\n${record.body}`) ? ['suspicious'] : []
  }
}

/** Resolve a project scope from a cwd parameter. */
function projectScopeOf(store: MemoryStore, cwd: string | undefined): MemoryScope | undefined {
  return cwd !== undefined && cwd.length > 0 ? store.scopeForCwd(cwd) : undefined
}

function resolveScope(
  store: MemoryStore,
  value: unknown,
  cwd: string | undefined,
  kind?: MemoryKind
): MemoryScope {
  if (value === 'user') return { type: 'user' }
  if (value === 'project') {
    const scope = projectScopeOf(store, cwd)
    if (scope === undefined) throw new MemoryError('SCOPE_REQUIRED', 'project scope requires cwd')
    return scope
  }
  if (kind === 'preference' || kind === 'artifact') {
    return store.config.enableUserScope ? { type: 'user' } : (projectScopeOf(store, cwd) ?? { type: 'project', key: '' })
  }
  const scope = projectScopeOf(store, cwd)
  if (scope === undefined) throw new MemoryError('SCOPE_REQUIRED', 'project scope requires cwd')
  return scope
}

/** Register the panel API on a connection service. */
export function registerMemoryApi(connection: ConnectionLike, deps: PanelDeps): void {
  const { store, config, core } = deps

  connection.fetch.register({
    path: `${BASE}/list`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const cwd = url.searchParams.get('cwd') ?? undefined
        const scopeParam = url.searchParams.get('scope') ?? 'all'
        const projectScope = projectScopeOf(store, cwd)
        if (scopeParam === 'project' && projectScope === undefined) {
          return json({ error: 'SCOPE_REQUIRED', message: 'project scope requires cwd' }, 400)
        }
        const kindParam = url.searchParams.get('kind')
        const kind = kindParam !== null && MEMORY_KINDS.includes(kindParam as MemoryKind) ? (kindParam as MemoryKind) : undefined
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
        const docs = await store.list({
          scope: scopeParam === 'user' || scopeParam === 'project' ? scopeParam : 'all',
          projectScope,
          kind,
          includeAll: url.searchParams.get('includeAll') === '1',
          limit: Number.isFinite(limit) ? limit : undefined
        })
        return json({
          entries: docs.map((doc) => ({
            ...doc,
            id: displayId(doc.id),
            title: singleLine(doc.title, 80),
            summary: sanitizeInjectionText(doc.summary, 200),
            flags: detectSuspicious(`${doc.title}\n${doc.summary}`) ? ['suspicious'] : []
          }))
        })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/read`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const id = url.searchParams.get('id') ?? url.searchParams.get('slug') ?? ''
        const cwd = url.searchParams.get('cwd') ?? undefined
        const scopeParam = url.searchParams.get('scope')
        const projectScope = projectScopeOf(store, cwd)
        const scope =
          scopeParam === 'user'
            ? { type: 'user' as const }
            : scopeParam === 'project'
              ? projectScope
              : undefined
        if (scopeParam === 'project' && scope === undefined) {
          return json({ error: 'SCOPE_REQUIRED', message: 'project scope requires cwd' }, 400)
        }
        const located = await store.read(id, { scope, projectScope: scope === undefined ? projectScope : undefined })
        if (located === undefined) return json({ error: 'NOT_FOUND' }, 404)
        return json({ record: panelRecord(located.record) })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/write`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
        const kind = MEMORY_KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : undefined
        if (kind === undefined) return json({ error: 'INVALID_ARGUMENT', message: 'invalid kind' }, 400)
        let scope: MemoryScope
        if (typeof body.id === 'string' && body.id.length > 0 && body.scope === undefined) {
          const existing = await store.locate(body.id, { allProjects: true })
          scope = existing?.scope ?? resolveScope(store, body.scope, cwd, kind)
        } else {
          scope = resolveScope(store, body.scope, cwd, kind)
        }
        if (scope.type === 'project') {
          if (scope.key.length === 0) return json({ error: 'SCOPE_REQUIRED', message: 'project scope requires cwd' }, 400)
          if (cwd !== undefined) await store.ensureProject(scope, cwd)
        }
        const result = await store.write(
          {
            id: typeof body.id === 'string' ? body.id : undefined,
            slug: typeof body.slug === 'string' ? body.slug : undefined,
            kind,
            title: typeof body.title === 'string' ? body.title : '',
            summary: typeof body.summary === 'string' ? body.summary : '',
            body: typeof body.body === 'string' ? body.body : '',
            tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
            importance: typeof body.importance === 'number' ? body.importance : undefined,
            scope,
            evidence: typeof body.evidence === 'string' ? body.evidence : undefined
          },
          { actor: 'user' }
        )
        core.invalidate(scope)
        return json({ record: panelRecord(result.record), operation: result.operation, conflicts: result.conflicts.map(displayId) })
      } catch (error) {
        return failure(error)
      }
    }
  })

  const lifecycle = (
    name: 'verify' | 'dispute' | 'restore',
    action: (id: string, scope: MemoryScope) => Promise<MemoryRecord>
  ): void => {
    connection.fetch.register({
      path: `${BASE}/${name}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readBody(request)
          const id = typeof body.id === 'string' ? body.id : ''
          const located = await store.locate(id, { allProjects: true })
          if (located === undefined) return json({ error: 'NOT_FOUND' }, 404)
          const record = await action(id, located.scope)
          core.invalidate(located.scope)
          return json({ record: panelRecord(record) })
        } catch (error) {
          return failure(error)
        }
      }
    })
  }
  lifecycle('verify', (id, scope) => store.verify(id, scope))
  lifecycle('dispute', (id, scope) => store.dispute(id, scope))
  lifecycle('restore', (id, scope) => store.restore(id, scope))

  connection.fetch.register({
    path: `${BASE}/pin`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const id = typeof body.id === 'string' ? body.id : ''
        const located = await store.locate(id, { allProjects: true })
        if (located === undefined) return json({ error: 'NOT_FOUND' }, 404)
        const record = await store.setPinned(id, body.pinned === true, located.scope)
        core.invalidate(located.scope)
        return json({ record: panelRecord(record) })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/forget`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const id = typeof body.id === 'string' ? body.id : ''
        const hard = body.hard === true
        const located = await store.locate(id, { allProjects: true })
        if (located === undefined) return json({ error: 'NOT_FOUND' }, 404)
        await store.forget(id, hard ? 'delete' : 'mute', located.scope)
        core.invalidate(located.scope)
        return json({ id: displayId(located.record.id), mode: hard ? 'delete' : 'mute' })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/supersede`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const oldId = typeof body.oldId === 'string' ? body.oldId : ''
        const newId = typeof body.newId === 'string' ? body.newId : ''
        const oldLocated = await store.locate(oldId, { allProjects: true })
        if (oldLocated === undefined) return json({ error: 'NOT_FOUND', message: 'oldId not found' }, 404)
        await store.supersede(oldId, newId, oldLocated.scope)
        core.invalidate(oldLocated.scope)
        return json({ ok: true })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/review`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const projectScope = projectScopeOf(store, url.searchParams.get('cwd') ?? undefined)
        const review = await store.review(projectScope)
        const map = (docs: typeof review.candidates) =>
          docs.map((doc) => ({ ...doc, id: displayId(doc.id), summary: sanitizeInjectionText(doc.summary, 200) }))
        return json({
          candidates: map(review.candidates),
          conflicts: map(review.conflicts),
          stale: map(review.stale),
          expired: map(review.expired)
        })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/stats`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const projectScope = projectScopeOf(store, url.searchParams.get('cwd') ?? undefined)
        const stats = await store.stats(projectScope)
        return json({ ...stats, core: core.stats() })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/search`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const query = url.searchParams.get('q') ?? ''
        const projectScope = projectScopeOf(store, url.searchParams.get('cwd') ?? undefined)
        const scopeParam = url.searchParams.get('scope')
        const scope = scopeParam === 'user' || scopeParam === 'project' ? scopeParam : 'all'
        const hits = await store.search({
          query,
          scope,
          projectScope,
          includeDisputed: url.searchParams.get('includeDisputed') === '1',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '', 10) || undefined,
          actor: 'user'
        })
        return json({ results: hits.map((hit) => ({ ...hit, id: displayId(hit.id), scope: scopeKey(hit.scope) })) })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/export`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const cwd = url.searchParams.get('cwd') ?? undefined
        const scope = resolveScope(store, url.searchParams.get('scope') ?? 'project', cwd)
        const formatParam = url.searchParams.get('format') ?? 'json'
        const format = formatParam === 'md' || formatParam === 'agents' ? formatParam : 'json'
        return json(await store.exportScope(scope, format))
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/import`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
        const scope = resolveScope(store, body.scope, cwd)
        const memories = Array.isArray(body.memories) ? body.memories : []
        const result = await store.importRecords(scope, memories as Partial<MemoryRecord>[])
        core.invalidate(scope)
        return json(result)
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/refresh`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
        const scopeParam = body.scope
        const scope =
          scopeParam === 'user'
            ? ({ type: 'user' } as MemoryScope)
            : scopeParam === 'project'
              ? projectScopeOf(store, cwd)
              : undefined
        if (scopeParam === 'project' && scope === undefined) {
          return json({ error: 'SCOPE_REQUIRED', message: 'project scope requires cwd' }, 400)
        }
        const result = await store.refresh(scope)
        core.invalidate({ type: 'user' })
        return json(result)
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/doctor`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const projectScope = projectScopeOf(store, url.searchParams.get('cwd') ?? undefined)
        return json(await store.doctor(projectScope))
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/core`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const projectScope = projectScopeOf(store, url.searchParams.get('cwd') ?? undefined)
        const records = await store.coreRecords(projectScope)
        const pack = selectCore(records, config, Date.now(), projectScope)
        return json({
          text: pack.text,
          ids: pack.ids.map(displayId),
          bytes: pack.bytes,
          omitted: pack.omitted,
          maxCoreBytes: config.maxCoreBytes,
          maxCoreItems: config.maxCoreItems,
          sessions: core.stats()
        })
      } catch (error) {
        return failure(error)
      }
    }
  })

  connection.fetch.register({
    path: `${BASE}/config`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const { memoryDir: _memoryDir, ...publicConfig } = config
      return json({
        config: publicConfig,
        root: store.root,
        kinds: MEMORY_KINDS
      })
    }
  })
}
