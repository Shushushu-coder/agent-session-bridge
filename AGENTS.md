# AGENTS.md — Agent Working Guidelines for agent-session-bridge

> 本文件是所有参与 `agent-session-bridge` 仓库开发、维护与调试的 AI Agent 必须遵守的准则与技术上下文。

---

## 1. 项目定位与核心设计哲学

`agent-session-bridge` 是一个基于 stdio 的轻量级本地 MCP (Model Context Protocol) 服务端，它允许 Codex 主会话通过标准的 MCP 工具，创建、调度和管理**持久化的 Codex Worker 会话**（基于 `@openai/codex-sdk` 与 Node.js ≥ 22 ESM）。

### 核心设计哲学
1. **Honest State Machine（诚实状态机）**：绝不粉饰状态或伪造返回。失败即报失败，未就绪即报 `NOT_READY`，中断即标记为 `unknown`。未收到模型终态事件前绝不伪造成功结果。
2. **Fixed Sandboxing（不可逃逸的沙箱）**：Worker 必须固定在只读沙箱下运行，严禁提供越权途径。
3. **Crash & Restart Resilience（崩溃与重启韧性）**：单机进程崩溃或重启后，持久化状态必须能够自洽恢复，数据文件必须原子写入且绝不能在损坏时静默覆盖。

---

## 2. 核心红线与不变量（Non-Negotiable Invariants）

在修改任何代码时，**绝对不可破坏**以下约束：

- 🛡️ **沙箱不可降级**：
  Worker 的 `sandboxMode` 必须为 `"read-only"`，`approvalPolicy` 为 `"never"`，`webSearchMode` 为 `"disabled"`。必须强制进行 Git 仓库根目录校验，严禁开放额外可写目录。
- 🔒 **单 Worker 并发互斥（Worker Busy Lock）**：
  同一个 Worker 同一时间**只能运行一个 turn**（无论是同步 `send_worker_message` 还是异步 `dispatch_worker_task` / `dispatch_worker_batch`）。并发只存在于不同 Worker 之间，不可在同一个 Worker 上排队覆盖。
- 💾 **存储原子性与不覆盖原则**：
  `workers.json` 与 `tasks.json` 的写操作必须遵循 tmp-file + rename 原子写入。若读取到损坏的 JSON，必须直接抛出异常拒绝启动（`process.exit(2)`），**严禁**静默用空存储覆盖现有文件。
- 🧩 **批处理非事务性（Non-Transactional Batches）**：
  `dispatch_worker_batch` 中单个成员的失败或被拒不能导致已接受的同批其他任务被回滚或中断；已落盘的 Batch 记录是不可变的（Immutable）。
- 🚫 **严禁侵入 Codex 外部状态**：
  严禁直接修改 `~/.codex/` 下的用户配置或会话文件（只读排查/watch tail 除外）。所有会话生命周期严格通过 `@openai/codex-sdk` 的公共 API（`startThread` / `resumeThread` / `run`）进行。
- ⛔ **不确定状态严禁自动补偿**：
  首个 turn 在捕获 threadId 前失败的 Worker 标记为 `initialization_uncertain`，**严禁**自动重试（该 prompt 可能已在原生执行过，重试会造成重复执行）；只能由用户显式新建 Worker。同理，task 记录的原生 threadId 若在 `workers.json` 中缺失，关联状态必须报告为 `unconfirmed`，严禁为其擅自开启新 Codex 线程。

---

## 3. 项目架构与目录结构

```text
src/
├── index.ts               # stdio 入口：初始化存储、适配器与注册表，启动 MCP 监听
├── processLifetime.ts     # 进程生命周期：捕获 SIGINT/SIGTERM/退出，将进行中的任务标记为 unknown
├── server.ts              # McpServer 实例创建与全部 13 个 Tool 注册
├── contracts/             # 数据契约与 Zod Schema（Worker, Task, Batch, Board, Runtime 等）
├── runtime/codex/         # CodexRuntimeAdapter（封装 @openai/codex-sdk 的执行与事件流）
├── storage/               # SessionRegistry 与 TaskStore（原子 JSON 读写）+ redact 脱敏
├── ui/                    # MCP Apps 看板（ext-apps，浏览器 DOM 环境，独立 tsconfig.ui.json）
├── workers/               # WorkerManager（状态机、Busy 状态互斥锁、Workspace 校验）
└── watch/                 # 终端只读监控工具（CLI 状态板与 rollout 日志追踪）

scripts/
└── build-ui.mjs           # esbuild 将 src/ui 打包为 MCP App HTML 资源

tests/
├── fixtures/FakeCodex.cs  # 离线 codex exec 桩（C#，经 csc.exe 编译为 fake-codex.exe）
├── helpers/               # FakeCodexSdk / FakeThread 内存桩（多数测试走这里，无需编译）
├── support/               # fake stdio server 等测试支撑
└── ...                    # 单元测试、E2E 与真实 stdio smoke 测试

docs/                      # architecture.md、roadmap.md 与设计报告
```

### 数据目录
默认 `~/.agent-session-bridge/`（包安装目录不可作为持久位置——npx 缓存与全局目录会在升级/清理时丢状态），可用 `AGENT_SESSION_BRIDGE_DATA_DIR` 覆盖；源码 checkout 里 gitignored 的 `sessions/` 仅为历史默认。调试持久化状态时先看这里：`workers.json` 存 Worker 元数据，`tasks.json` 存任务状态/进度摘要/最终回复/token 用量与不可变的 batch→task 映射。

全部 13 个 MCP 工具的清单与语义见 `README.md`（"MCP tools" 表及 board/watch 章节）；新增或修改工具时请保持 README 同步。

---

## 4. 常用工具与日常工作流（Commands）

`npm run build:ui`（esbuild 打包 `src/ui/`）是 `dev`/`build`/`typecheck`/`test`/`smoke` 的自动前置步骤，无需单独调用；`src/ui/` 的改动经它进入产物，UI 打包失败会阻塞上述所有命令。

| 命令 | 场景与目的 |
| :--- | :--- |
| `npm run typecheck` | 严格模式 TypeScript 检查（`tsconfig.json` + UI 专用的 `tsconfig.ui.json`） |
| `npm run build` | 编译至 `dist/`（`tsconfig.build.json`） |
| `npm run test` | 运行所有 Vitest 单元与离线 E2E 测试 |
| `npm run smoke` | 编译后执行真实 stdio 的 MCP Smoke 测试 |
| `npm run dev` | 基于 `tsx` 本地开发调试 |
| `npm run watch` | 终端 CLI 看板（只读观察 Worker 状态；区别于 MCP App 看板工具 `open_worker_board`） |
| `npm start` | 运行编译产物（`node dist/index.js`） |

### 规范验证顺序
在向用户提交改动或完成任务前，**必须依次通过**：
```bash
npm run typecheck
npm run test
npm run smoke
```

---

## 5. Agent 编码与实现准则

1. **错误处理使用显式 Error Category**：
   - 区分调度期拒绝（如 `WORKER_BUSY`, `INVALID_WORKSPACE`, `REQUEST_KEY_CONFLICT`）与运行时失败（`failed`, `unknown`）。
   - 向客户端返回的 MCP 错误必须包含规范的机器可读 code，避免笼统的通用错误文本。
2. **幂等性与 RequestKey**：
   - 任务和批处理派发依赖 `requestKey` 实现幂等。相同 key + 相同参数返回原任务；相同 key + 不同参数必须拒绝（`REQUEST_KEY_CONFLICT`）。
3. **保持测试纯脱机（Offline-first）**：
   - 本项目的所有单元与集成测试均不依赖网络或外部真实 LLM API。新增功能测试时应使用或扩展 `tests/helpers/` 中的 `FakeCodexSdk` 内存桩，确保在离线环境可秒级执行。
   - `tests/codexExecE2E.test.ts` 例外地走真实子进程，但针对的是 `FakeCodex.cs` 编译出的本地 exe：它依赖 Windows 自带的 .NET Framework `csc.exe` 且要求先执行过 `npm run build`，条件不满足时自动 skip——非 Windows 环境下其缺席不代表覆盖率回归。
4. **代码风格与依赖**：
   - 遵循 Node.js 原生 ESM 模式，采用 TypeScript 严格模式，避免使用 `any`。
   - 优先复用 `src/contracts/` 中已定义的 Zod schema 和类型，新增状态或字段时同步更新对应 contract。
5. **环境变量与调试**：
   - 可用环境变量：`AGENT_SESSION_BRIDGE_DATA_DIR`、`AGENT_SESSION_BRIDGE_CODEX_PATH`、`AGENT_SESSION_BRIDGE_MODEL`、`AGENT_SESSION_BRIDGE_MAX_BATCH_TASKS`（详见 README "Environment variables"）。
   - 代码改动要在已加载本 server 的 Codex Desktop 中生效，需重启 MCP 进程：杀掉 node 进程无效（stdio transport 不会重连），正确做法是请用户在 `~/.codex/config.toml` 的对应 `[mcp_servers.*]` 条目切换 `enabled` false→true——按红线约定，Agent 不应代改该文件。
