/**
 * 最小可用的面板页面。
 *
 * 不依赖构建工具或前端框架，直接由 connection 路由返回；所有数据都来自
 * 已有的 `/api/memory/*`，因此权限围栏、清洗和审计与 CLI 完全一致。
 */
export const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-memory</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#1f2328; --muted:#656d76; --line:#d0d7de; --accent:#0969da; --danger:#cf222e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#30363d; --accent:#58a6ff; --danger:#f85149; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  header { display:flex; gap:8px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:2; }
  header h1 { font-size:15px; margin:0 12px 0 0; }
  input, button, select { font:inherit; }
  input { flex:1; min-width:120px; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
  button { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--text); cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.danger:hover { border-color:var(--danger); color:var(--danger); }
  nav { display:flex; gap:6px; padding:10px 16px; border-bottom:1px solid var(--line); }
  nav button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  main { max-width:980px; margin:0 auto; padding:16px; }
  h2 { font-size:16px; margin:18px 0 8px; }
  h3 { font-size:13px; color:var(--muted); margin:14px 0 6px; text-transform:uppercase; letter-spacing:.04em; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; margin:8px 0; }
  .card .meta { color:var(--muted); font-size:12px; display:flex; gap:8px; flex-wrap:wrap; }
  .card .summary { margin:6px 0; }
  .card .id { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; color:var(--muted); }
  .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .muted { color:var(--muted); }
  .error { color:var(--danger); white-space:pre-wrap; }
  .badge { border:1px solid var(--line); border-radius:999px; padding:0 7px; font-size:11px; }
  pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); padding:10px; border-radius:6px; }
  form.search { display:flex; gap:8px; margin:8px 0 16px; }
</style>
</head>
<body>
<header>
  <h1>dsh-memory</h1>
  <input id="cwd" placeholder="项目路径（可选；留空表示所有项目）">
  <button id="reload">刷新</button>
</header>
<nav>
  <button data-tab="review" class="active">Review</button>
  <button data-tab="all">All</button>
  <button data-tab="search">Search</button>
  <button data-tab="stats">Stats</button>
</nav>
<main id="app"></main>
<script>
(function () {
  var API = '/api/memory';
  var cwdInput = document.getElementById('cwd');
  var app = document.getElementById('app');
  var tab = 'review';
  var cwd = localStorage.getItem('dsh-memory-cwd') || '';
  cwdInput.value = cwd;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function displayId(id) {
    var value = String(id || '');
    return value.indexOf('mem_') === 0 ? value : 'mem_' + value;
  }
  function params(extra) {
    var query = new URLSearchParams(extra || {});
    if (cwd) query.set('cwd', cwd);
    return query.toString();
  }
  async function get(path, extra) {
    var response = await fetch(API + path + '?' + params(extra), { headers: { accept: 'application/json' } });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.message || data.error || ('HTTP ' + response.status));
    return data;
  }
  async function post(path, body) {
    var response = await fetch(API + path + '?' + params(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.message || data.error || ('HTTP ' + response.status));
    return data;
  }
  function card(doc, actions) {
    var flags = (doc.flags || []).map(function (flag) { return '<span class="badge">' + esc(flag) + '</span>'; }).join('');
    return '<article class="card">' +
      '<div class="meta"><span class="badge">' + esc(doc.trust) + '</span><span class="badge">' + esc(doc.kind) + '</span>' +
      '<span>' + esc(doc.scope || '') + '</span>' + flags + '</div>' +
      '<div><strong>' + esc(doc.title) + '</strong></div>' +
      '<div class="summary">' + esc(doc.summary) + '</div>' +
      '<div class="id">' + esc(doc.id) + '</div>' +
      '<div class="actions">' + (actions || '') + '</div>' +
      '</article>';
  }
  function candidateActions(doc) {
    return '<button data-act="verify" data-id="' + esc(doc.id) + '">verify</button>' +
      '<button data-act="dispute" data-id="' + esc(doc.id) + '">dispute</button>' +
      '<button class="danger" data-act="mute" data-id="' + esc(doc.id) + '">mute</button>';
  }
  function conflictActions(doc) {
    var other = (doc.conflictOf || [])[0];
    if (!other) return '';
    var otherId = displayId(other);
    return '<button data-act="keep" data-id="' + esc(doc.id) + '" data-other="' + esc(otherId) + '">保留本条</button>' +
      '<button data-act="keep-other" data-id="' + esc(doc.id) + '" data-other="' + esc(otherId) + '">保留对方</button>' +
      '<button data-act="both" data-id="' + esc(doc.id) + '" data-other="' + esc(otherId) + '">都保留</button>' +
      '<button data-act="merge" data-id="' + esc(doc.id) + '" data-other="' + esc(otherId) + '">合并</button>' +
      '<span class="muted">冲突: ' + esc(otherId) + '</span>';
  }
  function commonActions(doc) {
    return '<button data-act="read" data-id="' + esc(doc.id) + '">read</button>' +
      '<button data-act="verify" data-id="' + esc(doc.id) + '">verify</button>' +
      '<button data-act="dispute" data-id="' + esc(doc.id) + '">dispute</button>' +
      '<button data-act="restore" data-id="' + esc(doc.id) + '">restore</button>' +
      '<button data-act="pin" data-id="' + esc(doc.id) + '" data-pinned="' + (doc.pinned ? '0' : '1') + '">' + (doc.pinned ? 'unpin' : 'pin') + '</button>' +
      '<button class="danger" data-act="mute" data-id="' + esc(doc.id) + '">mute</button>' +
      '<button class="danger" data-act="delete" data-id="' + esc(doc.id) + '">delete</button>';
  }
  function errorBox(error) {
    app.innerHTML = '<p class="error">' + esc(error && error.message ? error.message : error) + '</p>';
  }
  async function loadReview() {
    var data = await get('/review');
    var html = '<h2>待审核</h2>';
    html += '<div class="actions"><button data-act="scan">扫描历史冲突</button></div>';
    html += '<h3>候选 ' + data.candidates.length + '</h3>';
    html += data.candidates.length ? data.candidates.map(function (doc) { return card(doc, candidateActions(doc)); }).join('') : '<p class="muted">没有候选。</p>';
    html += '<h3>冲突 ' + data.conflicts.length + '</h3>';
    html += data.conflicts.length ? data.conflicts.map(function (doc) { return card(doc, conflictActions(doc) + commonActions(doc)); }).join('') : '<p class="muted">没有冲突。</p>';
    html += '<h3>陈旧 ' + data.stale.length + ' / 过期 ' + data.expired.length + '</h3>';
    app.innerHTML = html;
  }
  async function loadAll() {
    var data = await get('/list', { scope: 'all', limit: '50', includeAll: '1' });
    app.innerHTML = '<h2>全部记忆</h2>' + (data.entries.length ? data.entries.map(function (doc) { return card(doc, commonActions(doc)); }).join('') : '<p class="muted">没有记忆。</p>');
  }
  async function loadStats() {
    var data = await get('/stats');
    var rows = (data.scopes || []).map(function (scope) {
      return '<div class="card"><strong>' + esc(scope.scope) + '</strong> <span class="muted">' + esc(scope.docs) + ' 条，verified ' + esc(scope.verified) + '，candidate ' + esc(scope.candidate) + '</span></div>';
    }).join('');
    app.innerHTML = '<h2>统计</h2>' + rows + '<h3>原始响应</h3><pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>';
  }
  async function loadSearch() {
    app.innerHTML = '<h2>检索</h2><form class="search"><input id="q" placeholder="查询"><button>搜索</button></form><div id="results"></div>';
    var form = app.querySelector('form');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        var query = document.getElementById('q').value;
        var data = await get('/search', { q: query, scope: 'all', limit: '20' });
        document.getElementById('results').innerHTML = data.results.length
          ? data.results.map(function (hit) { return card(hit, commonActions(hit)); }).join('')
          : '<p class="muted">没有匹配。</p>';
      } catch (error) { errorBox(error); }
    });
    document.getElementById('q').focus();
  }
  async function load() {
    try {
      if (tab === 'review') await loadReview();
      else if (tab === 'all') await loadAll();
      else if (tab === 'search') await loadSearch();
      else await loadStats();
    } catch (error) { errorBox(error); }
  }
  async function act(button) {
    var id = button.getAttribute('data-id');
    var other = button.getAttribute('data-other');
    var action = button.getAttribute('data-act');
    try {
      if (action === 'verify') await post('/verify', { id: id });
      else if (action === 'scan') {
        var scan = await post('/scan-conflicts', { scope: 'all', cwd: cwd });
        alert('扫描 ' + scan.scanned + ' 条，发现 ' + scan.pairs.length + ' 对，标记 ' + scan.marked + ' 对。');
      }
      else if (action === 'dispute') await post('/dispute', { id: id });
      else if (action === 'restore') await post('/restore', { id: id });
      else if (action === 'pin') await post('/pin', { id: id, pinned: button.getAttribute('data-pinned') === '1' });
      else if (action === 'mute') await post('/forget', { id: id, hard: false });
      else if (action === 'delete') {
        if (!confirm('永久删除 ' + id + '？')) return;
        await post('/forget', { id: id, hard: true });
      } else if (action === 'read') {
        var record = await get('/read', { id: id });
        alert((record.record && record.record.title) || '已读取');
        return;
      } else if (action === 'keep') await post('/resolve', { keepId: id, otherId: other, mode: 'keep' });
      else if (action === 'keep-other') await post('/resolve', { keepId: other, otherId: id, mode: 'keep' });
      else if (action === 'both') await post('/resolve', { keepId: id, otherId: other, mode: 'both' });
      else if (action === 'merge') {
        var summary = prompt('合并后的 summary（留空沿用本条）');
        if (summary === null) return;
        var body = prompt('合并后的 body（留空沿用本条）');
        if (body === null) return;
        var merged = {};
        if (summary) merged.summary = summary;
        if (body) merged.body = body;
        await post('/resolve', { keepId: id, otherId: other, mode: 'merge', merged: merged });
      }
      await load();
    } catch (error) { errorBox(error); }
  }
  document.querySelector('nav').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-tab]');
    if (!button) return;
    tab = button.getAttribute('data-tab');
    document.querySelectorAll('nav button').forEach(function (item) { item.classList.toggle('active', item === button); });
    load();
  });
  app.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (button) act(button);
  });
  document.getElementById('reload').addEventListener('click', load);
  cwdInput.addEventListener('change', function () {
    cwd = cwdInput.value.trim();
    localStorage.setItem('dsh-memory-cwd', cwd);
    load();
  });
  load();
})();
</script>
</body>
</html>`
