# E2E 测试报告：Main 会话编排多 Worker 并行调研

- **日期**：2026-11-10
- **Bridge 版本**：v0.3.0（INIT-04，多 Worker 批量编排）
- **测试目的**：验证 Codex 主会话通过 `agent_bridge` MCP 完成
  "创建 3 个持久 Worker → 一次性并行派发调研任务 → 轮询监控 →
  聚合结论" 的完整闭环
- **目标工作区**：`E:\Projects\prompt-workbench`（独立 git 仓库）
- **结果**：通过。3/3 任务 `completed`，无 rejected、无异常。

## 一、测试环境

| 项 | 值 |
| --- | --- |
| MCP 注册 | `~/.codex/config.toml` → `[mcp_servers.agent_bridge]`，`enabled = true` |
| Server 启动 | `node dist/index.js`（stdio MCP） |
| 主会话 | Codex Desktop，`config.toml` 默认模型 `ccs-antigravity-gemini/g-875/gemini-3.8-flash` |
| Worker 模型 | 未在 `create_worker` 中指定 → `requestedModel: null` → `runtime_default`，`codex exec` 读同一 `config.toml`，与主窗口一致 |
| Worker 沙箱 | `read-only` + `approvalPolicy: never` + 禁 web search + 强制 git 仓库检查 |

## 二、编排执行记录

1. **`create_worker` × 3**，`workspacePath` 均指向目标仓库：

   | name | workerId |
   | --- | --- |
   | frontend | `wrk_7ac351b54863` |
   | backend | `wrk_525dbe53e029` |
   | database | `wrk_7d37fed02087` |

2. **`dispatch_worker_batch`**（requestKey `survey-001`）
   → `batchId: batch_d2b337504692cb96`，`dispatchedCount: 3`，
   `rejectedCount: 0`，三位成员全部 `accepted`。

3. **`get_batch_status` 轮询**：`running: 3` → database 完成
   （`running: 2, completed: 1`）→ frontend 完成（`1 / 2`）→
   backend 完成（`0 / 3`）。终态 `allSettled: true`，
   `allCompleted: true`。

4. **`get_batch_results`**：一次取回三份结论、per-member token
   用量与错误字段，主会话自行汇总。

## 三、实测数据（取自 `sessions/tasks.json`）

| worker | taskId | 启动 | 完成 | 耗时 | 输入 tokens（其中缓存） | 输出（其中推理） | progress 事件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| frontend | `task_7893cda2e09fbb45` | 04:38:53.785Z | 04:46:00.553Z | ~7.1 min | 3,040,767（821,299） | 7,078（4,363） | 24 |
| backend | `task_0ec1c31826039bdf` | 04:38:53.800Z | 04:49:07.162Z | ~10.2 min | 5,224,201（2,600,683） | 10,488（5,664） | 24 |
| database | `task_70e41ba3a1a210bc` | 04:38:53.801Z | 04:45:02.886Z | ~6.2 min | 2,166,049（2,021,434） | 7,807（5,267） | 24 |
| **合计** | — | — | — | 批次墙钟 ~10.2 min | **10,431,017（5,443,416，缓存率 52.2%）** | **25,373（15,294）** | — |

三个任务启动时间差 < 30 ms，完成顺序交错
（database → frontend → backend），确认为真实并行而非串行排队。

每条任务记录含 24 条 bounded progress 摘要（`item.completed`
推理/消息、`turn.completed`），`failed`/`unknown` 语义未触发。

## 四、验证点

- **并行派发**：同一 batch 内三成员近同时启动、错峰完成。
- **模型一致**：`requestedModel: null` → runtime 默认 → 与主窗口
  同一 `config.toml` 模型。（注意：这是"请求的模型"，Codex 运行时
  不回传实际执行的模型。）
- **诚实状态机**：`accepted → running → completed` 全程可查，
  `allSettled` / `allCompleted` 标志准确；无虚构回复。
- **持久化**：`workers.json` 记录三 worker（`state: ready`，
  `threadId` 已固化，可 resume / 追加轮次）；`tasks.json` 记录
  batch→task 映射、usage、progress、最终 response。
- **幂等**：batch 记录含 `requestFingerprint`
  （`be5d4752…05b18`），同 requestKey 重放返回原批次不重复执行。
- **结果质量**：三份调研结论交叉一致（均独立指出 better-sqlite3
  WAL、127.0.0.1 回环绑定、prompt 版本不可变等同一事实），表明
  worker 真实读取了目标仓库而非生成臆测。

## 五、监控方式说明

- 主会话内：`get_batch_status` 主动轮询（本次采用的方式）。
- 终端实时观察：`npm run watch`（三 worker 状态板，~500 ms 轮询
  `workers.json` + `tasks.json`）与 `npm run watch -- --follow
  <worker>`（按 `threadId` 定位 `~/.codex/sessions` rollout 文件，
  事件级跟随）。本次测试未启用，留待后续验证。
- Codex Desktop 侧栏不显示外部创建的 thread，主窗口内没有 worker
  的原生对话视图——这是已知的展示边界。

## 六、Worker 调研结论摘要（目标仓库 prompt-workbench）

**frontend**：Next.js 15.1.0（App Router）+ React 19 + TypeScript
5.7.3 + Tailwind 3.4.17 + shadcn/ui 风格轻量组件 + lucide-react。
页面路由 `/`、`/prompts`、`/datasets`、`/models`；跨页项目上下文走
localStorage（`pw_active_project_id`）；dev 绑定 127.0.0.1:3000。

**backend**：与前端同进程的全栈单进程形态，Route Handlers
（`src/app/api/**/route.ts`）REST 设计；独立安全层
`src/lib/security/`（provider 白名单、URL 校验、密钥不入库、日志
脱敏）；不可变版本（SHA-256 + 自增版本号，无 UPDATE/DELETE）；
安全模板引擎 `src/lib/template.ts`（`{{var}}` 单层替换，无 eval）；
规划中 ConversationRunner / 评分聚合引擎。

**database**：SQLite 3 + better-sqlite3（WAL、foreign_keys ON），
`drizzle-orm` 查询 + `drizzle-kit` 迁移；`src/db/schema.ts` 共 8 张
表（projects / model_profiles / prompts / prompt_versions /
datasets / test_cases / turns / evaluation_rules）；
`createDatabase()` 内置 `initSchema()` 双轨自愈初始化；函数式
DAL（`src/lib/*.ts`，Repository 模式），服务函数支持注入
`:memory:` 隔离库；语义化主键（`proj_…`、`pver_…` 等）。

**三方汇总**：仓库为本地优先、单用户的 Prompt 工程评测工作台；
技术全景 `Next.js 15 (App Router)` + React 19 + TypeScript +
Tailwind + better-sqlite3 (WAL) + Drizzle ORM；核心约束为回环
绑定、密钥明文不入库、版本不可变、固定多轮编排、内存隔离测试。

## 七、复现指令（发给 Codex 主会话）

```text
使用 agent_bridge MCP 工具完成以下编排：

1. create_worker 三次，workspacePath 都是 "E:\\Projects\\prompt-workbench"：
   - name: "frontend" / "backend" / "database"（不传 model，走 runtime default）

2. dispatch_worker_batch（requestKey: "survey-001"）并行派发：
   - frontend: "只读调研本仓库的前端方案：框架、关键目录与入口，输出结论"
   - backend:  "只读调研本仓库的后端方案：技术栈、服务入口、核心模块，输出结论"
   - database: "只读调研本仓库的数据库方案：存储引擎、schema/迁移位置、数据访问层，输出结论"

3. 反复调 get_batch_status 直到 allSettled = true
4. get_batch_results 取三个结论并汇总
```

## 八、已知边界（本次测试相关）

- 监控为轮询式，无推送；worker 原生对话流不进主窗口。
- Worker 只读：适合调研，无法修改目标仓库。
- 任务跑在 MCP server 进程内，非后台 daemon；server 退出则
  in-flight 任务恢复为 `unknown`，不自动续跑。
- 每 worker 同时最多一个 turn，无队列；batch 默认上限 3
  （`AGENT_SESSION_BRIDGE_MAX_BATCH_TASKS` 可调）。

## 九、后续可做

- 验证 `npm run watch` / `--follow` 终端监控的实时性。
- 对同一 worker 追加轮次（resume thread 深挖细节）。
- `get_worker` 的 `resumeHint` → `codex resume <threadId>` 终端接管。
- Worker 完成后的清理路径（`delete_worker` 类能力，roadmap）。
