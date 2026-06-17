---
feature_ids: [F222]
related_features: [F192, F128]
topics: [frustration, auto-issue, friction-detection, eval]
doc_kind: spec
created: 2026-06-03
---

# F222: Frustration Auto-Issue — 把负体验变成结构化反馈

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-06-04

## Architecture Ownership

Architecture cell: harness-eval
Map delta: none（复用 F128 propose_thread pattern + F192 signal pipeline）

## Why

用户遇到问题时（CLI 报错 / A2A 超时 / 猫反复给错答案），大部分人默默扛或放弃。这些负体验是最有价值的 eval 信号，但目前完全流失。

operator experience（2026-06-02）："比如用户很愤怒了，这种时候介入一下，独立通知，然后采集日志，生成本地的 issue 让用户预览，用户就可以一键提单。"

类似 F128 创建 thread，但触发条件是摩擦信号。

## Current State / 现状基线

N/A（全新能力）。当前用户遇到问题只有两条路：自己解决，或在聊天里手动描述。没有结构化的"问题采集→一键提交"通道。

## What

### Phase A: 摩擦检测 + Auto-Issue 生成

**触发信号**：
- 用户重复说"不对""错了""怎么回事"（文本情绪/关键词）
- CLI 报错 / 工具调用连续失败（exit code / error log）
- @ 了猫但超时没回复（A2A timeout）
- 短时间内连续 cancel 多个工具调用（Permission Cancel 频率突增）
- 用户反复 retry 同一操作

**产出**：
```yaml
kind: auto_issue
trigger: frustration_detected / cli_error / a2a_timeout / cancel_burst
context:
  thread_id: xxx
  recent_messages: [最近 5 条对话]
  error_logs: [如有]
  tool_call_history: [最近 3 个 tool call + approve/cancel]
  cat_involved: opus
user_description: "（用户可编辑的一句话描述）"
status: draft  # 用户预览后才提交
```

**用户体验**："我注意到刚才可能出了问题。我帮你整理了日志和上下文，你看看描述对不对？确认后一键提交。"

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal
- **Users**: operator（问题报告者）+ 猫猫（接单修复者）
- **Activation**: 摩擦信号触发 → 弹 issue 预览卡

### 2. Friction Metric
- 误触发率（没问题也弹）
- 用户跳过率（弹了但用户不理）
- 提交后未处理率

### 3. Regression Fixture
- CLI 报错 → 触发 auto-issue 采集日志 → 用户看到预览
- 连续 3 次 cancel → 触发 → 用户看到预览
- 正常对话（无摩擦）→ 不触发

### 4. Sunset Signal
- 如果触发率很低（用户很少遇到问题）→ 可能系统已经足够好
- 如果用户跳过率 >80% → 触发条件可能太松，需要收紧
- 如果被 code-as-harness 的 harness fix 能力替代（问题自动修掉了不需要报告）→ sunset

## Acceptance Criteria

### Phase A ✅
- [x] AC-A1: 摩擦信号检测（至少支持 CLI 报错 + 连续 cancel 两种触发）
- [x] AC-A2: Auto-issue 卡片生成（rich block，含上下文采集 + 用户可编辑描述）
- [x] AC-A3: 用户确认后 issue 持久化（可被 eval:task-outcome 消费）
- [x] AC-A4: 用户跳过 → 不产生 issue，但 cancel/error 事件仍被 Permission Cancel 记录

### Phase B ✅
- [x] AC-B1: 文本情绪触发 — 用户消息含摩擦关键词（"不对""错了""怎么回事""又来了"等）时触发 auto-issue
- [x] AC-B2: routeParallel 摩擦检测接入（Phase A remote review P2→P3 遗留）
- [x] AC-B3: 误触发防护 — 关键词匹配须结合上下文窗口（避免正常讨论中的"不对"触发）

### Phase C ✅
- [x] AC-C1: A2A 超时触发 — @了猫超过阈值（60s）未响应时触发 auto-issue
- [x] AC-C2: 用户反复 retry 同一操作触发 — 相同消息连续发送 ≥3 次时触发
- [x] AC-C3: Issue 列表 API — GET /api/frustration-issues（用户可查看自己的所有 issue）

## Known Issues (2026-06-05 operator反馈)

### ~~P1: 猫猫 A2A 传球时无用户操作也弹"操作中断"~~ ✅ Fixed (PR #2105)
- **现象**：猫猫互相传球跑 review，用户完全没操作，弹出 frustration auto-issue 卡片
- **根因**：F222 detector 对所有 route completion 无差别运行，不区分 user-origin vs agent-origin
- **修复**：`frustrationAutoIssueEligible` boolean gate — user direct/retry/multi-mention = true，A2A/connector/podcast = false
- **残留 P3**：worklist-inline A2A 在 user-origin route 内仍 eligible（理论边界，无复现，需 per-entry provenance 才能修）

### ~~UX-1: "跳过"应该是反馈信号 + 增加"误报"选项~~ ✅ Fixed (PR #2106)
- **现象**：跳过只改状态不记录原因，浪费 eval 信号；应区分"跳过"和"误报"
- **修复**：新增 `false_positive` 状态 + `POST /false-positive` 路由，按钮变三选一（确认/跳过/误报）

### ~~UX-2: 处理完的卡片应折叠收起~~ ✅ Fixed (PR #2106)
- **现象**：确认/跳过后卡片仍全尺寸展示，"狗皮膏药"影响阅读
- **修复**：处理后自动折叠为一行摘要（标题+状态徽章），可点击展开/收起；hydrated resolved 也默认折叠

### ~~UX-3: "取消并反馈"一键投诉~~ ✅ Fixed (PR #2107 + follow-up)
- **现象**：用户否决权限请求后想投诉，需等 cancel_burst 阈值（≥3 次 60s 内）才能触发 auto-issue
- **operator experience**："我直接！反馈！我投诉！"
- **修复**：AuthorizationCard + hold-ball connector card 新增"取消并反馈"按钮，走 `user_report` 信号（无阈值，每次点击都生成独立 issue），dedup 豁免
- **PR #2113 补强**：持球卡片 live 路径取消持球并反馈；历史/stale 持球卡片遇到 404 时 fallback 到 `POST /api/callbacks/hold-ball/feedback`，后端做 user auth + thread ownership 校验后仍生成 `user_report`，避免反馈静默丢失

## Dependencies

- F192 Phase G eval:task-outcome（Auto-Issue 确认事件作为 Phase G v1 信号源）
- code-as-harness skill（共享摩擦检测 trigger 逻辑，但 Auto-Issue 侧重"采集+报告"而非"诊断+修复"）
