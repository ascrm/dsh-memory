# dsh-memory

[![CI](https://github.com/ascrm/dsh-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/ascrm/dsh-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地优先记忆插件。记忆以 Markdown 文件为唯一事实来源，索引只是可删除、可重建的检索缓存。

> **Status:** `0.1.x`。核心协议与磁盘格式仍在收敛，升级前请阅读变更记录并保留备份。

设计细节见 [docs/dsh-memory-plugin-design.md](docs/dsh-memory-plugin-design.md)。

## 目录

- [设计目标](#设计目标)
- [功能概览](#功能概览)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [模型工具](#模型工具)
- [命令行](#命令行)
- [面板与 HTTP API](#面板与-http-api)
- [存储布局](#存储布局)
- [信任与冲突](#信任与冲突)
- [检索与 recall](#检索与-recall)
- [自动捕获](#自动捕获)
- [安全模型](#安全模型)
- [性能](#性能)
- [开发](#开发)
- [已知限制](#已知限制)
- [License](#license)

## 设计目标

`dsh-memory` 解决的是编码 agent 的跨会话记忆问题，但刻意不做成“把所有东西塞进上下文”的 RAG 服务。

- **本地优先**：默认写入 `$DSH_HOME/memory`，不依赖数据库服务或云端 API。
- **文件即事实**：每条记忆一个 Markdown 文件；`index.json` / `index.sqlite` 可随时删除重建。
- **两层预算**：核心层常驻系统提示词（默认 ≤ 1 KB），召回层通过工具按需读取，避免上下文膨胀。
- **人在回路**：模型只能提议 `candidate`，验证、争议、置顶、取代等信任操作由用户完成。
- **可审计**：写入、验证、争议、遗忘、注入、检索均记录到 `audit.jsonl`；不记录正文与查询原文。
- **可恢复**：派生索引损坏或后端不可用时自动回退，不把索引当作唯一数据源。

## 功能概览

| 能力 | 说明 |
|---|---|
| 跨会话记忆 | 用户级、项目级、多项目 scope |
| 核心注入 | 同步缓存，硬性字节与条数预算 |
| per-turn recall | 根据当前用户消息注入相关记忆 |
| 检索 | BM25 + 元数据排序 + MMR 多样性 |
| 信任生命周期 | `candidate` / `verified` / `disputed` / `superseded` |
| 冲突处理 | 双向 `conflictOf`，review queue 支持 keep / merge / both |
| 索引后端 | JSON（默认）或 SQLite FTS5（可选） |
| 用户界面 | `dsh-memory` CLI、最小 HTTP 面板、JSON API |
| 自动捕获 | 可选，agent 结束时提取候选记忆 |
| 安全 | 提示词框架转义、单行化、密钥脱敏、原子写、文件锁 |

## 工作原理

```text
用户消息
  │
  ├─ agent/inbox/claimed ──────▶ RecallService（当前轮查询）
  │
  └─ system-prompt/assemble ───▶ <memory_context> 核心层
                                 <memory_recall> 召回层
                                        │
模型 ── memory_search / memory_read ────┘
模型 ── memory_write ──▶ candidate ──▶ Markdown 文件
                                        │
                                   index.json / index.sqlite
```

- **核心层**：从 `verified` 记忆中选取，按预算截断，经同步缓存进入系统提示词；`text` 回调不读盘。
- **召回层**：在 `system-prompt/assemble` 阶段异步检索当前用户消息，结果放入独立段，不污染核心层。
- **工具层**：模型显式调用 `memory_search` / `memory_read` 获取更完整的上下文。
- **写入层**：所有写操作经过 `MemoryStore`，使用跨进程锁与原子替换。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`。
- DeepSeek Harness 及以下 peer 包（由 dsh 提供）：
  - `@deepseek-ai/cordis`
  - `@deepseek-ai/dsh-agent`
  - `@deepseek-ai/dsh-atomic-write`
  - `@deepseek-ai/dsh-home-paths`
  - `@deepseek-ai/dsh-llm`
  - `@deepseek-ai/dsh-session`
  - `@deepseek-ai/dsh-system-prompt`
  - `@deepseek-ai/dsh-tools`
- SQLite 后端使用 Node 内置 `node:sqlite`，不需要原生扩展；Node 构建需包含 FTS5。

## 安装

从本地 checkout 安装：

```bash
dsh plugin add /path/to/dsh-memory
```

发布到 npm 后也可以直接安装：

```bash
dsh plugin add @ascrm88/dsh-memory
```

插件入口为 `lib/index.js`，包内附带 `cordis.patch.yml`。典型的 profile 配置：

```yaml
- id: dsh-memory
  name: '@ascrm88/dsh-memory'
  config:
    memoryDir: ~/.dsh/memory
    enableRecall: true
    indexBackend: json
```

## 快速开始

1. 安装插件并重启 dsh。
2. 让 agent 记住一条信息，例如“项目使用 pnpm 构建”。模型会通过 `memory_write` 写入 `candidate`。
3. 由用户验证：

   ```bash
   dsh-memory review --scope all
   dsh-memory verify <id|slug>
   ```

4. 下一次会话中，`verified` 记忆会进入核心层或在相关请求中进入 recall。
5. 需要人工浏览时，打开：

   ```text
   /api/memory/panel
   ```

## 配置

配置由 `@deepseek-ai/schemastery` 声明。默认值：

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
| `recallTimeoutMs` | `500` | recall 检索超时时间 |
| `indexBackend` | `json` | `json` 或 `sqlite`（FTS5） |
| `cjkUnigrams` | `false` | 是否额外索引 CJK 单字；索引更大，支持单字查询 |
| `enableUserScope` | `true` | 启用用户级记忆 |
| `enableAutoCapture` | `false` | agent 结束时自动提取候选 |
| `autoCaptureMaxTokens` | `2048` | 自动提取输出上限 |
| `autoCaptureMaxItems` | `5` | 单次自动提取最多写入条数 |
| `trustCandidatesInCore` | `false` | 是否允许候选进入核心层 |
| `staleAfterDays` | `180` | 未使用多久视为陈旧（`0` 关闭） |
| `decayHalfLifeDays` | `180` | 排序衰减半衰期 |
| `projectScope` | `git` | 项目身份：`git` 或 `path` |
| `enablePanel` | `true` | `connection` 可用时注册 HTTP API |
| `redactPhoneAndId` | `false` | 额外脱敏手机号/身份证号 |

## 模型工具

| 工具 | 作用 |
|---|---|
| `memory_search` | BM25 + 元数据排序，返回 id、摘要、信任状态 |
| `memory_read` | 读取正文、provenance、信任状态，展开一层 `[[links]]` |
| `memory_write` | 新建记忆始终写为 `candidate`；更新内容会使 `verified` 降级为 `candidate` |
| `memory_forget` | 默认静音；`hard=true` 永久删除，走 dsh 审批 |
| `memory_list` | 只读摘要列表（调试用） |
| `memory_refresh` | 手改 Markdown 后重建派生索引 |

模型不能设置 `trust`、`pinned`、`verifiedBy`，也没有 `memory_verify` 工具。验证、争议、恢复、置顶等操作仅通过 CLI 或面板 API 暴露给用户。

## 命令行

发布包提供 `dsh-memory` CLI，直接操作同一个记忆库；写操作以用户身份执行。

```bash
dsh-memory --help
dsh-memory list --scope all
dsh-memory search "pnpm build" --limit 5
dsh-memory show <id|slug>

dsh-memory write --slug use-pnpm --kind preference \
  --title "Use pnpm" --summary "Use pnpm for builds" --body "pnpm build"
dsh-memory edit <id|slug> --summary "Updated summary"
dsh-memory review --scope all

dsh-memory verify <id|slug>
dsh-memory dispute <id|slug>
dsh-memory restore <id|slug>
dsh-memory pin <id|slug>
dsh-memory unpin <id|slug>
dsh-memory forget <id|slug> [--hard]

dsh-memory resolve <keep> <other> --mode keep|merge|both [--summary "merged"]
dsh-memory supersede <old> <new>
dsh-memory refresh
dsh-memory core
dsh-memory stats
dsh-memory doctor --fix --json
dsh-memory export --scope user --format agents --out AGENTS.md
dsh-memory import ./memories --scope user
```

- 全局选项：`--dir <path>`（默认 `$DSH_HOME/memory`）、`--cwd <path>`、`--json`。
- `write` / `edit` 支持 `--body-file <path>`；`write` 默认 `--scope user`，项目记忆使用 `--scope project`。
- `review` 列出待审核候选与冲突；`doctor --fix` 会扫描历史数据并补写双向冲突标记。
- `forget --hard` 在 CLI 中直接删除，不触发 dsh 审批弹窗；执行前请确认。
- 从源码运行：`pnpm build && node lib/cli.js ...`。

## 面板与 HTTP API

`connection` 服务可用且 `enablePanel=true` 时注册：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/memory/list` | GET | 按 scope/kind 列出摘要 |
| `/api/memory/read` | GET | 读取单条 |
| `/api/memory/search` | GET | 调试检索 |
| `/api/memory/review` | GET | 候选、冲突、陈旧、过期 |
| `/api/memory/stats` | GET | 计数、审计、核心缓存 |
| `/api/memory/core` | GET | 当前核心层文本与预算 |
| `/api/memory/config` | GET | 生效配置 |
| `/api/memory/write` | POST | 用户编辑/写入 |
| `/api/memory/verify` | POST | 用户验证 |
| `/api/memory/dispute` | POST | 标记争议 |
| `/api/memory/restore` | POST | 恢复为 candidate |
| `/api/memory/pin` | POST | 置顶/取消置顶 |
| `/api/memory/supersede` | POST | 标记被取代 |
| `/api/memory/forget` | POST | 静音/删除 |
| `/api/memory/resolve` | POST | 解决冲突：`keep` / `merge` / `both` |
| `/api/memory/scan-conflicts` | POST | 扫描历史数据并补写双向冲突标记 |
| `/api/memory/import` | POST | JSON 导入（始终 candidate） |
| `/api/memory/refresh` | POST | 重建索引 |
| `/api/memory/doctor` | GET | 一致性检查 |
| `/api/memory/export` | GET | `md` / `agents` / `json` |
| `/api/memory/panel` | GET | 内置最小面板 |

路由位于 dsh 认证围栏内，默认仅 loopback。API 不提供推送，浏览器操作后自行刷新。

内置面板是一个无构建依赖的单页应用，提供 Review、All、Search、Stats 四个视图，以及 verify / dispute / restore / pin / forget / resolve 操作。

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

`mode=keep` 保留 `keep` 并将另一条标记为 `superseded`；`mode=merge` 先合并内容再取代；`mode=both` 只清除双向冲突标记。

## 存储布局

```text
$DSH_HOME/memory/
├── audit.jsonl
├── projects/<projectKey>/
│   ├── project.json
│   ├── memories/<ULID>.md
│   ├── index.json          # JSON 后端
│   ├── index.sqlite        # SQLite 后端
│   └── index.md
├── user/
│   ├── memories/<ULID>.md
│   ├── index.json
│   ├── index.sqlite
│   └── index.md
└── tmp/
```

- `index.*` 均为派生数据，可删除或用 `memory_refresh` 重建。
- 记忆文件使用稳定 ULID 作为主键，slug 仅用于展示与检索；未知 frontmatter 字段原样保留。
- 项目身份优先使用 git remote + 仓库相对路径：

  ```text
  repo-<sha256(normalizedRemote + "\0" + relativePath)[0:12]>
  ```

  没有 git 时退化为：

  ```text
  path-<sha256(normalizedCwd)[0:12]>
  ```

  因此仓库换路径、重新 clone 后记忆仍可命中；monorepo 子包拥有独立 scope。

## 信任与冲突

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
- 新写入与已有记忆疑似冲突时，双方都会写入 `conflictOf`，进入 review queue。
- review queue 支持：
  - `keep`：保留一条，取代另一条；
  - `merge`：合并内容后取代；
  - `both`：两条都保留，只清除冲突标记。
- `doctor --fix` / `/api/memory/scan-conflicts` 可扫描历史数据并补写双向标记。

## 检索与 recall

### 检索

- 分词：拉丁词 + 轻量英文词干（复数 / `ing` / `ed`）；CJK 默认二元组，`cjkUnigrams=true` 时额外索引单字；代码符号作为分隔符。
- BM25：`k1=1.2`、`b=0.75`；字段权重 title 3 / summary 2 / tags 2 / body 1。
- 最终分数：BM25 0.55 + recency 0.15 + trust 0.12 + importance 0.08 + scope 0.05 + kind 0.05。
- 去重后使用 MMR（`lambda=0.7`）在 top-20 内选出 top-k。
- 默认排除 `muted` / 过期 / `disputed` / `superseded`。
- 关键词命中不足时，可用元数据分补足头部候选；recall 会关闭该 fallback。
- JSON 与 SQLite 后端共用同一套评分和 fallback 行为。

### per-turn recall

已确认的宿主时序：

```text
inbox.claim()
  → agent/inbox/claimed      # 当前用户文本可用
  → systemPrompt.assemble()  # 异步检索并插入 recall
  → user/message             # 组装之后才 append
```

因此 recall 能影响当前这一步，而不是延迟到下一轮：

- 查询来自 claimed 的用户消息，只取 text block；
- 范围是 user + 当前 project，不包含其他项目；
- 默认只注入 `verified`，并排除已在核心层的 ID；
- 受 `recallMaxBytes`、`recallMaxItems` 限制；
- 冷索引超过 `recallTimeoutMs` 时放弃本回合，不阻塞请求；
- 结果位于独立的 `<memory_recall>` 段。

## 自动捕获

默认关闭。开启后：

1. 监听根会话的用户消息与 assistant 消息，忽略 subagent。
2. 缓冲上限 40 轮 / 24k 字符。
3. `agent/disposed` 时调用当前 provider/model，要求输出 JSON 数组。
4. 校验字段、长度、kind/scope、evidence（逐字出现在转写中），去重后写入 `candidate`。
5. 任一步失败静默处理，不影响会话。

审核入口：`dsh-memory review`、面板 Review 标签，或直接调用 `/api/memory/review`。

即使关闭自动捕获，插件也会保留最近转写用于 `memory_write` 的 evidence 校验；没有可用转写时保留 evidence。

## 安全模型

- 进入提示词和工具结果的文本经过单行化、协议框架转义与密钥脱敏。
- 磁盘内容不可信：手改文件在每次读取/注入时重新清洗。
- 写入通过 `MemoryStore`：跨进程文件锁、`tmp/` 同文件系统原子替换。
- 孤儿锁：超时后检查锁内 PID，仅当进程不存在时删除并重试。
- 审计失败只告警，不阻塞主流程；`audit.jsonl` 超过 5 MB 轮转并保留尾部一半。
- 读取/列举跳过 symlink；文件名由 ULID 生成，不接受用户路径。
- SQLite 索引文件及 WAL/SHM 尽量收紧为 `0600`；目录为 `0700`。

## 性能

以下为开发机、10,000 条记忆、默认 `cjkUnigrams=false` 的参考值，不是硬性承诺：

| 后端 | 首次构建 | 进程重开首查 | search p95 | 单次写入 | RSS |
|---|---:|---:|---:|---:|---:|
| JSON | 7.3s | 5.3s | 19.5ms | 0.16s | 307MB |
| SQLite FTS5 | 11.9s | 28ms | 32.6ms | 0.48s | 237MB |

- 小到中等规模（数千条）建议保持默认 JSON，部署简单。
- 10k+ 或频繁重启时使用 `indexBackend: sqlite`，重开和内存占用更好；首次建库较慢。
- 仅在确实需要单字 CJK 检索时开启 `cjkUnigrams`，它会明显增大 postings/FTS。
- 面板按需加载，不进入搜索/注入热路径。

运行回归：

```bash
pnpm bench:json
pnpm bench:sqlite
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 插件入口、核心层 section、per-turn recall、审批钩子 |
| `src/cli.ts` | `dsh-memory` CLI |
| `src/panel.ts` | 无构建依赖的最小面板 HTML |
| `src/store/` | 路径身份、frontmatter、清洗、存储、JSON/SQLite 索引、审计 |
| `src/retrieval/` | 分词、BM25、评分、MMR |
| `src/injection/` | 核心层缓存、recall、注入审计 |
| `tests/` | 单元、集成、安全、CLI、索引、冲突、并发测试 |
| `tests/e2e/` | 真实 `SystemPrompt` / `ToolRuntime` 宿主服务 e2e |
| `scripts/perf-10k.mjs` | 10k 性能回归与阈值检查 |
| `.github/workflows/ci.yml` | Node 22/24 × Ubuntu/Windows 矩阵 + 10k 性能 job |

测试覆盖 BM25/MMR、frontmatter、脱敏、安全边界、CLI、JSON 增量索引、SQLite 回退、recall、冲突扫描、并发写入和宿主服务集成。

## 已知限制

- **核心层冷启动**：`systemPrompt.section.text` 必须同步且不读盘。apply 阶段会预热用户级 core pack；若首轮组装早于预热完成，首轮可能为空，下一轮恢复。
- **recall 依赖宿主事件**：时序基于当前 `dsh-agent-loop` 的 `agent/inbox/claimed` 与 `system-prompt/assemble`。宿主不发送该事件时 recall 会静默跳过。
- **不做文件 watcher**：外部手改在下次 `agent/created` / `memory_refresh` 时通过索引哈希检测；极端情况下 size/mtime 不变的手改需要强制 refresh。
- **索引规模**：JSON 在 10k 条时重开约数秒；SQLite 首次建库需全量解析 Markdown。更大规模需要分片或专用索引，当前未实现。
- **写入不是常数时间**：JSON 会重写 `index.json`，SQLite 会同步 scope 状态；10k 条时分别为百毫秒和数百毫秒级。
- **检索没有向量模型**：当前是词法检索（BM25 + 元数据 + 词干）；embedding/hybrid 需要外部 provider，未内置。
- **明文存储**：记忆文件与审计日志未加密；敏感环境应配合磁盘加密与访问控制。
- **最小面板**：无 React 构建链，也不与 dsh 侧边栏集成；复杂交互仍以 CLI/API 为主。
- **共享默认目录**：与 `dsh-auto-memory` 同时使用时默认都指向 `$DSH_HOME/memory`，请为其中一个配置独立 `memoryDir`。
- **CLI 硬删除**：`dsh-memory forget --hard` 不经过 dsh 审批，直接删除文件。

## License

[MIT](LICENSE)
