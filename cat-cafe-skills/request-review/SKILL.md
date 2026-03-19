---
name: request-review
description: >
  向跨家族 peer-reviewer 发送 review 请求（含五件套）。
  Use when: 自检通过后准备请其他猫 review。
  Not for: 收到 review 结果（用 receive-review）、自检（用 quality-gate）。
  Output: Review 请求信（存档到 review-notes/）。
triggers:
  - "请 review"
  - "帮我看看"
  - "request review"
---

> **SOP 位置**: 本 skill 是 `docs/SOP.md` Step 3a 的执行细节。
> **上一步**: `quality-gate` (Step 2) | **下一步**: `receive-review` (Step 3b)

# Request Review

把改动送到 reviewer 眼前，让 reviewer 花时间在重点上——不是基础检查上。

## 核心知识

### 前置条件（三项都要满足才能发请求）

| 条件 | 检查方式 | 未满足时 |
|------|----------|----------|
| `quality-gate` 通过 | 有本轮 gate report | BLOCKED — 先跑 quality-gate |
| 测试全绿 | 附测试命令输出 | BLOCKED — 修到绿灯再发 |
| 原始需求可引用 | Discussion/Interview 文档路径 + ≤5 行摘录 | BLOCKED — reviewer 有权拒绝审查 |
| 前端改动已浏览器实测 | Playwright/Chrome 截图证据 | BLOCKED — 涉及前端必须真实打开浏览器验证 |

> **教训（F041）**：review 信只附了 spec，没附原始 Discussion。结果 10 轮云端 review 全在抓 edge case，没有一轮说"UI 不可用"。Reviewer 没有上下文，无法做愿景验证。

### Reviewer 匹配规则

从 `cat-config.json` 动态匹配，**三猫都不能 review 自己的代码**：

```
优先级（从高到低）：
1. 跨 family（author family ↔ reviewer family）
2. peer-reviewer 角色标记
3. 当前可用（无正在进行的 review 任务）
```

### 工具落点自检（Codex apply_patch 陷阱）

在 worktree 分支上用 `apply_patch` 改代码时，改动可能落到主 worktree（`cat-cafe/`）而非当前 worktree。**发请求前必须确认**：

```bash
git status  # 只在目标 worktree 有变更，主 worktree 干净
```

## 流程

```
BEFORE 发 review 请求:

1. 确认 quality-gate 已通过（拿到本轮 gate report）
2. 确认测试全绿（附这次真实运行的输出）
3. 找到原始 Discussion 文档路径 + 摘录 ≤5 行铲屎官原话
4. 检查 worktree 工具落点（git status 干净）
5. 匹配 reviewer（跨 family 优先）
6. 用模板写 review 请求 → 存档 mailbox
7. 发给 reviewer
```

## Review 请求

**使用 `refs/review-request-template.md` 模板**（单一真相源，不在此重复）。

关键字段提醒：
- **Original Requirements**: 必填，≤5 行铲屎官原话 + 来源文档路径，并明确请 reviewer 对照判断
- **Open Questions**: 标注 review 重点，帮 reviewer 快速定位
- **自检证据**: 附 quality-gate report 摘要 + 测试命令输出

存档：*(internal reference removed)*

### Review 沙盒约定（review-target-id）

Review 请求必须包含 `review-target-id`，reviewer 据此创建标准路径的沙盒，merge-gate 回收时依赖此 ID。

**review-target-id 推导规则：**
- 分支名含 `fNNN` → 取 feature ID（如 `f113`）
- 无 Feature ID → 取 branch slug（如 `fix-redis-keyprefix`）

**在 review 请求信中附上：**
```
Review-Target-ID: {id}
Branch: {branch-name}
```

**Reviewer 创建沙盒的标准路径：**
```
/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}
```
例：`/tmp/cat-cafe-review/f113/codex`

沙盒必须是 detached HEAD / read-only。要改代码 = TAKEOVER，开正式 worktree。

## Block 场景

**❌ 没有 quality-gate 报告**

```
⚠️ BLOCKED — 缺少 quality-gate 自检报告

请先运行 quality-gate skill，确认：
- 原始需求逐项对照
- 测试/lint/build 全绿
- 有本轮输出证据

再发 review 请求。
```

**❌ 没有原始需求摘录**

```
⚠️ BLOCKED — 缺少原始需求文档

请附上：
- 铲屎官 Discussion/Interview 文档路径
- ≤5 行铲屎官原话摘录

Reviewer 不只审代码质量，还要判断"这是铲屎官要的吗？"
没有原始需求 = Reviewer 无法做愿景验证 = 有权拒绝审查。
```

**❌ 测试未通过**

```
⚠️ BLOCKED — 测试未全绿

请先修复，再发请求：
  pnpm test                              # 必须 0 failures
  pnpm --filter @cat-cafe/api test:redis # Redis 改动额外跑

Reviewer 不应该是第一个发现测试失败的人。
```

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `quality-gate` | 自检（spec 对照 + 证据） | review **之前** |
| **request-review（本 skill）** | 把改动送到 reviewer 面前 | 自检通过**之后** |
| `receive-review` | 处理 reviewer 的反馈 | 收到 review **之后** |
| `merge-gate` | 合入前的门禁 + PR + 云端 review | reviewer 放行**之后** |

## 下一步

Review 请求发出后 → 等 reviewer 回复 → **直接加载 `receive-review`** skill 处理反馈（SOP Step 3b）。SOP 链条自动推进，不要停下来问铲屎官（§17）。
