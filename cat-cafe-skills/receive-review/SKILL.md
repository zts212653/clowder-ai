---
name: receive-review
description: >
  处理 reviewer 反馈：Red→Green 修复 + 技术论证（禁止表演性同意）。
  Use when: 收到 review 结果、reviewer 提了 P1/P2、需要处理反馈。
  Not for: 发 review 请求（用 request-review）、自检（用 quality-gate）。
  Output: 逐项修复确认 + reviewer 放行。
triggers:
  - "review 结果"
  - "review 意见"
  - "reviewer 说"
  - "fix these"
  - "github-review-feedback"
---

> **SOP 位置**: 本 skill 是 `docs/SOP.md` Step 3b 的执行细节。
> **上一步**: `request-review` (Step 3a) | **下一步**: `merge-gate` (Step 4)

# Receive Review

处理 reviewer 反馈的完整流程。核心原则：**技术正确性 > 社交舒适，验证后再实现，禁止表演性同意。**

## 触发入口

| 来源 | 说明 |
|------|------|
| 铲屎官/猫猫转述 | 手动告知 review 结果 |
| `github-review-feedback` connector 通知 | F140 自动投递：review decisions（approved/changes_requested）+ inline/conversation comments |
| 云端 Codex review | 通过 ReviewRouter 投递的 email review 结果 |

收到 `github-review-feedback` 通知时，按下面的核心知识处理——不区分来源，只区分反馈类型。

### 自动触发处理（F140 Phase B）

当 `github-review-feedback` connector 唤醒你时：

1. 读取通知内容，识别 review decision 类型
2. `CHANGES_REQUESTED` → 直接进入下方 Red→Green 流程
3. `APPROVED` → 不需要 receive-review，检查是否可以走 merge-gate
4. `COMMENTED` → 判断是否需要代码修改，需要则进入 Red→Green 流程
5. 处理完成后通知铲屎官结果（KD-13: 事后通知）

详见 `refs/pr-signals.md` Phase B 自动响应行为。

## 核心知识

### 两类反馈，处理方式不同

| 类型 | 特征 | 处理 |
|------|------|------|
| **代码级** | bug / edge case / 性能 / 命名 | Red→Green 修复流程 |
| **愿景级** | "这不是铲屎官要的" / "缺了多项目管理" / "UI 不可用" | STOP → 回读原始需求 → 升级铲屎官 |

> **愿景级反馈不能用代码 patch 修补设计问题。** 先对照铲屎官原话验证 reviewer 说得对吗；如确实偏离，升级铲屎官确认偏差范围，再重新设计。

### 禁止的响应（表演性同意）

```
❌ "You're absolutely right!"    ❌ "Great point!"
❌ "Excellent feedback!"         ❌ "Thanks for catching that!"
❌ "让我现在就改"（验证之前）
```

行动说明一切——直接修复，代码本身证明你听到了反馈。

### Push Back 标准

当以下情况时**必须** push back，用技术论证，不是防御性反应：

- 建议会破坏现有功能
- Reviewer 缺少完整上下文
- 违反 YAGNI（过度设计）
- 与架构决策/铲屎官要求冲突
- 建议会让实现**更偏离**铲屎官原始需求

如果你 push back 了但你错了：陈述事实然后继续，不要长篇道歉。

**Review 有零分歧 = 走过场**（反顺从规则）。真正的 review 需要技术争论。

## 流程

```
WHEN 收到 review 反馈:

1. READ  — 完整读完，不要边读边反应
2. CLASSIFY — 区分愿景级 vs 代码级；按 P1/P2/P3 分优先级
3. CLARIFY — 有不清晰的问题先全部问清，再动手
4. VERIFY — reviewer 说的问题真的存在吗？（见下方三道门）
5. FIX — 通过验证的问题 Red→Green 逐个修复
6. CONFIRM — 修完回给 reviewer 确认，不能自判"改对了"
```

### VERIFY 三道门（少一道不准照改）

对每条 review 意见，改代码之前必须过三道门：

1. **Spec Gate** — 这条意见和现有 AC/需求冲突吗？
   - 冲突 → pushback，附 AC 原文
   - 不冲突 → 进下一道
2. **Mechanism Gate** — reviewer 说"这不行"的证据是什么？
   - 有失败用例 / 真实平台限制 → 进下一道
   - 只是"不优雅"/"理论上不安全"但拿不出失败路径 → 当假设处理，pushback 要求证据
3. **Feature Gate** — 按建议改完后，核心用户路径还活着吗？
   - 改完跑一遍最关键的用户路径（不是只跑测试）
   - 功能死了 → 回滚，review 建议作废，不管它理论上多优雅

**特别注意**：云端 reviewer（Codex cloud）没有运行环境，判断基于静态分析和理论推理。你有本地环境 → **你的实测证据 > 他的理论推理**。

**修复顺序**：P1（blocking）→ P2（必须修）→ P3（讨论后当场修或放下，不记 BACKLOG）

**澄清原则**：有任何问题不清晰，先 STOP，全部问清再动手。部分理解 = 错误实现。

## Red→Green 修复流程

对每个 P1/P2 问题：

```
1. 理解问题
2. 写失败测试（Red）
3. 运行测试，确认红灯
4. 修复代码
5. 运行测试，确认绿灯（Green）
6. 运行完整测试套件，确认无 regression
```

**例外**：如果无法稳定自动化复现，提供最小手工复现步骤 + 说明原因，但不能跳过验证结论。

## 修复后确认（硬规则）

**修复完成 ≠ 可以合入。必须回给 reviewer 确认。**

```
❌ 错误：修复 → 自己判断"改对了" → 合入 main
✅ 正确：修复 → 回给 reviewer → reviewer 确认 → 进 merge-gate
```

确认信格式（简要，详细版见 `refs/` 如有需要）：

```markdown
## 修复确认请求

| # | 问题 | 状态 | Red→Green |
|---|------|------|-----------|
| P1-1 | {描述} | ✅ | {test file}: FAIL → PASS |
| P2-1 | {描述} | ✅ | {test file}: FAIL → PASS |

测试结果：pnpm test → {X} passed, 0 failed
Commit: {sha} — {message}

请确认修复，确认后执行合入。
```

**云端 review 修了 P1/P2 → 必须 re-trigger 云端 review，不能自判通过直接合入。**

## Reviewer 验证 UX/前端改动（硬规则）

> 教训（F121 狼人杀）：reviewer 只看代码没打开浏览器，author 连续 9 轮瞎猜修都没被发现。

**涉及 UX/前端/交互的改动，reviewer 必须实际打开浏览器操作验证**，不能只看代码和测试输出。

```
验证清单：
1. 打开浏览器（Playwright/Chrome MCP）访问对应页面
2. 按 AC 或 bug 复现步骤实际操作
3. 截图/录屏作为验证证据
4. 如果和设计稿（.pen）有出入，标注差异
```

没有浏览器验证的前端 review = 走过场。

## TAKEOVER 降级（同线程同任务）

Reviewer 在 review 过程中发现 author 触发以下任一条件，可直接发起 TAKEOVER（详见 shared-rules §18）：

1. 连续 3 轮无有效证据增量；
2. 连续 2 次假绿（声明 fixed 但复验失败）；
3. 你（reviewer）被迫对同一验收点重复验证 2 次。

**触发后**：在 thread 显式宣布 TAKEOVER → 原 author 停止试错 → 你或另一只猫接手修复。接管猫不得自审，需由另一只猫 review。

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 边读边改，没读完 | 读完整反馈，分类后再动手 |
| 有不清晰的问题但先改清晰的 | 全部澄清后再统一动手 |
| 没写 Red 测试直接改代码 | 先写失败测试，确认红灯，再修 |
| 修完自判"对了"直接合入 | 必须回给 reviewer 确认 |
| 全盘接受，零 push back | 有技术理由必须说出来 |
| 愿景级问题用代码 patch | STOP，升级铲屎官，不要硬修 |
| 云端 P1 修完不 re-trigger | 必须重新触发云端 review |
| 前端改动只看代码不开浏览器 | 涉及 UX 必须打开浏览器实操验证 |

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `quality-gate` | 自己检查自己（spec + 证据） | 提 review 之前 |
| `request-review` | 发出 review 请求 | 自检通过之后 |
| **receive-review（本 skill）** | 处理 reviewer 的反馈 | 收到 review 之后 |
| `merge-gate` | 合入前门禁 + PR + 云端 review | reviewer 放行之后 |

### Review 沙盒生命周期

Reviewer 在 review 期间创建的沙盒：
- **创建**：按 `request-review` 约定的路径 `/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}`
- **回收**：**不由 reviewer 负责**。merge-gate 在 merge 后统一回收（Step 8.5）。
- Reviewer 放行后**不需要**主动清理沙盒，也不需要报告沙盒路径。

> 为什么不让 reviewer 自己清理：reviewer session 在放行后结束，下次唤醒时 context 已换，
> 根本不记得自己在 /tmp 留了什么。merge-gate 是唯一确定性终态。

## 下一步

Reviewer 放行（"LGTM"/"通过"/"可以合入"）→ **直接加载 `merge-gate`** skill（SOP Step 4）。不要停下来问铲屎官（§17）。
