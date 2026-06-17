---
feature_ids: [F235]
related_features: [F222, F168, F141, F128]
topics: [community, publishing, frustration, feedback, github-issue]
doc_kind: spec
created: 2026-06-15
---

# F235: Feedback-to-Community Publisher — 一键发布反馈到社区

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Architecture Ownership

Architecture cell: community-ops
Map delta: update required（community-ops cell 从纯 inbound 扩展为双向；新增 outbound publisher 子域：sanitizer + draft store + GitHub issue publisher）

## Why

operator experience（2026-06-15）："社区小伙伴让猫猫整理完问题，或者你们 F222 这里的卡片他们填写完，这两个场景之后他们可以要么让猫猫发送到社区，要么就是前者猫猫整理完问题变成类似 F128 或者 F225 的卡片，我点 submit 这样直接按照我们开源社区的格式提过来。"

Maine Coon（2026-06-15）实测确认：F222 的"确认提交"只写入本地 Redis FrustrationIssueStore（6 条 confirmed 记录在 `frustration-issue:{issueId}`），**没有任何外发到 GitHub/社区的路径**。用户点了"已提交"以为问题反馈出去了，实际只是本地存了一条 eval 信号——"已提交"这个文案本身就在误导用户。

核心痛点：**本地反馈池和社区看板之间缺一座桥**。F222 是 producer（检测+采集+本地存储），F168 是 inbound engine（GitHub→Cat Café），但 outbound（Cat Café→GitHub）这个方向完全没有。

## Current State / 现状基线

- F222 FrustrationIssue confirmed 后存 Redis，可通过 `GET /api/frustration-issues?status=confirmed` 查到（当前 6 条），无外发动作
- F168 Community Ops Board 只处理 inbound 事件（GitHub webhook/轮询 → Event Log → Projector → 看板），没有 outbound publish 能力
- 社区小伙伴遇到问题只能手动去 GitHub 写 issue：格式不统一、上下文丢失、门槛高
- F128 propose_thread / F225 context management 的卡片模式（preview → submit）是可复用的交互范式

## What

### 架构管线（KD-6，Ragdoll×Maine Coon收敛）

```text
Source adapter                          ← F222 confirmed / 猫猫整理 / 未来其他来源
  ↓
CommunityIssueDraftStore               ← 本地 draft 持久化
  ↓
CommunityIssueSanitizer                ← 白名单 + fail-closed 脱敏
  ↓
Preview rich block                     ← 用户可编辑标题/描述/仓库
  ↓ user submit（二次确认）
GitHubIssuePublisher                   ← bot token → GitHub API
  ↓
CommunityIssueStore / F168 projection  ← 幂等回写，防重复 triage
```

### Phase A: F222 Issue → 社区发布（最短路径）

在 FrustrationIssueCard 确认后，新增"发布到社区"按钮。点击后：

1. **内容整理**：猫猫自动将 FrustrationIssue 的上下文（signal type + signal detail + recent messages + user description）格式化为社区 issue 模板
2. **预览卡片**：生成一张 rich block 预览卡（标题 / 正文 markdown / 目标仓库 / labels），用户可编辑标题和描述
3. **脱敏检查**：自动剥离内部信息（thread ID、internal cat ID、Redis key、session ID 等），只保留用户可见的问题描述和复现步骤
4. **一键发布**：用户点 submit → 调用 GitHub API 创建 issue → 返回 issue URL → 卡片更新为"已发布 #xxx"并附链接

**入口**：FrustrationIssueCard `status=confirmed` 后出现"📤 发布到社区"按钮

### Phase B: 猫猫整理 → 通用发布卡片

更通用的"问题整理→发布"路径，不限于 F222 触发：

1. **猫猫主动整理**：用户描述问题，猫猫采集上下文（对话历史 + 错误日志 + 环境信息），整理成结构化的 issue draft
2. **发布卡片**（类似 F128 propose_thread）：rich block 卡片，含标题/正文/仓库/labels/可编辑区域
3. **submit 流程**：同 Phase A 的预览→脱敏→发布→回链
4. **多目标**：支持选择目标仓库（clowder-ai/cat-cafe、clowder-ai/cat-cafe-tutorials 等）

**入口**：猫猫在对话中主动生成 `kind: community_issue_draft` rich block

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal
- **Users**: 社区小伙伴（问题报告者）+ operator（质量把关）
- **Activation**: Phase A — FrustrationIssueCard confirmed 后出现发布按钮；Phase B — 猫猫在整理问题后主动生成发布卡片

### 2. Friction Metric
- 预览到发布的放弃率（预览了但没点 submit）
- 脱敏误删率（用户发现有用信息被剥掉了）
- 发布后 issue 质量（community maintainer 评价）

### 3. Regression Fixture
- F222 confirmed issue → 点发布 → 预览包含正确标题+正文+环境信息 → submit → GitHub issue 创建成功 → 卡片更新为"已发布 #xxx"
- 预览中不含 threadId / sessionId / Redis key / 内部 catId
- 用户未确认（draft 状态）→ 无发布按钮
- GitHub API 不可用 → 友好错误提示，不丢数据

### 4. Sunset Signal
- 如果 F168 inbound 流程足够好（问题自动被发现和修复），outbound 需求趋零
- 如果社区小伙伴形成了直接在 GitHub 写 issue 的习惯，本功能使用率 <5%

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（F222 Issue 发布）✅
- [x] AC-A1: FrustrationIssueCard confirmed 后显示"发布到社区"按钮（截图可验证）
- [x] AC-A2: 点击后生成预览卡片，用户可编辑标题和描述（截图可验证）
- [x] AC-A3: 预览内容经过脱敏——不含 threadId / sessionId / Redis key / 内部 catId（单测 + 截图）
- [x] AC-A4: submit 后通过 GitHub API 在目标仓库创建 issue（`gh issue list` 可验证）
- [x] AC-A5: 创建成功后卡片更新为"已发布"状态并附 issue URL 链接（截图可验证）
- [x] AC-A6: GitHub API 失败时友好提示，不丢失 draft 数据（手动测试）

### Phase B（通用发布卡片）
- [ ] AC-B1: 猫猫可主动生成 `community_issue_draft` rich block 卡片（运行时验证）
- [ ] AC-B2: 卡片支持选择目标仓库（至少 cat-cafe + cat-cafe-tutorials）
- [ ] AC-B3: submit 流程复用 Phase A 的脱敏→发布→回链管线

## Dependencies

- **Evolved from**: F222（本地反馈池 → 外发出口）
- **Related**: F168（社区运营域，inbound 方向；F235 补 outbound）
- **Related**: F141（GitHub API 层可复用）
- **Related**: F128（propose_thread 的卡片交互范式可复用）

## Risk

| 风险 | 缓解 |
|------|------|
| 脱敏不完整，内部信息泄露到公开 issue | 白名单机制：只允许明确字段通过，其余全部剥离；preview 是人工确认门禁 |
| GitHub API 权限：社区用户可能没有目标仓库写权限 | Phase A 先用 bot token（Cat Café 服务端发布）；Phase B 可选用户 OAuth |
| 发布后 issue 质量差（上下文不足或格式不对） | 使用社区 issue template 自动填充；猫猫整理上下文时遵循模板结构 |
| 与 F168 inbound 产生循环（自己发的 issue 又被 F168 拾取） | 发布后写本地 board projection 做幂等；F168 polling reconcile 时识别已知 issue（by GitHub issue number）跳过重复 triage，但保留 comment/status reconcile |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立 F 号，不放进 F222 | F222 是 producer（检测+本地存储），F235 是 publisher（外发+社区接入），安全语义完全不同（本地 vs 公开副作用），Maine Coon分析 + operator 同意 | 2026-06-15 |
| KD-2 | Phase A 用 bot token，不用 OAuth | 社区用户未必有 clowder-ai 仓库写权限，OAuth 绑定/撤权是新复杂度。issue body 标明 "Reported via Cat Cafe"，不伪装用户。Phase B 可选加 OAuth | 2026-06-15 |
| KD-3 | 目标仓库：配置式 default + allowlist，Phase A 单默认仓库 | 不硬编码 repo 名。Phase A 一个默认仓库 + allowlist 配置；Phase B 加 repo picker UI | 2026-06-15 |
| KD-4 | 脱敏策略：白名单 + fail-closed + 服务端 re-sanitize | 可放：用户编辑后的描述/标题/复现步骤/公开错误摘要。不可放：threadId/userId/catId/invocationId/cardMessageId/Redis key/callback token/session id/完整 recentMessages/debugRef/绝对路径/API key。submit 时服务端必须重新 sanitize，不信前端预览 | 2026-06-15 |
| KD-5 | Phase B 触发：用户主动请求优先，猫可主动建议但发布必须用户二次确认 | 猫可以弹 draft 卡，但不能自动外发。公开发布 = 不可逆外部副作用，必须 opt-in | 2026-06-15 |
| KD-6 | 架构：通用发布管线（CommunityIssuePublisher），F222 只是一个 source adapter | 管线只接受结构化 draft，不关心来源。成功发布后写本地 board projection + 用 GitHub issue number/url 幂等。F168 后续 polling 保留 reconcile/update，跳过重复 triage | 2026-06-15 |

## Review Gate

- Phase A: 跨家族 review（重点审脱敏完整性 + GitHub API 安全）
