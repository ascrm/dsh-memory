# dsh-memory

[![CI](https://github.com/ascrm/dsh-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/ascrm/dsh-memory/actions/workflows/ci.yml)

本地优先、纯文件的跨会话记忆插件，面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的编码场景。

设计依据：[docs/dsh-memory-plugin-design.md](docs/dsh-memory-plugin-design.md)。

- **文件是真相**：一条记忆一个 Markdown 文件，索引 `index.json` 是派生物，可随时删除重建。
- **两层记忆**：核心层常驻系统提示词（默认 ≤ 1 KB）；召回层通过 `memory_search` / `memory_read` 按需读取。
- **用户验证，模型提议**：`memory_write` 只能写 `candidate`；`verified` / `disputed` / `restore` / `pin` 只能由用户操作。
- **可审计**：写入、验证、争议、遗忘、注入、检索都写入 `audit.jsonl`，且不记录正文和查询原文。
- **安全**：协议壳转义、单行化、密钥脱敏、原子写、跨进程文件锁、YAML 解析限制、symlink 跳过。

## 安装

```bash
dsh plugin add /path/to/dsh-memory
# 或发布后
dsh plugin add dsh-memory
```

插件包入口为 `lib/index.js`，同时提供 `cordis.patch.yml`。

## 配置

配置由 `@deepseek-ai/schemastery` 声明，默认值如下；在 profile patch 中整表覆盖：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `memoryDir` | `$DSH_HOME/memory` | 记忆根目录 |
| `maxCoreBytes` | `1024` | 核心层字节预算 |
| `maxCoreItems` | `8` | 核心层条数上限 |
| `maxSearchResults` | `8` | 默认检索条数 |
| `maxBodyBytes` | `8192` | 单条 body 上限 |
| `enableRecall` | `true` | 按当前用户消息做 per-turn recall |
| `recallMaxBytes` | `1024` | recall 段字节预算 |
| `recallMaxItems` | `5` | recall 段最大条数 |
| `recallIncludeCandidates` | `false` | recall 是否包含未验证候选 |
| `recallTimeoutMs` | `500` | 冷索引超时后放弃本回合 recall |
| `indexBackend` | `json` | 派生索引后端：`json` 或 `sqlite`（FTS5） |
| `cjkUnigrams` | `false` | 是否额外索引 CJK 单字；开启后支持单字查询，但索引更大 |
| `enableUserScope` | `true` | 启用用户级记忆 |
| `enableAutoCapture` | `false` | agent 结束时自动提取候选 |
| `autoCaptureMaxTokens` | `2048` | 自动提取输出上限 |
| `autoCaptureMaxItems` | `5` | 单次自动提取最多写入条数 |
| `trustCandidatesInCore` | `false` | 是否允许候选进入核心层 |
| `staleAfterDays` | `180` | 未使用多久视为陈旧（0 关闭） |
| `decayHalfLifeDays` | `180` | 排序衰减半衰期 |
| `projectScope` | `git` | 项目身份：`git` 或 `path` |
| `enablePanel` | `true` | `connection` 可用时注册 HTTP API |
| `redactPhoneAndId` | `false` | 额外脱敏手机号/身份证号 |

```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    memoryDir: ~/.dsh/memory
    maxCoreBytes: 1024
    maxCoreItems: 8
    projectScope: git
    enableRecall: true
    indexBackend: json
    cjkUnigrams: false
    enableAutoCapture: false
```

## 工具

| 工具 | 作用 |
|---|---|
| `memory_search` | BM25 + 元数据排序，返回 id / 摘要 / 信任状态 |
| `memory_read` | 读取正文、provenance、信任状态，展开一层 `[[links]]` |
| `memory_write` | 新建或更新记忆；始终写为 `candidate` |
| `memory_forget` | 默认静音；`hard=true` 永久删除，走 dsh 审批 |
| `memory_list` | 只读摘要列表（调试用） |
| `memory_refresh` | 手改 Markdown 后重建派生索引 |

模型不能设置 `trust` / `pinned` / `verifiedBy`，模型侧也没有 `memory_verify` 工具；用户可通过 CLI 或面板 API 完成验证。

## 命令行

发布包同时提供 `dsh-memory` CLI，直接操作同一个记忆库；写操作按用户身份执行。安装插件后可直接使用：

```bash
dsh-memory --help
dsh-memory list --scope all
dsh-memory search "pnpm build" --limit 5
dsh-memory show <id|slug>
dsh-memory write --slug use-pnpm --kind preference --title "Use pnpm" --summary "Use pnpm for builds" --body "pnpm build"
dsh-memory edit <id|slug> --summary "Updated summary"
dsh-memory review --scope all
dsh-memory verify <id|slug>
dsh-memory dispute <id|slug>
dsh-memory restore <id|slug>
dsh-memory pin <id|slug>
dsh-memory unpin <id|slug>
dsh-memory forget <id|slug> [--hard]
dsh-memory resolve <keep> <other> [--mode keep|merge|both] [--summary "merged"]
dsh-memory supersede <old> <new>
dsh-memory refresh
dsh-memory core
dsh-memory stats
dsh-memory doctor --fix --json
dsh-memory export --scope user --format agents --out AGENTS.md
dsh-memory import ./memories --scope user
```

- 全局选项：`--dir <path>`（默认 `$DSH_HOME/memory`）、`--cwd <path>`、`--json`。
- `write` / `edit` 支持 `--body-file <path>`；`write` 默认 `--scope user`，项目记忆用 `--scope project`。
- `review` 列出候选与冲突；`doctor --fix` 会扫描历史数据并补写双向冲突标记。
- `forget --hard` 由用户直接执行，不会触发 dsh 的审批弹窗；执行前请自行确认。
- 从源码运行：`pnpm build && node lib/cli.js ...`。
- CLI 入口为 `lib/cli.js`，由 `package.json` 的 `bin` 字段安装为 `dsh-memory`。

## 存储布局

```text
$DSH_HOME/memory/
  audit.jsonl
  projects/<projectKey>/
    project.json
    memories/<ULID>.md
    index.json
    index.sqlite        # indexBackend: sqlite 时使用
    index.md
  user/
    memories/<ULID>.md
    index.json
    index.sqlite
    index.md
  tmp/
```

项目身份优先使用 git remote + 相对路径：

```text
repo-<sha256(normalizedRemote + '\0' + relativePath).slice(0, 12)>
```

没有 git 时退化为 `path-<sha256(normalizedCwd).slice(0, 12)>`。因此仓库换路径、重新 clone 后记忆仍可命中；monorepo 子包拥有独立 scope。

记忆文件使用稳定 ULID 作为主键，slug 只用于展示和检索；未知 frontmatter 字段会原样保留。

## 信任与生命周期

```text
candidate --用户 verify--> verified
candidate/verified --用户 dispute--> disputed
disputed --用户 restore--> candidate
verified --内容变化（title/summary/body/kind）--> candidate（evidence 失效）
用户 supersede --> 旧条 superseded + 新条 supersedes
```

- `disputed` / `superseded` / `muted` / 过期记忆不进入核心层。
- `candidate` 默认不进入核心层，但会出现在检索结果中并带标记。
- `episode` 默认 90 天过期；陈旧判定只影响核心层和展示，不自动删除文件。
- 新写入与已有记忆疑似冲突时，两边都会写入 `conflictOf`，进入 review queue。
- review queue 支持 `keep`（保留一条、取代另一条）、`merge`（合并内容后取代）和 `both`（都保留、只清除冲突标记）。

## 检索

- 分词：拉丁词 + 轻量英文词干（复数/ing/ed）；CJK 默认切二元组，`cjkUnigrams=true` 时额外索引单字；代码符号作为分隔符。
- BM25：`k1=1.2`、`b=0.75`；字段权重 title 3 / summary 2 / tags 2 / body 1。
- 最终分数：BM25 0.55 + recency 0.15 + trust 0.12 + importance 0.08 + scope 0.05 + kind 0.05。
- 去重后使用 MMR（`lambda=0.7`）在 top-20 内选出 top-k。
- 默认排除 `muted` / 过期 / `disputed` / `superseded`。
- 关键词命中不足时，用其余记忆的元数据分补足头部候选；`includeMetadataFallback: false`（recall 使用）可关闭。
- JSON 与 SQLite 后端共用同一套评分和 fallback 行为。

## per-turn recall

宿主时序（已在 `dsh-agent-loop` 中确认）：

```text
inbox.claim()
  → agent/inbox/claimed      ← 记录当前用户文本
  → systemPrompt.assemble()  ← 在这里异步检索并插入 recall 段
  → user/message             ← 组装之后才 append
```

因此 recall 可以影响**当前这一步**，而不是延迟到下一轮：

- 从 claimed 的用户消息提取查询（只取 text block，忽略工具/上下文消息）；
- 检索范围是 user + 当前 project，不包含其他项目；
- 默认只注入 `verified`，并排除已经在核心层的 ID；
- 受 `recallMaxBytes`、`recallMaxItems` 限制，默认 1 KB / 5 条；
- 冷索引检索超过 `recallTimeoutMs` 时放弃本回合 recall，不阻塞请求；
- 结果放在独立的 `<memory_recall>` 段，不混入核心层。

## 面板 API

`connection` 服务可用且 `enablePanel=true` 时注册：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/memory/list` | GET | 按 scope/kind 列出摘要 |
| `/api/memory/read` | GET | 读取单条 |
| `/api/memory/write` | POST | 用户编辑/写入 |
| `/api/memory/verify` | POST | 用户验证 |
| `/api/memory/dispute` | POST | 标记争议 |
| `/api/memory/restore` | POST | 恢复为 candidate |
| `/api/memory/pin` | POST | 用户置顶/取消置顶 |
| `/api/memory/resolve` | POST | 解决冲突：`keep` / `merge` / `both` |
| `/api/memory/scan-conflicts` | POST | 扫描历史数据并补写双向冲突标记 |
| `/api/memory/supersede` | POST | 标记被取代 |
| `/api/memory/forget` | POST | 静音/删除 |
| `/api/memory/review` | GET | 候选、冲突、陈旧、过期 |
| `/api/memory/panel` | GET | 内置最小面板页面 |
| `/api/memory/search` | GET | 调试检索 |
| `/api/memory/stats` | GET | 计数、审计、核心缓存 |
| `/api/memory/core` | GET | 当前核心层文本与预算 |
| `/api/memory/export` | GET | `md` / `agents` / `json` |
| `/api/memory/import` | POST | JSON 导入（始终 candidate） |
| `/api/memory/refresh` | POST | 重建索引 |
| `/api/memory/doctor` | GET | 一致性检查 |
| `/api/memory/config` | GET | 生效配置 |

路由位于 dsh 认证围栏内，默认 loopback；不提供推送，浏览器操作后自行 refetch。

内置面板：启动 dsh 后打开 `/api/memory/panel`。页面使用同一组 API，提供 Review（候选/冲突/扫描）、All、Search、Stats 四个视图，以及 verify/dispute/restore/pin/forget/resolve 操作。

解决冲突示例：

```http
POST /api/memory/resolve
Content-Type: application/json

{
  "keepId": "mem_01J...",
  "otherId": "mem_01K...",
  "mode": "merge",
  "merged": {
    "summary": "合并后的摘要",
    "tags": ["tooling"]
  }
}
```

`mode=keep` 保留 keep 并把 other 标记为 superseded；`mode=merge` 先合并内容再取代 other；`mode=both` 只清除双向冲突标记。

## 自动捕获（Phase 2）

默认关闭。开启后：

1. 监听根会话的 `user/message`（仅 `source.kind === 'user'`）与 `assistant/message`。
2. 缓冲上限 40 轮 / 24k 字符；忽略 subagent。
3. `agent/disposed` 时调用当前 provider/model，要求输出 JSON 数组。
4. 校验字段、长度、kind/scope、evidence（逐字出现在转写中），去重后写入 `candidate`。
5. 任何失败静默处理，不影响会话。

审核入口：`dsh-memory review`、面板 `/api/memory/panel` 的 Review 标签，或直接调用 `/api/memory/review`。候选可以逐条 verify/dispute/mute；冲突可以 keep/merge/both。

即使关闭自动捕获，插件也会保留最近转写用于 `memory_write` 的 evidence 校验；没有可用转写时保留 evidence。

## 安全边界

- 所有进入提示词/工具结果的文本经过 `singleLine` + `escapeFrame` + `redactSecrets`。
- 磁盘内容不可信：手改文件在每次读取/注入时重新清洗。
- 写入走 `MemoryStore`：`withFileLock` 串行化，`writeFileAtomic` 原子替换，`tmp/` 与目标同文件系统。
- 孤儿锁：超时后读取锁内 PID；`process.kill(pid, 0)` 返回 `ESRCH` 才删除并重试一次。
- 审计失败只告警，不阻塞主流程；单文件超过 5 MB 轮转并保留尾部一半。
- 读取/列举跳过 symlink；文件名由 ULID 生成，不接受用户路径。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm bench:sqlite   # 10k 条性能回归（SQLite FTS5）
pnpm bench:json     # 10k 条性能回归（JSON 索引）
```

- `src/index.ts`：插件入口、`Config`、核心层 section、per-turn recall、审批钩子。
- `src/cli.ts`：`dsh-memory` 命令行工具。
- `src/panel.ts`：无构建依赖的最小面板 HTML。
- `src/store/`：路径身份、frontmatter、清洗、存储、JSON/SQLite 派生索引、审计。
- `src/retrieval/`：分词、BM25、评分与 MMR。
- `src/injection/`：核心层选择与缓存、per-turn recall、注入审计。
- `tests/`：单元、集成、安全、CLI、增量索引、历史冲突扫描与并发测试。
- `tests/e2e/host-services.spec.ts`：使用真实 `SystemPrompt` / `ToolRuntime` / Cordis 事件的宿主服务 e2e。
- `scripts/perf-10k.mjs`：10k 条性能回归，带冷构建、重开、search p95 阈值。
- `.github/workflows/ci.yml`：Node 22/24、Windows/Linux 的 CI 矩阵，外加 Ubuntu Node 24 的 10k 性能 job。

## 已知限制

- **核心层冷启动**：`systemPrompt.section.text` 必须同步且不读盘；apply 阶段会异步预热用户级 core pack，若首轮组装早于预热完成，仍可能为空，下一轮即有内容。
- **recall 依赖宿主事件**：`agent/inbox/claimed` 与 `system-prompt/assemble` 的时序已按当前 dsh-agent-loop 验证；更老或不同宿主若不发该事件，recall 会静默跳过。
- **故意不做文件 watcher**：外部手改在下次 `agent/created` / `memory_refresh` 时通过 state/哈希检测。
- **索引规模**：默认 `indexBackend: json`；10k 条进程重开约 5–6s。设置 `indexBackend: sqlite` 可用 FTS5，重开通常 < 1s，但首次建库仍需全量解析 Markdown（本机 10k 约 12s），且依赖 Node 的 `node:sqlite`（不可用/损坏时自动回退 JSON，30 秒后重试）。
- **SQLite 写入**：默认每次写入会同步大小/修改时间并增量更新数据库；10k 条单次写入约 0.5s，明显优于 JSON 全量重建，但不是常数时间。
- **JSON 增量写入**：写入后会增量更新 docs/postings，并重写 index.json；10k 条单次写入约 0.16s，仍会随索引大小线性增长。
- **SQLite 快路径**：文件 size/mtime 未变时不会重读内容；极端情况下手改保持相同 size/mtime，需要 `memory_refresh` 强制重建。
- **CJK 单字索引**：`cjkUnigrams` 默认关闭；开启后支持单字查询，但 postings/FTS 会明显变大，10k 搜索 p95 也会上升。切换该配置会使旧索引自动失效并重建。
- **检索没有向量模型**：当前是词法检索（BM25 + 元数据 + 词干）；embedding/hybrid 需要外部 embedding provider，未内置。
- **与 dsh-auto-memory 共用目录**：两者默认都使用 `$DSH_HOME/memory`，且都有 `audit.jsonl`。同时安装时请为其中一个设置独立的 `memoryDir`，或禁用另一个。
- **不内置 React 面板**：提供 CLI 与 HTTP 面板 API；React 客户端仍属可选扩展。
- `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`，用于在 Windows 沙箱/打包器下正确解析 tsdown 的传递依赖。

## License

MIT
