---
feature_ids: [F171]
related_features: [F087, F110, F127, F105, F115, F075]
topics: [onboarding, first-run, gamification, installer, cat-template, roster, bootcamp]
doc_kind: spec
created: 2026-03-26
updated: 2026-04-06
---

# F171: First-Run Quest — 首次安装零成员 + 游戏化新手引导

> **Status**: in-progress (Phase A-B done, C mostly done, D mostly done, E partial)
> **Owner**: Maine Coon + Ragdoll | **Priority**: P1

## Why

当前首次安装仍是"预装团队即开即用"模型：安装阶段会触发认证配置，运行时默认就有完整成员 roster。这个路径与新目标冲突：

1. 安装完成后默认 `0 active members`
2. `cat-template.json` 作为角色模板库（灵魂层），不再等同于运行成员
3. 首次打开时走可跳过的新手任务流程：创建第一只猫 → 配认证/模型 → 连通性检查 → 自我介绍 → 故意犯错 → 引入监督猫
4. 安装流程不再强制填写 API key，认证后置到引导中
5. 安装 client 补齐 opencode

CVO 明确拍板（2026-03-26）：
- 犯错机制采用"故意制造明显问题"（非不可控的真实失败）
- 作为独立 Feature 立项，不直接改写 F087
- 在独立 worktree/分支完成开发和验证后再考虑合入 main

## Current Runtime Flow

当前用户可见的完整流程（Wizard + Bootcamp 两层）：

```
┌─ UI Wizard（FirstRunQuestWizard / HubAddMemberWizard）─┐
│  模板选择 → Client 选择 → 认证/模型 → 连通性探测       │
│  → 创建第一只猫 → 自动建 bootcamp thread               │
└──────────────────────────────────────────────────────────┘
                          ↓
┌─ Bootcamp Skill Phases（bootcamp-guide/SKILL.md）──────┐
│  phase-1-intro（自我介绍）                              │
│  → phase-2-env-check（环境检测）                        │
│  → phase-7-dev（开发 + overlay tip）                     │
│  → phase-7.5-add-teammate（Hub 遮罩引导添加第二只猫）   │
│  → phase-11-farewell（毕业 + 选正式项目）               │
│  → phase-5~10（可选：完整项目生命周期）                 │
└─────────────────────────────────────────────────────────┘
```

**注意**：选引导猫由 FirstRunQuestWizard 完成，创建猫后直接建 bootcamp thread 从 `phase-1-intro` 开始。Phase 3（配置帮助）在 happy path 中跳过（phase-2→phase-4），仅在环境缺失时进入。

## What

### Phase A: 模板/成员硬分层 + 零成员启动基线 ✅

- 运行态配置拆分为：
  - `Template Catalog`：角色模板（来自 `cat-template.json`）
  - `Runtime Members`：活跃成员（首次为空，`cat-catalog.json`）
- API 明确区分 `/api/cat-templates`（模板）与 `/api/cats`（当前成员）
- 空启动为默认行为（无环境变量开关，首次安装始终零成员）
- 零成员时系统可启动、UI 可引导，不因空 roster 崩溃

### Phase B: 安装器改造（认证后置 + opencode）✅

- `install.sh` 默认不进入逐客户端 API key/OAuth 问答
- 认证迁移到首训引导"添加成员"步骤处理
- CLI 检测与安装列表纳入 `opencode`

### Phase C: First-Run Quest 首次引导入口 ⚠️ mostly done

- 当检测到 `active members = 0 && 无 bootcamp thread` 时，自动弹出引导弹窗
- 引导 Wizard：模板选择（TemplatePicker）→ Client 选择 → 认证/模型 → 连通性探测
- 创建第一只成员后自动建 bootcamp thread，猫猫发出自我介绍
- **统一模板选择**：`HubAddMemberWizard` 普通模式和 bootcamp 模式共用（不再有两套流程）
- **账号认证统一**：新建/编辑共用 `UnifiedAuthModal`，支持 OAuth（内置 Client）和 API Key 两种模式
- **账号类型模型简化**：移除冗余的 `builtin` 标记和 `ProfileKind` 类型，`authType: 'oauth' | 'api_key'` 成为唯一判别轴。移除前端 `ensureBuiltinAccounts()` 幽灵 profile 合成逻辑和 `hub-quota-pools` 的 fallback builtin profile 创建——Hub 只显示真实存在的账号
- **ProfileCard 显示修正**：无自定义 baseUrl 时显示供应商默认地址（如 `api.anthropic.com`），API Key 状态统一为 `已配置/未配置`

**残留**：
- legacy `/api/first-run/quest` 路由仍保留（待清理或复用）
- QuestBanner 代码仍存在

### Phase D: 故意犯错 + 多猫协作引入 ⚠️ partial

- SKILL.md 已重写（435→201 行），Phase 4 引导猫故意制造明显问题
- `BootcampGuideOverlay` 组件已创建，支持 spotlight/tips/floating 三种模式
- Phase 7.5 分步遮罩引导（open-hub → click-add-member → fill-form → done）已落地，并能在 reload / Hub 已开场景下自动对齐 guideStep
- Phase 7 新输出结束后会自动查找当前线程可安全判定的 preview 端口，并 auto-open Browser panel
- **Phase 9 完成内容**：改用 `post_message` 自然消息 + `create_rich_block` interactive card-grid（16 个项目选项，3 级难度），替代原来的 BootcampListModal
- **数据同步安全网**：invocation 结束时 re-fetch thread bootcampState，应对 WebSocket `thread_updated` 未到达前端（worktree 端口隔离等）
- **Phase 7.5 WebSocket 链路修复**：`callback-bootcamp-routes` 推进 phase 后通过 `thread_updated` 事件广播 `bootcampState`，前端 `useChatSocketCallbacks` 实时更新 store，ChatInput 的 `disabled` 检查生效
- **guideStep 初始化**：SKILL.md 的 phase-7.5 转换显式设置 `guideStep='open-hub'`，确保前端立即阻断输入并拉起 overlay
- **首条回复改用 `post_message`**：避免 agent message（CLI output）默认折叠导致新用户迷茫
- **成就映射修正**：`bootcamp-env-ready` 从 phase-3（happy path 跳过）迁移到 phase-4（收敛点）

**未闭环**：
- 端到端流程未完成验收

### Phase E: 迁移、回归与文档 📋 out-of-scope for PR #520

> **Scope decision**: PR #520 delivers Phase A-D (new-install first-run quest).
> Phase E (legacy migration, full regression, docs) is follow-up work.
> **Tracking**: [clowder-ai#581](https://github.com/zts212653/clowder-ai/issues/581)

- [x] Feature registry 编号冲突已解决（F171 retarget）
- [ ] 现有项目迁移策略（legacy `cat-config.json` → `cat-catalog.json`）— follow-up
- [ ] 完整回归测试覆盖 — follow-up
- [ ] README/SETUP 文档更新 — follow-up

## Acceptance Criteria

### Phase A（模板/成员分层）
- [x] AC-A1: 首次运行（无历史 catalog）时，`active members` 为空，服务与前端均能正常启动
- [x] AC-A2: 模板查询接口返回完整模板库；成员接口仅返回活跃成员
- [x] AC-A3: mention 路由、候选列表在零成员场景下不崩溃，给出引导提示

### Phase B（安装器）
- [x] AC-B1: `install.sh` 默认安装流程不再要求用户填写 API key
- [x] AC-B2: 安装检测列表支持 `opencode`
- [x] AC-B3: 认证在首训建猫流程中完成闭环

### Phase C（首启引导）
- [x] AC-C1: 无成员首次进入时自动弹出引导对话框
- [x] AC-C2: 创建第一只猫流程包含：模板选择、client 选择、认证、模型、探测
- [x] AC-C3: 成员创建成功后，猫猫自动发出自我介绍消息
- [ ] AC-C4: 普通模式和 bootcamp 模式共用 HubAddMemberWizard（E2E 验证） *(follow-up: wizard 已统一，E2E 验证需运行态环境)*

### Phase D（故意犯错 + 协作）
- [x] AC-D1: Phase 7 猫猫独立开发，前端 overlay 弹 tip，且可安全判定时自动把 preview 端上桌
- [x] AC-D2: Phase 7.5 分步遮罩引导添加第二只猫（WebSocket 链路 + guideStep 初始化 + 前端阻断）
- [ ] AC-D3: 完成首训后明确提示 Console 管理入口 *(follow-up: farewell phase 已有毕业提示，Console 入口提示待 UX 设计)*

### Phase E（迁移与质量）— out-of-scope for PR #520
- [ ] AC-E1: 现有已配置项目升级后不丢成员、不破坏原有路由 *(follow-up)*
- [x] AC-E2: 后端/前端/安装关键路径测试通过 *(CI green)*
- [ ] AC-E3: SETUP/README 文档完成更新 *(follow-up)*
- [x] AC-E4: Feature registry 编号冲突解决 *(F171 retarget, `39ccb1b1`)*

## Known Gaps

| Gap | 说明 | 影响 |
|-----|------|------|
| 模板自动回填有限 | HubAddMemberWizard 仅在模板带 `provider/defaultModel` 时自动选 client/model | 模板数据不完善时用户仍需手动选 |
| Legacy quest 残留 | `/api/first-run/quest` 路由、quest state、QuestBanner 代码仍在 | 技术债，与新 bootcamp 流程重复 |
| CLI 认证环境 | worktree 测试时 codex CLI 无凭据导致 invoke 空返回 | 阻塞 openai/codex 路径的端到端测试 |
| ~~F140 编号冲突~~ | ~~index.json 中 F140 已分配给 PR Automation~~ | ✅ 已解决：onboarding retarget 到 F171，F140 保留为 PR Signals |

## Dependencies

- **Evolved from**: F087（训练营机制可复用为任务后半段）
- **Related**: F110（训练营引导能力增强）
- **Related**: F127（运行时成员管理与动态创建）
- **Related**: F105（opencode client 接入基础）
- **Related**: F115（安装流程优化）
- **Integration**: F075（成就系统，bootcamp phase 迁移触发成就解锁）

## Risk

| 风险 | 缓解 |
|------|------|
| 模板/成员拆分影响面大 | 分 Phase 落地，先接口分层再切默认行为 |
| 零成员导致 mention/路由异常 | 零成员 guard + 集成测试 |
| "故意犯错"体验不稳定 | 可观测且高概率失败的模板 + fallback 文案 |
| 安装器改动影响已有用户 | 保留非交互安装兼容 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 用户点击"跳过首训"后，是永久不再弹，还是仅本次跳过？ | ✅ **已更正**: session-only skip（后端检测 `cats + bootcamp threads`，非 localStorage 永久）|
| OQ-2 | 首训任务池是否复用 F087？ | ✅ 已定: Phase 4 不走任务池，改为用户自述风格 → 猫猫执行 → 故意犯错 |
| OQ-3 | F140 编号冲突如何解决？ | ✅ 已解决: onboarding retarget 到 F171（铲屎官拍板 2026-04-24），F140 保留为 GitHub PR Signals |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立立项，不并入 F087 | 首次上手与进阶训练营职责不同 | 2026-03-26 |
| KD-2 | ~~真实失败~~ → 故意制造明显问题 | 可控且体验稳定；猫"自信满满"交付→前端 tip 引出协作 | 2026-03-26 → 04-03 更正 |
| KD-3 | 安装流程不问 API key，认证后置 | 降低首次安装门槛 | 2026-03-26 |
| KD-4 | `cat-template` 与 `active members` 硬分层 | 满足"首次 0 成员"与角色卡建猫 | 2026-03-26 |
| KD-5 | ~~跳过=永久(localStorage)~~ → session-only skip | 后端检测 `cats.length + bootcamp threads`，前端无持久 skip 状态 | 2026-03-26 → 04-03 更正 |
| KD-6 | Phase 4 改为"用户描述风格→猫猫执行→故意犯错" | 比任务池更自然，用户参与感强 | 2026-04-03 |
| KD-7 | HubAddMemberWizard 统一普通/bootcamp 模式 | 避免两套流程、提高模板复用 | 2026-04-03 |
| KD-8 | Phase 7.5 guideStep 可从界面状态自动恢复 | reload 或 Hub 已开时自动跳过已完成步骤，避免遮罩卡死 | 2026-04-06 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-26 | F171 kickoff（独立 Feature）|
| 2026-03-26 | Phase A/B 完成: 零成员启动 + 模板分离 + 安装器改造 |
| 2026-03-26 | Phase C 基础完成: 首启向导 + 客户端检测 + quest 状态机 |
| 2026-03-27 | 统一 bootcamp overlay + flash guard + dev-reset 脚本 |
| 2026-03-28 | backend-only 首次检测 + natural first-project flow |
| 2026-03-29 | 故意犯错 + delayed tip 机制 |
| 2026-03-30 | template-based 建猫 + HubAddMemberWizard 统一模板选择 |
| 2026-04-03 | Rebase onto main, SKILL.md 重写 (435→201 行), feature doc 刷新 |
| 2026-04-06 | 修复 BootcampGuideOverlay 事件链：phase-7-dev tip 延迟门控 + 自动推进到 phase-7.5 + late-mounted target click delegation |
| 2026-04-06 | Phase 7 preview 自动串联：新输出结束后自动选择安全 preview 端口并 auto-open Browser panel；preview auto-open 增加 thread 过滤 |
| 2026-04-06 | Phase 7.5 reload 恢复：Hub 已开或下一步目标已出现时，遮罩自动推进到正确 guideStep |
| 2026-04-19 | Phase 9 完成内容修复：post_message + card-grid 替代 BootcampListModal；invocation-end data sync 安全网 |

## Branch Status

- **Branch**: `feat/f140-first-run-quest`
- **PR**: zts212653/clowder-ai#520
- **Relative to main**: 45 commits ahead, 0 behind (merged upstream/main 2026-04-19)

## Review Gate

- Phase A/B: Maine Coon 安全与兼容性 review 必过（已完成）
- Phase C/D: Ragdoll 做体验与架构守门，CVO 做流程验收（进行中）
- Phase E: 全链路回归（安装→首训→协作）通过后进入 merge gate

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Skill** | `cat-cafe-skills/bootcamp-guide/SKILL.md` | Bootcamp 引导 phase 定义（真相源）|
| **Feature** | `docs/features/F087-cvo-bootcamp.md` | 复用训练营任务与 phase 机制 |
| **Feature** | `docs/features/F127-cat-instance-management.md` | 动态成员管理基础 |
| **Feature** | `docs/features/F105-opencode-golden-chinchilla.md` | opencode 接入基础 |
