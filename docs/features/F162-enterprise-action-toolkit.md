---
feature_ids: [F162]
related_features: [F088, F132, F142]
related_decisions: [ADR-029]
topics: [enterprise-action, wecom-cli, lark-cli, cli-integration, showcase]
doc_kind: spec
created: 2026-04-14
---

# F162: Enterprise Action Toolkit — 官方 CLI 驱动的企业工作流

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1
> **Deadline**: 2026-04-17（WXG 面试 showcase）
> **Architecture**: [ADR-029](../decisions/029-external-tool-integration-strategy.md)

## Why

team experience（2026-04-14）：

> "那我们写一个企业微信 show case？"
> "meeting/table 才够打"
> "周四晚上 WXG 面试直接 show 给他们看"

Cat Café 已通过 F088/F132 实现了企微的**消息收发**（Transport Plane），但企业 IM 的真正价值不在聊天，在于**把聊天变成可追踪的工作流程**——文档、表格、待办、会议。

2026 Q1 企微发布官方 CLI（`wecom-cli`）并附带 Agent Skills，让 AI Agent 直接编排企业操作成为可能。我们利用 ADR-029 定义的 `ActionService + CliExecutor` 模式，用企微打样验证这条路。

**展示目标**：WXG 面试现场，群里一句话 → 猫自动创建企微文档 + 智能表格 + 待办 + 会议 → 链接回贴群聊。面试官打开企微即可看到成果。

## What

### 架构（ADR-029 首次应用）

```
team lead在 Hub/企微群 发一句话
  ↓
猫解析意图（enterprise workflow skill）
  ↓
POST /api/callbacks/wecom-action
  ↓
WeComActionService（治理边界：auth / audit / dry-run / idempotency）
  ↓
CliExecutor → wecom-cli doc/todo/meeting/...
  ↓
资源句柄持久化（doc URL / todo ID / meeting link）
  ↓
猫组合结果 → 回贴 Hub + 企微群
```

**不做 MCP server**（ADR-029 Decision 4）。猫通过 callback route 调用 ActionService。

### Phase A: WeCom Golden Chain Showcase

**目标**：端到端跑通一条黄金链路，4/17 面试现场可演示。

**黄金链路**：

```
"把今天讨论整理成 PRD，拆成任务给张三李四王五，约下周三评审"
  ↓
① wecom-cli doc create → 企微文档（PRD 内容）
② wecom-cli doc smartsheet create → 智能表格（任务 × 负责人 × deadline）
③ wecom-cli todo create × N → 待办分发到每个人
④ wecom-cli meeting create → 评审会议邀请
⑤ 结果汇总 → 回贴到群聊（4 个链接 + 状态摘要）
```

**实现清单**：

1. **wecom-cli 环境搭建**
   - 安装 `@wecom/cli`
   - 配置企微应用 credentials（`corpId` / `agentId` / `secret`）
   - 验证 CLI 基本命令可用

2. **WeComActionService**（`packages/api/src/infrastructure/enterprise/WeComActionService.ts`）
   - `createDoc(opts)` → DocHandle
   - `createSmartTable(opts)` → TableHandle
   - `createTodo(opts)` → TodoHandle
   - `createMeeting(opts)` → MeetingHandle
   - 公共：auth 注入、audit log、error normalization、JSON output parsing
   - 仿 PandocService 模式：lazy availability check + graceful degradation

3. **CliExecutor**（`packages/api/src/infrastructure/enterprise/WeComCliExecutor.ts`）
   - `execFile('wecom-cli', [...args])` wrapper
   - `--format json` output parsing
   - timeout / retry / error classification

4. **Callback Route**（`packages/api/src/routes/callback-wecom-action-routes.ts`）
   - `POST /api/callbacks/wecom-action`
   - 猫通过 callback credentials 调用
   - 参数校验 + ActionService 调度

5. **Enterprise Workflow Skill**（`cat-cafe-skills/skills/enterprise-workflow/`）
   - 指导猫：意图解析 → 参数提取 → 调 callback → 组合结果
   - 引用 upstream wecom-cli Agent Skills 作为能力描述

6. **Demo Script**
   - 固定场景脚本，面试现场可复现
   - 备选：预录视频 fallback

### Phase B: 飞书 CLI 接入（in-progress，2026-04-17）

复用 Phase A 的 ActionService 模式接入 `lark-cli`（@larksuite/cli，Go 二进制）。Lark 的厂商能力比企微多一条"Slides"腿，黄金链路因此可以展示**比企微 demo 多一层幻灯片输出**。

```
team lead: "把今天讨论整理成 PRD + 多维表 + 任务 + 日程 + Slides"
  ↓
猫解析意图（enterprise workflow skill，新增 Lark 分支）
  ↓
POST /api/callbacks/lark-action   { action: "golden_chain", ... }
  ↓
LarkActionService（auth / audit）
  ↓
LarkCliExecutor → lark-cli docs/base/task/calendar/slides +...
  ↓
返回 { doc, base, tasks, calendarEvent, slides, summary }
```

关键差异点（vs Phase A）：
- lark-cli 命令是 cobra 风格（`--flag value`），不是企微的单 JSON blob
- Lark Open API 响应用 `{code, msg, data}`，不是企微的 `{errcode, errmsg, ...}`
- Slides 是飞书专属，企微 v0.1.5 不支持
- Task v2 的 assignee 用 `open_id`（`ou_xxx`）
- Calendar 事件本体通过 `calendar +create-event`；lark-cli v1.x **不暴露** VC/meeting URL，需要会议链接时另用 `vc +create`

### Phase C: 跨平台统一与 Hub 集成（面试后）

根据 Phase A/B 经验，评估是否需要公共 ActionService 接口抽象。

## Acceptance Criteria

### Phase A（WeCom Golden Chain Showcase）

- [x] AC-A1: `wecom-cli` 安装配置完成，基本命令可在本机执行（v0.1.5, 四命令全通）
- [x] AC-A2: WeComActionService 实现 `createDoc` / `createSmartTable` / `createTodo` / `createMeeting` 四个方法
- [x] AC-A3: 每个方法有 audit log 记录（谁调了什么、参数、结果）
- [x] AC-A4: callback route `/api/callbacks/wecom-action` 可被猫调用
- [x] AC-A5: 端到端：一句话 → 文档 + 表格 + 待办 + 会议 → 链接回贴（team lead 2026-04-17 确认已端到端验证；期间真实使用过——Opus 在面试日程调整时用 wecom-cli 创建过 21:15 新会议）
- [x] AC-A6: 企微 App 中可看到猫创建的文档/表格/待办/会议（team lead实机确认）
- [x] AC-A8: 备选方案：预录 demo 视频/GIF 一份 ~~保留~~ — WXG 面试于 2026-04-17 完成，实时 demo 通过，fallback hedge 不再需要

### Phase B（Lark Golden Chain Showcase + Slides 增量）

- [x] AC-B1: `lark-cli`（@larksuite/cli）安装 + 命令 schema 探查完成（docs/base/task/calendar/slides/contact 可用）
- [x] AC-B2: LarkActionService 实现 `createDoc` / `createBase` / `createTask` / `createCalendarEvent` / `createSlides` / `searchUsers` / `goldenChain`
- [x] AC-B3: 每个方法有 audit log 记录
- [x] AC-B4: callback route `/api/callbacks/lark-action` 支持全部 action + `golden_chain`（zod discriminatedUnion）
- [x] AC-B5: 单元测试全绿（LarkCliExecutor + LarkActionService，29/29 pass）
- [x] AC-B6: 端到端真实调用：一句话 → 飞书文档 + 多维表 + 任务 + 日程（+ Slides）→ 链接回贴（2026-04-17 真实 E2E 通过，见 Timeline）
- [ ] AC-B7: 飞书 App 内可见全部资源（E2E 产出链接已生成，留给team lead点开目测）
- [x] AC-B8: `enterprise-workflow` skill 扩展到双平台（WeCom + Lark）

## Dependencies

- **Uses**: F088（消息触发入口 + 企微群回贴出口）
- **Related**: F132（同平台，Transport Plane 已做完，本 feat 做 Action Plane）
- **Related**: F142（如需从企微群 `/command` 触发）
- **Architecture**: ADR-029（External Tool Integration Strategy）

## Risk

| 风险 | 影响 | 缓解 |
|------|------|------|
| wecom-cli 某些 API 不可用或有权限限制 | 黄金链路断链 | Day 1 先逐个验证四个命令可用性，不可用的降级为 API 直调 |
| ≤10 人企业限制导致部分功能受限 | 智能表格 / 会议可能不开放 | 验证后调整 scope，确保 demo 路径畅通 |
| 面试现场网络问题 | 实时 demo 翻车 | AC-A8：备录视频 fallback |
| wecom-cli 输出格式不稳定 | 解析失败 | CliExecutor 优先 `--format json`，降级解析 text |
| 企微应用审核/权限延迟 | Day 1 阻塞 | team lead已创建企业，尽早完成应用注册 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不建 MCP server，走 ActionService + CliExecutor + callback route | ADR-029 Decision 1-4 | 2026-04-14 |
| KD-2 | Transport Plane (F088/F132) 和 Action Plane (F162) 明确分离 | ADR-029 Decision 5 | 2026-04-14 |
| KD-3 | Phase A 只做企微，飞书留 Phase B | 三天 deadline，聚焦一个平台 | 2026-04-14 |
| KD-4 | 黄金链路含 Doc + Table + Todo + Meeting 四步 | team lead拍板"meeting/table 才够打" | 2026-04-14 |
| KD-5 | Phase B 全量接入飞书能力（含 Slides），不只是 WeCom 的对等翻译 | team experience"对他们有什么就接什么就好了"——飞书生态比 WeCom 多 Slides/Mail/Minutes/Whiteboard，demo 可强调"多一层" | 2026-04-17 |
| KD-6 | LarkCliExecutor 用 cobra-style flags（key-value 对），不复用 WeCom 的单 JSON blob | lark-cli 本身是 cobra 框架，CLI 原生就是 `--flag value` 形式，强行 JSON 化会增加包装层 | 2026-04-17 |
| KD-7 | lark-cli 响应用扁平包络 `{ok, identity, data, error?}`，字段扁平（`data.doc_id` 而非嵌套 `data.document.document_id`），且 exit code 恒为 0（成功/失败由 `ok` 判断） | 预编码阶段按 Feishu Open API 文档猜的嵌套形状与真实 CLI 输出不匹配，探测后重写 types/service/tests | 2026-04-17 |

## Review Gate

- Phase A: 面试展示性质，快速迭代。自检 → team lead验收 → 面试实战验证。
- AC-A1~A4: codex review + 云端 review 通过，PR #1180 merged 2026-04-15。
- AC-A7: 云端 review 通过，PR #1182 merged 2026-04-15。
- CellTextValue fix: 云端 review 通过，PR #1186 merged 2026-04-15。
- Phase B Round 1: codex local review（1 P1 + 3 P2 → Red→Green 全修）+ 云端 review 放行，PR #1233 merged 2026-04-17。

## 需求点 Checklist

| 需求点 | 来源 | 状态 |
|--------|------|------|
| 企微文档创建 | team lead 2026-04-14 | ✅ CLI 验证 + ActionService 实现 |
| 企微智能表格创建 | team lead 2026-04-14 | ✅ CLI 验证 + 默认字段处理 |
| 企微待办分发 | Maine Coon(GPT-5.4) 黄金链路提案 | ✅ CLI 验证 + follower_id 字段修正 |
| 企微会议创建 | team lead "meeting 才够打" | ✅ CLI 验证 + 会议链接获取 |
| 结果链接回贴群聊 | Maine Coon(GPT-5.4) 黄金链路提案 | ✅ team lead端到端验证 |
| 面试 demo 脚本 | team lead deadline 需求 | ✅ PR #1182, 5-phase 60s 脚本 |
| 备录视频 fallback | 风险缓解 | N/A — 面试已过，实时 demo 通过，无需 fallback |
| 飞书文档（docx） | team lead 2026-04-17 | ✅ 骨架 + 单测 |
| 飞书多维表（Bitable） | team lead 2026-04-17 | ✅ 骨架 + 单测 |
| 飞书任务 v2 | team lead 2026-04-17 | ✅ 骨架 + 单测 |
| 飞书日程（event v4） | team lead 2026-04-17 | ✅ 骨架 + 单测；VC 链接 lark-cli v1.x 不暴露，需要时另用 `vc +create` |
| 飞书幻灯片（专属） | team lead"对他们有什么就接什么" | ✅ 骨架 + 单测 + goldenChain 可选分支 |
| 飞书 Lark golden chain | team lead"今天下午都能干完" | ✅ 真实 E2E 通过 2026-04-17（PR #1233 merged），doc/base/task/calendar/slides 全绿 |
