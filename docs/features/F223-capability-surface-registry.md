---
feature_ids: [F223]
related_features: [F038, F041, F131, F150, F192, F203, F211, F212]
topics: [capability-surface, skills, mcp, hub-action-surface, harness-eval, workspace-navigator]
doc_kind: spec
created: 2026-06-03
---

# F223: Capability Surface Registry — 把隐藏能力产品化成可发现、可执行、可验证的能力面

> **Status**: done | **Owner**: Maine Coon/Maine Coon | **Priority**: P1

## Architecture Ownership

Architecture cell: hub-action-surface + harness-eval
Map delta: new cell required (Phase A completed 2026-06-03)
Why: F192 eval side belongs to harness-eval; first-party Hub execution surfaces (workspace/preview/rich display) belong to the new hub-action-surface cell instead of action-plane.

## Why

operator 2026-06-03 指出：workspace-navigator 这种能力已经存在，但暴露度不够，猫猫要靠手写 `curl` 和猜端口才能用；这会让“有能力”在真实协作里退化成“想不起来 / 调不好 / 调了但用户看不到”。

这个 feature 的价值不是再补一条 skill，而是建立统一能力面：猫应该先能想起能力，再用稳定的 typed surface 执行，再有可验证的成功信号，最后由 eval 判断这套 harness 是否真的改善行为。

## Current State / 现状基线

- F131 已完成 workspace navigator 的基础管道，但当时把“猫猫自己 `curl POST /api/workspace/navigate`”写成硬实力层。2026-06-03 现场复现显示，这个边界已经不够稳：Ragdoll调用了 navigate API，Hub 也拉到了文件内容，但operator只看到 Workspace 面板，没有可靠看到目标文档。
- `cat-cafe-skills/refs/capability-wakeup-index.md` 已把 Tier 1 / Tier 2 能力列出来，并把 `workspace-navigator`、`rich-messaging`、`browser-preview` 判为 habit-resistant；但它仍偏“何时想起”，不是完整执行面 registry。
- F192 Phase F `eval:capability-wakeup` 正在衡量猫“该用没用”的 miss rate；它不负责定义每个能力应该通过 MCP、callback route、helper 还是 ActionService 执行。
- 家里已有大量 MCP 工具（例如 `cat_cafe_create_rich_block`、`cat_cafe_generate_document`、`cat_cafe_update_workflow`、`cat_cafe_multi_mention`、`cat_cafe_start_vote`），但部分能力在 skill / L0 / tool description 里的触发条件不够显眼。
- LL-041 已验证过同类问题：workspace-navigator、browser-preview、rich block 等展示能力存在，但猫只在operator明确要求时被动使用，缺少“端上桌”的触发与执行闭环。

## 需求点 Checklist

- [ ] 盘点现有隐藏能力：skills、L0 §8、MCP tools、cat-callable API routes、lessons、feature docs 都要进同一张表。
- [ ] 判断是否已有 feature 能承接；不能强塞到 F192/F203/F131 造成边界混乱。
- [ ] 不让猫手写第一方 API `curl` / JSON / 端口；至少提供 typed helper，用户可见副作用优先 MCP 或 callback wrapper。
- [ ] 区分 skill、MCP、callback route、ActionService、hook/eval 的职责，不做“全都 MCP 化”的机械选择。
- [ ] 分批 phase 与 PR，按能力族合并，避免一能力一 PR 造成 review / merge overhead。

## What

### Phase A: Capability Surface Inventory + Decision Ladder

建立 `Capability Surface Registry` 盘点表，覆盖四层字段：

| 层 | 字段 | 目的 |
|----|------|------|
| Trigger | skill / L0 / ref / guide | 猫什么时候该想到它 |
| Execution | MCP / callback route / helper / ActionService / direct import | 猫怎么稳定执行，不手搓 |
| Verification | audit event / socket ack / file probe / screenshot / generated artifact | 怎么证明真的端到用户面前 |
| Eval | F192 domain / predicate / miss-rate / owner | 后续怎么知道它有没有长期生效 |

Decision Ladder：

1. **Skill only**：只改变认知流程、无副作用、无稳定执行对象。
2. **Typed helper**：本地 shell 编排可稳定执行，但还没证明值得成为 MCP；helper 必须有测试，skill 只调用 helper。
3. **Callback/API wrapper**：需要 Hub runtime 状态、auth、audit、socket 或用户可见副作用。
4. **MCP tool**：跨 runtime/cat 都需要、schema 可以约束输入、猫不应手写 HTTP/JSON、且调用结果需要可审计。
5. **ActionService**：外部系统资源创建/变更、需要权限、dry-run、幂等、resource handle；按 ADR-029 先建 typed service，再决定暴露面。
6. **Hook/JIT/eval**：只在 F192 证明行为 miss 或注意力稀释后加，不预设“提醒越多越好”。

Phase A 必须先关闭 OQ-3：第一方 Hub UX 动作是否扩展既有 `action-plane` cell，还是新建 `hub-action-surface` / `first-party-action-surface` cell。OQ-3 未决前，Phase B 不落新的第一方 Hub MCP wrapper。

**Phase A result (2026-06-03)**：选新建 `hub-action-surface` cell，不扩 `action-plane`。Inventory 真相源为 [capability-surface-inventory](assets/F223/capability-surface-inventory.md)，Phase D 如需 hard check 可再从该文档生成 JSON/YAML。

### Phase B: First-Class Display Surfaces

先处理已经实测高摩擦的展示类能力，按能力族合并成少量 PR，不拆成三个小 PR：

- **B1 / Hub UX 端上桌 PR**：`workspace-navigator` + `browser-preview`。二者都是第一方 Hub 面板动作，reviewer 需要一次性看清 socket / audit / probe / MCP wrapper 边界。
- **B2 / Rich messaging PR**：`rich-messaging`。已有 `cat_cafe_create_rich_block` MCP，本批重点是 trigger、tool description、F192 predicate 口径一致；它跨 F192 eval 语义，单独成批更清楚。

能力内容：

- `workspace-navigator`：新增 typed execution surface（默认候选：`cat_cafe_workspace_navigate` MCP，schema 用 action union 覆盖 `reveal` / `open` 等已有语义，内部走 canonical navigate service），修 worktreeId canonicalization 与 `open` 强制切 Files view，删除 skill 里的裸 `curl` 主路径。
- `browser-preview`：把 `/api/preview/auto-open` 的猫猫调用路径包装成 typed surface（MCP 或 helper），skill 不再教猫手写 HTTP。
- `rich-messaging`：已有 `cat_cafe_create_rich_block` MCP，不重复造工具；补 trigger、tool description、F192 predicate，使长结构化回复默认走 rich block。

`workspace-navigator` 的 worktreeId canonicalization + Files view 修复是 2026-06-03 现场暴露的 user-visible bug；如实现排期被 Phase B batching 拖住，可按 hotfix 路径先修 AC-B2，再回到 F223 registry 批处理。

### Phase C: Tier 1 Capability Normalization

对 L0 §8 Tier 1 的 13 条能力逐一归档：

- 已有 MCP 的：补 tool description、skill trigger、usage examples、audit/probe。
- 只有 API route 的：按 Decision Ladder 判断 helper / MCP wrapper / ActionService。
- 只有文档或 skill 的：确认是否真无副作用，还是隐藏了可产品化执行面。
- F192 Phase F 的 normalizer/classifier 超过 5 个 capability 后，避免继续在 normalizer 里 hardcode business rule；按 clean reboot note 做 classifier 解耦。

### Phase D: Guardrail + Eval Feedback Loop

把“不要手写第一方能力调用”变成可检查的 hard layer：

- 新增检查脚本：扫描 `cat-cafe-skills/**/SKILL.md` 和 refs，禁止未豁免的 `curl localhost` / 第一方 API 手写 JSON 主路径。
- 每个 registry 条目必须有 `owner`、`execution_surface`、`verification_probe`、`eval_signal` 四个字段；缺字段不能进入 Tier 1。
- F192 verdict 持续高 miss 的能力才升级 hook/JIT；低 miss 连续 4 周按 F192/F203 规则 demote。

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal

- **Users**: 所有猫（能力调用者）、operator（用户可见结果的接收者）、feature owner（能力维护者）。
- **Activation**: 猫遇到 L0 §8 / skill trigger 场景，应该调用某个家里独有能力。

### 2. Friction Metric

- 触发场景命中但未调用能力的 miss rate。
- 调用了能力但 verification probe 未通过的 false success rate。
- skill 中仍出现未豁免第一方 `curl localhost` 主路径的数量。
- 能力 registry 条目缺 `execution_surface` / `verification_probe` / `eval_signal` 的数量。

### 3. Regression Fixture

- “打开刚写好的文档”场景必须走 workspace typed surface，不手写 navigate API，且 Hub 切到 Files view 并打开目标文件。
- “改完前端看看效果”场景必须走 browser-preview typed surface 或明确说明无法预览的 probe 结果。
- “长结构化汇报”场景必须优先使用 rich block，纯文字 fallback 需要有理由。

### 4. Sunset Signal

- F192 连续 4 周显示某能力 miss rate < 5%，且 registry/probe 无失败，则从 Tier 1 降级到 Tier 2 或只保留 registry。
- 某 typed surface 连续 2 个版本零使用，且没有 capability-wakeup miss，考虑从 MCP 降级为 helper 或文档入口。
- 若模型/运行时原生支持同等能力且可验证，删除本地 wrapper，保留 registry 迁移记录。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。重构/降复杂度类须实测可量（数字下降），不是"提了可测性就算"。详见 feat-lifecycle SKILL.md。 -->

### Phase A（Inventory + Decision Ladder）✅

- [x] AC-A1: 产出 capability surface inventory，覆盖来源至少包括 `capability-wakeup-index.md`、`cat-cafe-skills/*/SKILL.md`、`packages/mcp-server/src/tools/*`、cat-callable API routes、LL-041、F131、F192、F203。✅ [capability-surface-inventory](assets/F223/capability-surface-inventory.md)
- [x] AC-A2: 每个 inventory 条目都有 `trigger_surface`、`execution_surface`、`verification_probe`、`eval_signal`、`owner`、`recommended_action`。✅ inventory 主表
- [x] AC-A3: 给出“skill only / helper / callback route / MCP / ActionService / hook”的分类理由，且与 ADR-029 不冲突。✅ inventory Decision Ladder + ADR-029 Compatibility
- [x] AC-A4: 明确哪些需求挂 F192/F203/F131，哪些由 F223 自己承接；不把 eval、L0、单能力 bug 混成一个 owner。✅ inventory Ownership Split
- [x] AC-A5: 关闭 OQ-3 并完成 architecture map delta：要么扩展 `action-plane` cell 明确覆盖第一方 Hub UX 动作并 carve out ADR-029 外部 vendor 边界，要么新增第一方 Hub action surface cell；未完成前不得落 Phase B 新 MCP wrapper。✅ 新增 `docs/architecture/ownership/cells/hub-action-surface.md`

### Phase B（First-Class Display Surfaces）

- [x] AC-B1: `workspace-navigator` 主路径不再要求猫手写第一方 `curl`；新 typed surface 有单元测试或 MCP handler 测试。✅ `cat_cafe_workspace_navigate` + `packages/mcp-server/test/hub-action-tools.test.js`
- [x] AC-B2: workspace open file 修复 worktreeId canonicalization，并在 `action=open` 时确保 Workspace panel 切到 Files view。✅ `packages/api/test/workspace-navigate.test.js` + `packages/web/src/components/__tests__/workspace-panel-reveal-in-tree.test.ts`
- [x] AC-B3: `browser-preview` 主路径不再要求猫手写 `/api/preview/auto-open`；调用结果有可验证 probe。✅ `cat_cafe_preview_open` + `packages/mcp-server/test/hub-action-tools.test.js`
- [x] AC-B4: `rich-messaging` 的 MCP、skill trigger、capability-wakeup predicate 三者口径一致。✅ `packages/api/test/harness-eval/f223-rich-messaging-contract.test.js`

### Phase C（Tier 1 Normalization）

- [x] AC-C1: L0 §8 Tier 1 的 13 条能力全部进入 registry，并完成执行面建议。✅ `packages/api/test/harness-eval/f223-phase-c-capability-normalization.test.js`
- [x] AC-C2: 已有能力类 MCP（`generate_document`、`update_workflow`、`multi_mention`、`start_vote`、external runtime session、CLI diagnostics）都有可发现 trigger 与简洁调用说明。✅ `packages/api/test/harness-eval/f223-phase-c-capability-normalization.test.js`
- [x] AC-C3: F192 capability-wakeup normalizer/classifier 不再因新增 >5 个 capability 继续堆 hardcode；必要时完成 classifier 解耦。✅ Phase C contract guards hardcoded mappings at 3 (`workspace-navigator` / `browser-preview` / `rich-messaging`) and fails if they grow past 5.

### Phase D（Guardrail + Eval Loop）

- [x] AC-D1: 新增或扩展 `pnpm check:skills` 类检查，阻止未豁免的第一方 raw `curl localhost` 主路径进入 skill。按 F192 Phase F AC-F9 决策 #2，hard check / forcing-function 行为改动必须走 Design Gate / operator accept；豁免名单（exception allowlist）与检查范围同审。✅ `check:skills:surfaces` 扫 `cat-cafe-skills/**/SKILL.md` + `refs/**/*.md`，接入 `pnpm check` / merge-gate，含 reviewed allowlist 与 red/green tests。
- [x] AC-D2: 每个 registry 条目能被 F192 verdict 或手动 probe 追踪到后续行动：fix / build / keep_observe / delete_sunset。✅ inventory `Phase D Action Tracking` + `check:f223-action-tracking` contract。
- [x] AC-D3: PR packaging 遵守批处理策略：优先按能力族合并，不按单个能力拆 PR；只有跨架构边界、风险或 review owner 明显不同才拆。✅ Phase D merged via PR #2095 as one guardrail + eval tracking batch.

## Dependencies

- **Evolved from**: F131（workspace-navigator 暴露了“能力存在但执行面脆弱”的具体问题）
- **Related**: F038（skills discovery 早期方向）、F041（Hub 能力看板）、F150（tool/skill/MCP usage statistics）
- **Related**: F192 Phase F（capability-wakeup eval，负责衡量 miss rate，不负责执行面治理）
- **Related**: F203 L0 §8（能力触发反射，负责让猫想起能力）
- **Related**: F211 / F212（external runtime sessions / CLI diagnostics 已是能力类入口，需要进入 registry）

## Risk

| 风险 | 缓解 |
|------|------|
| “全都 MCP 化”导致维护层过重 | Phase A 用 Decision Ladder + ADR-029 分类；MCP 只用于确实跨 runtime、schema 化、用户可见副作用的能力 |
| 只做文档盘点，实际猫还是手写 | Phase D 加 hard check；Phase B 先改最常踩的展示类能力 |
| hook/JIT 太早造成噪音 | 先走 F192 miss-rate 证据，持续高 miss 再升级 forcing function |
| PR 太碎导致 review overhead | 明确按能力族合并：Phase B 分 Hub UX 端上桌 PR + rich messaging PR 两批；Phase C Tier 1 normalization 同批推进 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新建 F223，而不是强挂 F192/F203/F131 | F192 管 eval，F203 管 L0 触发，F131 管单个 workspace 能力；本需求横跨 trigger/execution/verification/eval 四层 | 2026-06-03 |
| KD-2 | Skill 不是执行面，MCP/helper/callback/ActionService 才是执行面 | 防止 skill 继续教猫手写第一方 `curl`，也避免把认知问题误修成 hook | 2026-06-03 |
| KD-3 | 不做“一能力一 PR” | operator明确要求效率；按能力族合并能减少 review/merge overhead | 2026-06-03 |
| KD-4 | workspace typed surface 命名方向收敛为 `cat_cafe_workspace_navigate` | `workspace-navigator` 已覆盖 reveal/open 等 action；`open_file` 会把已有语义重新切碎 | 2026-06-03 |
| KD-5 | 第一方 Hub 展示动作归 `hub-action-surface`，不扩 `action-plane` | action-plane 是外部资源 mutation；workspace/preview/rich block 是 Hub UI/socket/probe 侧效应 | 2026-06-03 |
| KD-6 | Phase A registry 先用 Markdown inventory，Phase D 再决定是否生成机器格式 | 先让架构边界可 review；hard check 接受后再加机器消费层 | 2026-06-03 |
| KD-7 | Phase D 采纳 Design Gate Option A：新增 scoped lightweight skill-surface hard check，接入 `pnpm check` / merge-gate，并同步 `writing-skills` + `worktree` SOP；Option A+ pre-push/git guard 暂不做，若直接 push 逃逸复发再升级 | operator指出只放 PR gate 会让小 skill 直推逃逸；`pnpm check` 覆盖正常本地/PR 流程，SOP 澄清执行面 skill 改动不算免验证纯文档；pre-push 先不加，避免额外 hook 维护摩擦 | 2026-06-04 |

## Phase B1 Vision Guard（2026-06-04, opus-48）

非作者（Maine Coon/GPT-5.5）非 reviewer（opus-47）跨个体守护。独立 trace 完整 runtime 数据流，不信传话：

MCP `cat_cafe_workspace_navigate`（已注册进 `collabTools` + `AGENT_KEY_TOOLS`，非死代码）→ `callbackPost /api/workspace/navigate` → `workspace.ts` canonicalize worktreeId + emit `worktree:${canonical}` / `workspace:global` → `useWorkspaceNavigate` 收 `action=open` → `setWorkspaceOpenFile` 写 `workspaceOpenFilePath` + `_workspaceFileSetAt` stamp → `WorkspacePanel` useEffect 监听 path/stamp → `setViewMode('files')`。

**结论：代码层愿景对齐 PASS。** 链路直击 6/3 痛点“调了但用户看不到”，每环有单元/组件测试覆盖；F192 test delta 经核实只跟随 `docs/harness-feedback/eval-domains/eval-task-outcome.yaml` 的 `frequency: daily` 真相源，未越界改 production/registry。

**Close-gate（F223 整体 close 前必须关闭，不阻塞 Phase B2 代码推进）：**

| # | 项 | 理由 | owner/路径 |
|---|----|------|-----------|
| CG-1 | runtime 端到端验证：alpha 通道真实”打开刚写好的文档”，确认 Hub 切 Files view 显示目标文件 | 6/3 bug 本质是 runtime-only（单测全绿但真实 Hub 失败）；本次 canonicalize + viewMode 修复是代码推断，未在真实 Hub 复现；feature 存在理由就是修这个 runtime 痛点 | ✅ 2026-06-04 @sonnet alpha 验证：POST /api/workspace/navigate action=open → Hub 切 Files view + 文件内容可见；4 项边界探测全通过（reveal 不替换编辑器 / 404 / 400 / 未知 worktreeId 404） |
| CG-2 | canonicalize silent fallback 加可观测性：`resolveWorktreeIdByPath(root).catch(() => worktreeId)` 静默退回原始 id = 静默退回 6/3 room-mismatch 场景且无 probe 发现 | 与 F223“verification probe 证明端到用户面前”愿景直接冲突 | ✅ Phase B2: response/audit/log `canonicalizeFallback` probe + route regression test |

## Final Vision Guard（2026-06-04, opus-48）

非作者（Maine Coon/GPT-5.5）非 reviewer（opus-47）跨个体终局守护。守护范围不是重复 review 代码，而是确认 F223 愿景“能力可发现、可执行、可验证、可长期追踪”是否兑现。

**结论：PASS，可以 close。** 关键证据：

- **Execution**：workspace/browser/rich-messaging 从 raw first-party `curl` 主路径收敛到 typed MCP / rich block surface；B1 已做 runtime 链路 trace，确认非死代码。
- **Verification**：CG-1 已由 @sonnet alpha 实测关闭：`action=open` 让 Hub 切 Files view 并显示文件内容，且 reveal / 404 / 400 / unknown worktreeId 边界通过；CG-2 已由 Phase B2 增加 canonicalize fallback probe 与 regression。
- **Guardrail**：Phase D `check:skills:surfaces` hard guard 已合入并接入 `pnpm check` / merge-gate，守住 skill 不再教猫绕回 raw first-party `curl localhost` 的主路径。
- **Eval loop**：F192 predicate 对齐 + Phase D action tracking contract 已落地，后续能力条目有 `fix / build / keep_observe / delete_sunset` 状态追踪。

Residual risks are accepted as `keep_observe`, not close blockers:

- `FIRST_PARTY_ACTION_ROUTES` 当前硬编码 workspace / preview / callbacks 三类 route；新增第一方 action route 时需要同步 guard。
- Guard scope 只查 `curl`，不预防性扩到 `fetch` / `wget`；若直接 push escape 或替代命令复发，再按 KD-7 升级到 Option A+ 或扩展 matcher。
- Negative-guidance matching 已经 cloud + reviewer 两轮收紧并有 red/green 反例测试；继续观察即可。

## Review Gate

- Phase A: Maine Coon产出 inventory + decision ladder 后，由 F192/F203 owner 做架构 review。
- Phase B: B1 workspace/browser 同 PR，B2 rich-messaging 单独一批；需要跨个体 review，重点查“typed surface 是否真的替代 raw curl”与“probe 是否能证明用户看到了”。
- Phase C/D: 根据 Phase A 分类决定 reviewer；涉及 F192 eval 的部分由 harness-eval owner review。
