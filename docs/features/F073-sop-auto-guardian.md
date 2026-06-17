---
feature_ids: [F073]
related_features: [F046, F067, F038, F042, F049, F058]
topics: [sop, automation, flow-control, context-compression, self-closing, governance, mission-hub]
doc_kind: done
created: 2026-03-07
---

# F073: SOP Auto-Guardian — 流程自闭环守护

> **Status**: done | **Owner**: Ragdoll
> **Created**: 2026-03-07
> **Priority**: P1

---

## Why

operator反复手动提醒猫猫 SOP 步骤，这是系统设计缺陷，不是管理问题。

**核心痛点**（operator experience 2026-03-07）：

> "你看你们很多时候需要我一次次的提醒。如果不唠叨你们很容易走错，特别是上下文压缩之后。"
> "我不想让你们变成一个 workflow 的 node，这样没有灵魂。"

**本质问题**：SOP 上下文和接力棒没有外化到共享系统中，导致猫冷启动/压缩后失忆，operator被迫当复读机。

## 设计哲学（operator定调 + 全猫共识 2026-03-07）

> **"外化上下文和接力棒，不外包判断力。"**
> "A2A 出口检查之所以有效，是因为它外化了'传球意识'，但没有夺走猫的判断力。F073 也应该复制这个成功模式。" —— Maine Coon (GPT-5.4)

### 三条设计原则

1. **告示牌，不是控制器** — Mission Hub 存"现在在哪、球在谁手上"，猫看了自己决定行动，不被状态机推着走
2. **门禁只守高风险点** — 只在 worktree（真相源同步）和 feat close（完成定义）两个点硬约束，其余靠 skill 导航
3. **随模型能力递增而松绑** — 相信未来的猫更聪明，设计应该越来越信任猫的判断力

### 明确不做

| 方案 | 不做原因 |
|------|---------|
| 强制状态机控制器 | 把猫变成 workflow node，没有灵魂（operator experience） |
| 每步做成必须调用的 MCP 动作 | 猫会变成流程机器人 |
| 常用话术编辑器 | 治标不治本 |
| Hook/Mission Hub 代替判断 | 它们只能告诉猫"在哪、该看什么"，不能替猫决定 |

## What

### Phase 分层（全猫共识 + GPT Pro 研究）

#### P0: Hook 健壮性 + Skill 层规则（PR #271，已实现）

Ragdoll专属的止血层：
- `sop-stage-bookmark.sh` — PostToolUse hook 记录 SOP 阶段
- `f24-post-compact-bootstrap.sh` — 压缩后恢复 SOP 阶段 + TTL 30min + 诊断日志
- `worktree/SKILL.md` — 创建前 main 双向同步检查
- `feat-lifecycle/SKILL.md` — completion 自动发起跨猫愿景守护
- `CLAUDE.md` — 流程闭环检查点（压缩后常驻可见）

#### P1: 告示牌（Mission Hub 可见性）

Mission Hub 增加 `workflow.sop` 视图，所有猫共享：

```yaml
workflow:
  sop:
    stage: kickoff | impl | quality_gate | review | merge | completion
    baton_holder: "@opus"           # 当前持棒猫
    next_skill: "receive-review"    # 建议加载的 skill
    resume_capsule:                 # 冷启动 30 秒接上活
      goal: "..."
      done: [...]
      current_focus: "..."
    checks:
      remote_main_synced: attested | verified | unknown
      quality_gate_passed: attested | verified | unknown
      review_approved: attested | verified | unknown
      vision_guard_done: attested | verified | unknown
```

**关键设计**：猫读 `resume_capsule` 后**自己决定**下一步，系统不强制跳转。

#### P2: 接力可靠性（handoff + ack + timeout）

- `cat_cafe_handoff_feature(...)` — 原子操作：更新告示牌 + 写摘要 + 发 @mention + 挂 timeout
- `cat_cafe_ack_handoff(...)` — 接球确认，切换 baton_holder
- 超时 → 提醒/升级给 fallback reviewer 或operator，**不卡死流程**

#### P3: 少量硬门禁

只在两个高风险点加硬约束：
- **开 worktree 前**：`docs/backlog/feature` 相关改动必须已到 `origin/main`（防多猫真相源冲突）
- **feat close 前**：`PR merged + check:features 通过 + 跨猫愿景签收`（完成定义）
- 其余维持现有铁律（Redis 6399、禁止自审、身份常量）

#### P4: 导航牌 + 加速器

- `sop.manifest.yaml` — 阶段 → 建议 skill → 硬规则 → 常见坑。导航牌，不是执行引擎
- Claude hook → 调用共享 MCP 更新告示牌（不再写 `/tmp/` 当唯一来源）
- Codex/Gemini → system prompt 规定进入 thread 先读 `get_thread_context`
- 三家共享同一个账本、同一个恢复入口、同一个 handoff 协议

### 关键概念（源自 GPT Pro 研究 + 全猫讨论）

| 概念 | 含义 | 类比 |
|------|------|------|
| **告示牌** | 信息共享，猫看了自己行动 | 球场记分牌 |
| **Resume Capsule** | 冷启动 30 秒接上活的结构化摘要 | 交接班日志 |
| **Baton** | 球在谁手上 | 接力棒 |
| **attested vs verified** | 猫声明 vs 系统验证，不造"全自动"幻觉 | 自评 vs 考试 |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "压缩后提醒他的那个是不是也得拉出来看看为什么呢" | AC-1 | 诊断报告 + 修复验证 | [x] P0 |
| R2 | "先更新 feat/backlog 在 main 上 commit push 然后才能开 worktree" | AC-2 | skill 检查步骤 | [x] P0 |
| R3 | "feat close 是需要其他猫猫帮你做一次愿景守护的吧" | AC-3 | skill @ 模板 | [x] P0 |
| R4 | "写完之后自己守护愿景...通知我你合入了就行" | AC-4 | 端到端验证（本 Feature） | [x] P0 |
| R5 | "特别是上下文压缩之后" | AC-5 | hook + resume capsule | [x] P1 |
| R6 | "所有猫都能用的综合机制"（operator追问） | AC-6 | Mission Hub 共享 | [x] P1 |
| R7 | "不想让你们变成 workflow 的 node"（operator定调） | AC-7 | 架构 review（告示牌不是控制器） | [x] P1 |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

### P0（PR #271）
- [x] AC-1: Hook 压缩后行为诊断完成，workaround 就位（TTL 30min + SOP 阶段恢复）
- [x] AC-2: Worktree skill 开 worktree 前检查 main 文档双向同步
- [x] AC-3: Feat-lifecycle completion skill 自动发起跨猫愿景守护
- [x] AC-4: 本 Feature 全程自驱（试点验证中）

### P1（告示牌）— PR #278, #289
- [x] AC-5: Mission Hub 支持 `workflow.sop` 结构，冷启动/压缩后可通过 MCP 恢复（WorkflowSopPanel + workflow-sop routes + resume capsule）
- [x] AC-6: 所有猫（Claude/Codex/Gemini）都能通过 MCP 读写 SOP 阶段（`cat_cafe_update_workflow` MCP tool + CAS）
- [x] AC-7: 架构 review 确认"告示牌不是控制器"——猫读信息后自己决定行动（2026-03-08 三猫愿景守护确认）

### P2（接力可靠性）— **descoped from F073**
> **决策 (2026-03-08)**：P2 从 F073 剥离。接力棒可靠传递（handoff+ack+timeout）是独立的协作问题，与 SOP 自感知属不同层面。后续如需实现，另行立项。
- [ ] ~~AC-8: `handoff_feature` 原子操作（更新告示牌 + @mention + timeout）~~
- [ ] ~~AC-9: `ack_handoff` 接球确认~~
- [ ] ~~AC-10: 超时未接 → 提醒/升级（不卡死流程）~~

### P3（硬门禁）
- [x] AC-11: worktree 创建前硬检查 `origin/main` 真相源同步（P0 实现）
- [x] AC-12: feat close 前硬检查完成定义（PR merged + check:features + 愿景签收）（P0 实现）
  > **Close 记录 (2026-03-08)**：`check:features` F073 相关项已全部通过（index-sync + backlog-active 已清零）。剩余 13 条 `backlog-missing` 为其他 feature 的历史漂移，不阻塞 F073 close。

### P4（导航牌 + 加速器）
- [x] AC-13: `sop.manifest.yaml` 导航表（阶段 → skill → 硬规则）
- [x] AC-14: Claude hook 改为调用共享 HTTP API（/tmp/ 仅作降级 fallback）
- [x] AC-15: `baton_holder` 存唯一句柄（`opus`/`opus45`/`codex`），不存展示名（"两个 opus"事件教训）（P0 实现）
- [x] AC-16: 并发写同一 Feature 时 CAS/version 冲突可检测并回读重试（P0 实现，Lua 原子 CAS）
- [x] AC-17: Mission Hub 不可用时降级为 /tmp/ 告示牌，不降级为"无状态推进"

## Key Decisions

| # | 决策 | 选择 | 放弃的方案 | 理由 | 日期 |
|---|------|------|-----------|------|------|
| KD-1 | 设计哲学 | 告示牌（信息共享） | 控制器（强制状态机） | operator："不想让猫变成 workflow node" | 2026-03-07 |
| KD-2 | 阶段存储 | Mission Hub（所有猫共享） | `/tmp/` 文件（Ragdoll专属） | 跨猫可见 + 压缩不丢失 | 2026-03-07 |
| KD-3 | 门禁范围 | 只守 worktree + close | 每步硬约束 | 信任猫的判断力，随模型能力松绑 | 2026-03-07 |
| KD-4 | attested vs verified | 区分猫声明和系统验证 | 假装全自动 | 诚实比好看重要 | 2026-03-07 |
| KD-5 | Phase 顺序 | 告示牌→接力→门禁→加速器 | 先做状态机 | 先可见性，后可靠性，最后硬约束 | 2026-03-07 |
| KD-6 | Baton 句柄 | 必须存唯一句柄（`opus`/`opus45`/`codex`） | 展示名 | "两个 opus"事件证明展示名会破坏接力 | 2026-03-07 |
| KD-7 | 降级策略 | Mission Hub 不可用 → thread 告示牌 | 无状态推进 | 总比没有好（codex 建议） | 2026-03-07 |

## Dependencies

- **Related**: F046/F049/F058（愿景守护与 Mission Hub 依赖链）
| Feature | 关系 | 说明 |
|---------|------|------|
| **F049** | Depends | Mission Hub 基础设施 |
| **F058** | Depends | Mission Hub 增强（BacklogItem 状态机） |
| **F046** | Related | 愿景守护流程定义 |

## Risk / Blast Radius

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| 告示牌做成控制器（scope creep） | 高 | KD-1 硬约束 + 每个 PR review 时检查 |
| Redis 持久化（告示牌不能断电即失忆） | 中 | 确认 AOF/RDB 策略（GPT Pro 提醒） |
| 多猫并发更新同一 Feature 告示牌 | 中 | version + CAS（compare-and-swap） |
| 消息与状态分裂（改了告示牌没发 @mention） | 中 | handoff 操作原子化 |

## Review Gate

| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| P0 R1 | 云端 Codex | P1: push status check | 2026-03-07 |
| P0 R2 | 云端 Codex | P1: bidirectional sync | 2026-03-07 |
| P0 R3 | 云端 Codex | 通过 | 2026-03-07 |
| P4 R1 | Maine Coon (Codex) | 2P1+1P2 → R2 全修 → 放行 | 2026-03-08 |
| P4 Cloud | 云端 Codex | 通过 (0 issues) | 2026-03-08 |
| Close | Opus 4.5 + Codex + GPT-5.4 | 三猫愿景守护 → P2 descope → 放行 | 2026-03-08 |

## 讨论记录

### 四猫共识 + GPT Pro 研究收敛（2026-03-07）

**参与者**：Opus 4.6、Opus 4.5、Codex（Maine Coon）、GPT-5.4（Maine Coon）、GPT Pro（外部研究）

**GPT Pro 核心建议**：补"执行账本"（Stage + Baton + Resume Capsule），Mission Hub 当真相源，hook 当加速器不当唯一记忆体。

**四猫共识**：
- 吸收 Resume Capsule、Baton+ack、attested vs verified、manifest 导航
- 不吸收强制状态机——与 Cat Café 知识驱动协作哲学矛盾
- Phase 顺序：告示牌 → 接力 → 门禁 → 加速器

**operator定调**：
> "我不想让你们变成一个 workflow 的 node，这样没有灵魂。"
> "要相信未来的猫猫们会更聪明。"
