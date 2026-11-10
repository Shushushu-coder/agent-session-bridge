# E2E 测试报告：多轮续聊编排（同步单次 + 异步批次续接）

- **日期**：2026-11-10
- **Bridge 版本**：v0.3.0
- **测试目的**：验证对已完成第一轮调研的持久 Worker 发起第二轮续聊的
  两条路径——同步单次发送（`send_worker_message`）与异步批次派发
  （`dispatch_worker_batch`）——均能在原原生线程上续接并完整继承
  上下文
- **前置测试**：`2026-11-10-multi-worker-batch-survey.md`
  （同一批 3 个 Worker 的第一轮并行调研）
- **目标工作区**：`E:\Projects\prompt-workbench`（独立 git 仓库）
- **结果**：通过。3/3 Worker 第二轮答复 `completed`，
  `nativeThreadId` 与第一轮 100% 一致，无新建会话行为。

## 一、执行过程记录

### 1. 步骤 1：同步路径（frontend）

- **工具调用**：`send_worker_message`（workerId: `wrk_7ac351b54863`）
- **Prompt**："列出你上一轮调研中实际阅读过的至少5个具体文件路径，
  并用3句话概括本仓库前端最关键的一个设计决策"
- **执行表现**：同步阻塞等待约 33 秒，直接返回 `status: completed`，
  当前状态 `ready`。

### 2. 步骤 2：批次派发（backend + database）

- **工具调用**：`dispatch_worker_batch`
- `requestKey`: `"followup-001"`
- `batchId`: `batch_1891a98e32667909`
- 分配任务：
  - backend (`wrk_525dbe53e029`) → `task_e0c837b3e3a942ee`
  - database (`wrk_7d37fed02087`) → `task_87fa839d8e2eb7a1`
- **执行表现**：两个任务均以 `dispatchStatus: accepted` 立即入队，
  开始并发执行。

### 3. 步骤 3：轮询批次状态（get_batch_status）

- 初始轮询：`running: 2, completed: 0`
- 等待 10 秒后复查：两个 Worker 均已执行完毕，状态收敛为
  `running: 0, completed: 2`（`allSettled: true`,
  `allCompleted: true`）。

## 二、三个 Worker 第二轮回复内容汇总

### 1. Frontend Worker（wrk_7ac351b54863）

**上一轮实际读取过的文件路径（共 8 个）**：

- `package.json`（依赖版本与运行脚本）
- `src/app/layout.tsx`（根布局与全局元数据注入）
- `src/app/page.tsx`（Workspace 首页逻辑与项目上下文同步）
- `src/components/workspace-header.tsx`（全局顶栏组件与回环状态展示）
- `src/app/prompts/page.tsx`（Prompt 草稿、版本与预览页面）
- `src/app/datasets/page.tsx`（数据集与多轮用例编辑页面）
- `src/app/models/page.tsx`（目标模型与裁判模型配置页面）
- `src/lib/utils.ts`（样式合并工具 `cn` 与时间格式化）

**前端最关键设计决策（3 句话概括）**：

1. **本地单用户优先**：前端完全摒弃了登录鉴权体系与重型全局状态库，
   采用纯原生 React 19 `"use client"` 配合浏览器 localStorage
   （`pw_active_project_id`）跨页面同步当前激活项目，保持架构轻量
   与响应敏捷。
2. **严格回环与同源通信**：构建与启动脚本强制锁定在 127.0.0.1 本地
   回环地址，前端所有页面直接通过原生 fetch 与同源的 Next.js
   Route Handlers（`/api/*`）完成本地数据持久化与交互。
3. **前端凭证零落地保护**：前端在配置和展示模型时不接触、不传输、
   不保存任何真实 API Key 明文，仅以环境变量名引用（`apiKeyRef`）
   流转，从 UI 根源上隔绝敏感密钥泄漏风险。

### 2. Backend Worker（wrk_525dbe53e029）

**最值得关注的安全机制**：面向本地环境的"零凭证暴露"与"全链路
白名单纵深防御"（PW-022），具体落实为 4 层防线：

1. **凭证不入库与 API 零密钥暴露**：
   - `apiKeyRef` 严格校验为环境变量名，拦截明文 Key（引用：
     `src/lib/model-profiles.ts` 中的 `validateApiKeyRef`）。
   - 视图层仅暴露 `apiKeyConfigured: boolean`（引用：
     `src/lib/model-profiles.ts` 中的 `toModelProfileView`）。
   - 探活连通性测试与错误回显均强制执行深层正则脱敏（引用：
     `src/lib/security/secrets.ts` 中的 `redactSecretsDeep` 与
     `src/lib/provider-test.ts`）。
2. **Provider 与 BaseURL 协议白名单**：
   - 仅放行 `openai`、`anthropic`、`openai_compatible`；阻断
     `file://`、`exec:`、`python:` 等恶意协议（引用：
     `src/lib/security/whitelist.ts` 中的 `assertAllowedProvider`）。
   - 仅放行 `http:` / `https:` 并拦截内嵌用户密码的 URL（引用：
     `src/lib/security/whitelist.ts` 中的 `assertProviderBaseUrl`）。
3. **防脚本注入的断言与规则配置**：递归过滤 `eval`、`script`、
   `transform` 等可执行键（引用：`src/lib/security/whitelist.ts`
   中的 `findForbiddenKeys`）。
4. **回环物理隔离与字面量模板引擎**：
   - 静态检查 127.0.0.1 回环绑定（引用：`package.json`、
     `src/test/loopback.test.ts`）。
   - 模板替换仅限 `{{var}}` 纯字面拼接，无动态 eval 解析（引用：
     `src/lib/template.ts`）。

### 3. Database Worker（wrk_7d37fed02087）

**挑出的最值得改进点**：Schema 的"双重事实来源（Dual SSOT）"与
缺乏统一的运行时自动迁移机制。

- **代码证据**：
  - 一套在 `src/db/schema.ts` 定义，并通过 `drizzle/`
    （`0000_many_fantastic_four.sql` 至 `0003_material_junta.sql`）
    与 `drizzle.config.ts` 管理版本演进。
  - 另一套是硬编码在 `src/db/index.ts` 的 `initSchema(client)`
    函数中的原生 SQL 字符串（8 张表的 `CREATE TABLE IF NOT EXISTS`）。
- **核心弊端**：
  - 开发者修改字段必须在两处完全同步修改，极易造成静默漂移
    （Schema Drift）；
  - `IF NOT EXISTS` 无法处理现有库的 `ALTER TABLE` 增量演进；
  - `drizzle/` 的 SQL 迁移文件在运行时完全没有被调用
    （仅工具链使用）。
- **建议改进**：废弃 `initSchema`，改用 Drizzle 官方提供的
  `migrate(db, { migrationsFolder: "./drizzle" })`，由迁移文件统一
  驱动冷启动与增量升级。
- **次要隐患补充**：引用 `src/lib/test-cases.ts` 与
  `src/lib/evaluation-rules.ts`，指出复合级联更新操作目前缺少
  `db.transaction()` 事务保护。

## 三、重点问题验证与对比结论

### a. `nativeThreadId` 对比（是否续接原线程）

| Worker 名称 | Worker ID | 第一轮原始 threadId | 第二轮 nativeThreadId（Status / Result / Worker） | 对比结论 |
| --- | --- | --- | --- | --- |
| **frontend** | `wrk_7ac351b54863` | `01a1c3c0-7d26-7b93-949c-b97c84ba6d39` | `01a1c3c0-7d26-7b93-949c-b97c84ba6d39` | **完全一致（已续接）** |
| **backend** | `wrk_525dbe53e029` | `01a1c3c0-7ce7-7a71-aba3-3ed2b6007a14` | `01a1c3c0-7ce7-7a71-aba3-3ed2b6007a14` | **完全一致（已续接）** |
| **database** | `wrk_7d37fed02087` | `01a1c3c0-7cbf-7891-ab6d-2c0e5489a22c` | `01a1c3c0-7cbf-7891-ab6d-2c0e5489a22c` | **完全一致（已续接）** |

**结论**：`send_worker_message` 和 `dispatch_worker_batch` 在调用时，
均准确绑定了此前存储在桥接层中的原生 Codex 线程，**Thread ID 保持
100% 一致，无新建会话行为**。

### b. 引用文件路径真实性与上下文继承验证（是否读过仓库）

三个 Worker 在回答中引用的路径与具体实现细节包括：

- **Frontend**：引用的路径（如 `src/app/prompts/page.tsx`、
  `src/components/workspace-header.tsx`）均为仓库中独有的目录与
  组件；提取并提到了第一轮中查阅到的私有上下文：浏览器
  localStorage 键名 `pw_active_project_id`、字段 `apiKeyRef`、
  回环端口参数等。
- **Backend**：准确指出了 `src/lib/security/whitelist.ts`、
  `src/lib/security/secrets.ts`、`src/lib/provider-test.ts`、
  `src/test/loopback.test.ts` 等安全层具体文件；能精确说出其中的
  核心校验函数名（如 `validateApiKeyRef`、`redactSecretsDeep`、
  `assertAllowedProvider`、`findForbiddenKeys`），这在未深入读取
  源码时是不可能臆造的。
- **Database**：精准指出了 `src/db/index.ts` 中的手写函数
  `initSchema(client)` 与 `src/db/schema.ts`、`drizzle.config.ts`
  之间的矛盾；能列举出 `drizzle/` 目录下实际存在的 4 个具体文件名
  （`0000_many_fantastic_four.sql` 至 `0003_material_junta.sql`，
  以及 `drizzle/meta/_journal.json`）；能准确指出
  `src/lib/test-cases.ts` 中的 `duplicateTurn` / `reorderTurns`
  等领域函数的事务缺失问题。

**结论**：三个 Worker 均直接调取了第一轮阅读过的具体代码与文件内容，
**会话上下文完全且深度地继承到了第二轮续聊中**。
