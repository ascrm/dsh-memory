window.__ModuleLoader__.load({
  id: '@ascrm88/dsh-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const ID = '@ascrm88/dsh-memory'
    const API = '/api/memory'

    const CSS = `
      .dshm-root {
        --dshm-bg: #f7f8fa;
        --dshm-card: #ffffff;
        --dshm-text: #333333;
        --dshm-muted: #6b7280;
        --dshm-line: #e7e9ee;
        --dshm-soft: #f1f3f6;
        --dshm-accent: #1f2937;
        --dshm-accent-hover: #111827;
        --dshm-danger: #dc2626;
        --dshm-shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 8px 24px rgba(15, 23, 42, .04);
        min-height: 100%;
        box-sizing: border-box;
        padding: 20px;
        color: var(--dshm-text);
        background: var(--dshm-bg);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.55;
      }
      @media (prefers-color-scheme: dark) {
        .dshm-root {
          --dshm-bg: #0f1115;
          --dshm-card: #171a21;
          --dshm-text: #d7dce3;
          --dshm-muted: #8b93a1;
          --dshm-line: #272b35;
          --dshm-soft: #1d212a;
          --dshm-accent: #e5e7eb;
          --dshm-accent-hover: #ffffff;
          --dshm-danger: #f87171;
          --dshm-shadow: 0 1px 2px rgba(0, 0, 0, .25), 0 8px 24px rgba(0, 0, 0, .18);
        }
      }
      .dshm-root * { box-sizing: border-box; }
      .dshm-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
      .dshm-eyebrow { margin: 0 0 4px; color: var(--dshm-muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
      .dshm-title { margin: 0; font-size: 20px; line-height: 1.2; font-weight: 650; letter-spacing: -.02em; }
      .dshm-subtitle { margin: 6px 0 0; color: var(--dshm-muted); font-size: 12px; }
      .dshm-tabs { display: flex; gap: 4px; padding: 4px; margin-bottom: 18px; background: var(--dshm-soft); border-radius: 11px; }
      .dshm-tab { flex: 1; border: 0; border-radius: 8px; padding: 8px 6px; color: var(--dshm-muted); background: transparent; font: inherit; font-size: 12px; cursor: pointer; transition: all .2s ease; }
      .dshm-tab:hover { color: var(--dshm-text); }
      .dshm-tab[data-active="true"] { color: var(--dshm-text); background: var(--dshm-card); box-shadow: 0 1px 2px rgba(15, 23, 42, .08); }
      .dshm-section { margin: 0 0 8px; color: var(--dshm-muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
      .dshm-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
      .dshm-card { padding: 16px; border: 1px solid var(--dshm-line); border-radius: 14px; background: var(--dshm-card); box-shadow: var(--dshm-shadow); transition: border-color .2s ease, transform .2s ease; }
      .dshm-card:hover { border-color: color-mix(in srgb, var(--dshm-accent) 22%, var(--dshm-line)); }
      .dshm-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; color: var(--dshm-muted); font-size: 11px; }
      .dshm-badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; background: var(--dshm-soft); color: var(--dshm-muted); font-size: 10px; line-height: 1.6; }
      .dshm-badge[data-tone="verified"] { color: #15803d; background: rgba(22, 163, 74, .1); }
      .dshm-badge[data-tone="candidate"] { color: #a16207; background: rgba(202, 138, 4, .1); }
      .dshm-badge[data-tone="disputed"] { color: var(--dshm-danger); background: rgba(220, 38, 38, .08); }
      .dshm-card-title { margin: 0 0 4px; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
      .dshm-summary { margin: 0 0 8px; color: var(--dshm-muted); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
      .dshm-id { color: var(--dshm-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
      .dshm-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
      .dshm-btn { border: 1px solid transparent; border-radius: 8px; padding: 6px 10px; color: var(--dshm-text); background: var(--dshm-soft); font: inherit; font-size: 11px; cursor: pointer; transition: all .2s ease; }
      .dshm-btn:hover { background: var(--dshm-line); }
      .dshm-btn:active { transform: scale(.97); }
      .dshm-btn[data-primary="true"] { color: #fff; background: var(--dshm-accent); }
      .dshm-btn[data-primary="true"]:hover { background: var(--dshm-accent-hover); }
      .dshm-btn[data-danger="true"] { color: var(--dshm-danger); background: transparent; }
      .dshm-btn[data-danger="true"]:hover { background: rgba(220, 38, 38, .08); }
      .dshm-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
      .dshm-input { width: 100%; border: 1px solid transparent; border-radius: 10px; padding: 10px 12px; color: var(--dshm-text); background: var(--dshm-soft); font: inherit; font-size: 12px; outline: none; transition: all .2s ease; }
      .dshm-input::placeholder { color: var(--dshm-muted); }
      .dshm-input:focus { border-color: var(--dshm-accent); background: var(--dshm-card); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dshm-accent) 12%, transparent); }
      .dshm-search { display: flex; gap: 8px; margin-bottom: 16px; }
      .dshm-search .dshm-btn { white-space: nowrap; padding-left: 14px; padding-right: 14px; }
      .dshm-empty { padding: 28px 16px; border: 1px dashed var(--dshm-line); border-radius: 12px; color: var(--dshm-muted); text-align: center; font-size: 12px; }
      .dshm-error { margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; color: var(--dshm-danger); background: rgba(220, 38, 38, .07); font-size: 12px; }
      .dshm-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .dshm-stat { padding: 14px; border: 1px solid var(--dshm-line); border-radius: 12px; background: var(--dshm-card); }
      .dshm-stat strong { display: block; margin-top: 3px; font-size: 20px; font-weight: 650; letter-spacing: -.03em; }
      .dshm-stat span { color: var(--dshm-muted); font-size: 11px; }
      .dshm-detail { margin-bottom: 16px; padding: 16px; border: 1px solid var(--dshm-line); border-radius: 14px; background: var(--dshm-card); box-shadow: var(--dshm-shadow); }
      .dshm-detail pre { max-height: 260px; margin: 10px 0 0; padding: 10px; overflow: auto; border-radius: 9px; background: var(--dshm-soft); color: var(--dshm-text); font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
      .dshm-target { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dshm-line); color: var(--dshm-muted); font-size: 11px; }
      .dshm-target .dshm-actions { margin-top: 7px; }
      .dshm-spacer { flex: 1; }
    `

    const TRUST_LABEL = {
      candidate: '候选',
      verified: '已验证',
      disputed: '有争议',
      superseded: '已取代'
    }
    const KIND_LABEL = {
      preference: '偏好',
      fact: '事实',
      constraint: '约束',
      decision: '决策',
      episode: '片段',
      artifact: '产物'
    }
    const SOURCE_LABEL = {
      sessionId: '会话',
      messageId: '消息',
      tool: '工具',
      file: '文件',
      commit: '提交',
      url: '链接'
    }

    function scopeLabel(value) {
      if (value === 'user') return '用户级'
      if (typeof value === 'string' && value.startsWith('project:')) return '项目级'
      return value || ''
    }

    function displayId(value) {
      const text = String(value || '')
      return text.startsWith('mem_') ? text : 'mem_' + text
    }

    function errorMessage(error) {
      if (error && error.status === 401) return '认证已过期，请刷新 DSH 页面后重试。'
      return error && error.message ? error.message : '请求失败，请稍后重试。'
    }

    async function request(path, params, init) {
      const url = new URL(API + path, window.location.origin)
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
      const response = await fetch(url, Object.assign({ credentials: 'same-origin', headers: { accept: 'application/json' } }, init))
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(data.message || data.error || 'HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      return data
    }

    const get = (path, params) => request(path, params)
    const post = (path, body) => request(path, {}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    })

    function installStyles() {
      const style = document.createElement('style')
      style.dataset.dshMemory = 'panel'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    function Badge({ children, tone }) {
      return h('span', { className: 'dshm-badge', 'data-tone': tone }, children)
    }

    function Button({ children, onClick, primary, danger, disabled }) {
      return h('button', {
        type: 'button',
        className: 'dshm-btn',
        'data-primary': primary ? 'true' : undefined,
        'data-danger': danger ? 'true' : undefined,
        disabled,
        onClick
      }, children)
    }

    function Card({ doc, children }) {
      return h('article', { className: 'dshm-card' },
        h('div', { className: 'dshm-meta' },
          h(Badge, { tone: doc.trust }, TRUST_LABEL[doc.trust] || doc.trust),
          h('span', null, KIND_LABEL[doc.kind] || doc.kind),
          doc.scope ? h('span', null, scopeLabel(doc.scope)) : null
        ),
        h('h3', { className: 'dshm-card-title' }, doc.title),
        h('p', { className: 'dshm-summary' }, doc.summary),
        h('div', { className: 'dshm-id' }, displayId(doc.id)),
        children ? h('div', { className: 'dshm-actions' }, children) : null
      )
    }

    function MemoryBody({ useSessions, sessionId }) {
      const cwd = useSessions((store) => sessionId ? store.byId[sessionId] && store.byId[sessionId].cwd : undefined)
      const [tab, setTab] = React.useState('review')
      const [review, setReview] = React.useState(null)
      const [entries, setEntries] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [results, setResults] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      async function load(kind) {
        setLoading(true)
        setError('')
        try {
          if (kind === 'review') setReview(await get('/review', { cwd }))
          else if (kind === 'all') setEntries((await get('/list', { scope: 'all', limit: 50, includeAll: 1, cwd })).entries)
          else if (kind === 'stats') setStats(await get('/stats', { cwd }))
          else if (kind === 'search') setResults((await get('/search', { q: query, scope: 'all', limit: 20, cwd })).results)
        } catch (failure) {
          setError(errorMessage(failure))
        } finally {
          setLoading(false)
        }
      }

      React.useEffect(() => {
        if (tab !== 'search') void load(tab)
      }, [tab, cwd])

      async function mutate(action) {
        setBusy(true)
        setError('')
        try {
          await action()
          await load(tab)
        } catch (failure) {
          setError(errorMessage(failure))
        } finally {
          setBusy(false)
        }
      }

      const verify = (id) => mutate(() => post('/verify', { id }))
      const dispute = (id) => mutate(() => post('/dispute', { id }))
      const restore = (id) => mutate(() => post('/restore', { id }))
      const pin = (id, pinned) => mutate(() => post('/pin', { id, pinned: !pinned }))
      const mute = (id) => mutate(() => post('/forget', { id, hard: false }))
      const remove = (id) => {
        if (!window.confirm('确定永久删除这条记忆？此操作不可撤销。')) return
        void mutate(() => post('/forget', { id, hard: true }))
      }
      const read = async (id) => {
        setBusy(true)
        try {
          const data = await get('/read', { id, cwd })
          setDetail(data.record)
        } catch (failure) {
          setError(errorMessage(failure))
        } finally {
          setBusy(false)
        }
      }
      const keep = (id, other) => mutate(() => post('/resolve', { keepId: id, otherId: other, mode: 'keep' }))
      const keepOther = (id, other) => mutate(() => post('/resolve', { keepId: other, otherId: id, mode: 'keep' }))
      const both = (id, other) => mutate(() => post('/resolve', { keepId: id, otherId: other, mode: 'both' }))
      const merge = (id, other) => {
        const summary = window.prompt('合并后的摘要（留空沿用本条）')
        if (summary === null) return
        const body = window.prompt('合并后的正文（留空沿用本条）')
        if (body === null) return
        const merged = {}
        if (summary.trim().length > 0) merged.summary = summary.trim()
        if (body.trim().length > 0) merged.body = body.trim()
        void mutate(() => post('/resolve', { keepId: id, otherId: other, mode: 'merge', merged }))
      }

      function commonActions(doc) {
        return [
          h(Button, { key: 'read', onClick: () => void read(doc.id) }, '读取'),
          h(Button, { key: 'verify', onClick: () => void verify(doc.id) }, '验证'),
          h(Button, { key: 'dispute', onClick: () => void dispute(doc.id) }, '争议'),
          h(Button, { key: 'restore', onClick: () => void restore(doc.id) }, '恢复'),
          h(Button, { key: 'pin', onClick: () => void pin(doc.id, doc.pinned) }, doc.pinned ? '取消置顶' : '置顶'),
          h(Button, { key: 'mute', onClick: () => void mute(doc.id) }, '静音'),
          h(Button, { key: 'delete', danger: true, onClick: () => remove(doc.id) }, '删除')
        ]
      }

      function conflictActions(doc) {
        const targets = doc.conflictOf || []
        return targets.map((other) => h('div', { key: other, className: 'dshm-target' },
          '冲突对象：' + displayId(other),
          h('div', { className: 'dshm-actions' },
            h(Button, { onClick: () => void keep(doc.id, displayId(other)), primary: true }, '保留本条'),
            h(Button, { onClick: () => void keepOther(doc.id, displayId(other)) }, '保留对方'),
            h(Button, { onClick: () => void both(doc.id, displayId(other)) }, '都保留'),
            h(Button, { onClick: () => void merge(doc.id, displayId(other)) }, '合并')
          )
        ))
      }

      function reviewView() {
        const value = review || { candidates: [], conflicts: [], stale: [], expired: [] }
        return h('div', null,
          h('div', { className: 'dshm-eyebrow' }, '待处理'),
          h('h2', { className: 'dshm-title' }, '记忆审核'),
          h('p', { className: 'dshm-subtitle' }, '验证候选、处理冲突，保持核心层干净。'),
          h('div', { className: 'dshm-section' }, '候选 ' + value.candidates.length),
          value.candidates.length === 0
            ? h('div', { className: 'dshm-empty' }, '暂无候选记忆')
            : h('div', { className: 'dshm-list' }, value.candidates.map((doc) => h(Card, { key: doc.id, doc },
              h(Button, { primary: true, onClick: () => void verify(doc.id) }, '验证'),
              h(Button, { onClick: () => void dispute(doc.id) }, '标记争议'),
              h(Button, { onClick: () => void mute(doc.id) }, '静音')
            ))),
          h('div', { className: 'dshm-section', style: { marginTop: '18px' } }, '冲突 ' + value.conflicts.length),
          value.conflicts.length === 0
            ? h('div', { className: 'dshm-empty' }, '暂无冲突')
            : h('div', { className: 'dshm-list' }, value.conflicts.map((doc) => h(Card, { key: doc.id, doc },
              conflictActions(doc),
              commonActions(doc)
            ))),
          h('div', { className: 'dshm-subtitle', style: { marginTop: '10px' } },
            '陈旧 ' + value.stale.length + ' 条 · 过期 ' + value.expired.length + ' 条')
        )
      }

      function allView() {
        return h('div', null,
          h('div', { className: 'dshm-eyebrow' }, '全部记忆'),
          h('h2', { className: 'dshm-title' }, '记忆库'),
          h('p', { className: 'dshm-subtitle' }, '浏览、验证和整理已持久化的记忆。'),
          entries === null
            ? h('div', { className: 'dshm-empty' }, '加载中…')
            : entries.length === 0
              ? h('div', { className: 'dshm-empty' }, '还没有记忆')
              : h('div', { className: 'dshm-list' }, entries.map((doc) => h(Card, { key: doc.id, doc }, commonActions(doc))))
        )
      }

      function searchView() {
        return h('div', null,
          h('div', { className: 'dshm-eyebrow' }, '检索'),
          h('h2', { className: 'dshm-title' }, '搜索记忆'),
          h('p', { className: 'dshm-subtitle' }, '用自然语言关键词检索，只返回当前作用域内的结果。'),
          h('form', {
            className: 'dshm-search',
            onSubmit: (event) => {
              event.preventDefault()
              setTab('search')
              void load('search')
            }
          },
            h('input', {
              className: 'dshm-input',
              value: query,
              placeholder: '例如：pnpm 构建、部署地址…',
              onChange: (event) => setQuery(event.target.value)
            }),
            h(Button, { primary: true, onClick: () => { setTab('search'); void load('search') } }, '搜索')
          ),
          results === null
            ? h('div', { className: 'dshm-empty' }, '输入关键词开始搜索')
            : results.length === 0
              ? h('div', { className: 'dshm-empty' }, '没有匹配的记忆')
              : h('div', { className: 'dshm-list' }, results.map((doc) => h(Card, { key: doc.id, doc }, commonActions(doc))))
        )
      }

      function statsView() {
        const scopes = stats ? stats.scopes || [] : []
        const total = scopes.reduce((sum, scope) => sum + scope.docs, 0)
        const verified = scopes.reduce((sum, scope) => sum + (scope.byTrust.verified || 0), 0)
        const candidates = scopes.reduce((sum, scope) => sum + (scope.byTrust.candidate || 0), 0)
        return h('div', null,
          h('div', { className: 'dshm-eyebrow' }, '概览'),
          h('h2', { className: 'dshm-title' }, '统计'),
          h('p', { className: 'dshm-subtitle' }, '当前作用域的规模与信任分布。'),
          h('div', { className: 'dshm-stats' },
            h('div', { className: 'dshm-stat' }, h('span', null, '记忆总数'), h('strong', null, String(total))),
            h('div', { className: 'dshm-stat' }, h('span', null, '已验证'), h('strong', null, String(verified))),
            h('div', { className: 'dshm-stat' }, h('span', null, '待验证'), h('strong', null, String(candidates))),
            h('div', { className: 'dshm-stat' }, h('span', null, '作用域'), h('strong', null, String(scopes.length)))
          ),
          h('div', { className: 'dshm-section', style: { marginTop: '18px' } }, '按作用域'),
          scopes.length === 0
            ? h('div', { className: 'dshm-empty' }, '暂无数据')
            : h('div', { className: 'dshm-list' }, scopes.map((scope) => h('div', { className: 'dshm-card', key: scope.scope },
              h('div', { className: 'dshm-meta' }, h('span', null, scopeLabel(scope.scope))),
              h('div', { className: 'dshm-card-title' }, scope.docs + ' 条记忆'),
              h('div', { className: 'dshm-summary' }, '已验证 ' + (scope.byTrust.verified || 0) + ' · 候选 ' + (scope.byTrust.candidate || 0))
            )))
        )
      }

      function openSource(record) {
        const source = record.source || {}
        const parts = Object.entries(source).filter(([, value]) => typeof value === 'string' && value.length > 0)
        if (parts.length === 0) {
          window.alert('这条记忆没有记录来源。')
          return
        }
        window.alert(parts.map(([key, value]) => (SOURCE_LABEL[key] || key) + ': ' + value).join('\n'))
      }

      const content = tab === 'review' ? reviewView() : tab === 'all' ? allView() : tab === 'search' ? searchView() : statsView()

      return h('div', { className: 'dshm-root' },
        h('div', { className: 'dshm-header' },
          h('div', null,
            h('p', { className: 'dshm-eyebrow' }, 'dsh-memory'),
            h('h1', { className: 'dshm-title' }, '记忆'),
            h('p', { className: 'dshm-subtitle' }, '跨会话的本地记忆，随时可查。'),
            cwd ? h('p', { className: 'dshm-subtitle', style: { marginTop: '2px' } }, '项目：' + cwd) : null
          ),
          h('div', { className: 'dshm-spacer' }),
          h(Button, { onClick: () => void load(tab), disabled: loading }, loading ? '刷新中…' : '刷新')
        ),
        h('div', { className: 'dshm-tabs' }, [
          ['review', '审核'],
          ['all', '全部'],
          ['search', '搜索'],
          ['stats', '统计']
        ].map(([key, label]) => h('button', {
          key,
          type: 'button',
          className: 'dshm-tab',
          'data-active': tab === key ? 'true' : 'false',
          onClick: () => setTab(key)
        }, label))),
        error ? h('div', { className: 'dshm-error' }, error) : null,
        detail ? h('div', { className: 'dshm-detail' },
          h('div', { className: 'dshm-meta' },
            h(Badge, { tone: detail.trust }, TRUST_LABEL[detail.trust] || detail.trust),
            h('span', null, KIND_LABEL[detail.kind] || detail.kind)
          ),
          h('h3', { className: 'dshm-card-title' }, detail.title),
          h('p', { className: 'dshm-summary' }, detail.summary),
          h('pre', null, detail.body || '（无正文）'),
          h('div', { className: 'dshm-actions' },
            h(Button, { onClick: () => setDetail(null) }, '关闭'),
            h(Button, { primary: true, onClick: () => { setDetail(null); void verify(detail.id) } }, '验证'),
            h(Button, { onClick: () => void openSource(detail) }, '来源')
          )
        ) : null,
        content
      )
    }

    const definition = {
      id: ID,
      kind: 'memory',
      priority: 'extension',
      keepMounted: true,
      title: () => '记忆',
      guide: [
        {
          order: 20,
          title: () => '记忆',
          description: () => '浏览、验证和整理跨会话记忆'
        }
      ]
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-memory: sidebar styles')
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'dsh-memory: sidebar tab')
      ctx.effect(
        () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID
        }, MemoryBody)),
        'dsh-memory: sidebar body'
      )
      // 首次加载时自动打开一次“记忆”tab；之后尊重用户关闭的选择。
      ctx.inject(['sidebarRight'], (scope) => {
        scope.effect(() => {
          let timer
          let attempts = 0
          try {
            if (window.localStorage.getItem('dsh-memory:auto-opened') === '1') return () => {}
          } catch {
            // localStorage 不可用时仍然尝试一次。
          }
          const attempt = () => {
            try {
              scope.sidebarRight.openTab('memory')
              try { window.localStorage.setItem('dsh-memory:auto-opened', '1') } catch {}
              return
            } catch {
              if (++attempts >= 20) return
              timer = window.setTimeout(attempt, 500)
            }
          }
          timer = window.setTimeout(attempt, 350)
          return () => window.clearTimeout(timer)
        }, 'dsh-memory: open sidebar once')
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
