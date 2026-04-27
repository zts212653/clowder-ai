# PR 模板 + 云端 Review 触发模板

> 单一真相源。所有猫猫开 PR 和触发云端 review 都用这些模板。
> 修改本文件 = 三猫行为同步，不再有格式不一致问题。

## PR Body 模板

```
## What

{改了哪些文件、核心改动}

## Why

{为什么做这个改动、约束和目标}

## Issue Closure

- Closes #__  {同仓 issue auto-close；intake PR 必填每个 Intake Intent Issue}

## Original Requirements（必填）

- Discussion/Interview: *(internal reference removed)*
- **原始需求摘录（≤5 行，直接粘贴铲屎官原话）**：
  > {例："我要能看到三只猫分别挂了哪些 Skill，按猫分类，一目了然"}
- 铲屎官核心痛点：{用铲屎官自己的话概括}
- **请 Reviewer 对照上面的摘录判断：交付物是否解决了铲屎官的问题？**

## Plan / ADR

- Plan: *(internal reference removed)*
- ADR: `docs/decisions/NNN-xxx.md`（如有）
- BACKLOG: F__ / #__

## Tradeoff

{放弃了什么方案，为什么}

## Test Evidence

pnpm --filter @cat-cafe/api test       # X passed, 0 failed
pnpm --filter @cat-cafe/web test       # X passed, 0 failed
pnpm -r --if-present run build         # 成功

## Open Questions

{reviewer 需要关注的点}

---

**本地 Review**: [x] {reviewer 纯文本句柄，如 gpt52} 已 review 并放行
**云端 Review**: [ ] PR 创建后在 **comment** 中触发（见下方模板）

<!-- 猫猫签名（纯文本，禁止 @）: 例如 Maine Coon/Maine Coon (codex) -->
```

## 云端 Review 触发 Comment 模板

PR 创建后，**立刻发一条 comment**（不是在 PR body 里写）。

### 触发格式（极简，唯一正确格式）

**整个 comment body 只有一行，无任何附加说明：**

```
@codex review
```

**就这两个词。** 不带 SHA、不带规则描述、不带审查标准。Codex connector 会自动 review 当前 HEAD。

> **为什么不能用详细格式**：Codex connector 的解析规则变了——comment body 带多行描述（”Please review latest commit...”、审查标准等）会被解析为**代码修改请求**（code-write intent），而非 review 请求。极简格式经铲屎官 2026-04-20 PR #1300 实战验证：5 分钟内收到 👀 + review。

```bash
# 触发命令
gh pr comment {PR_NUMBER} --body '@codex review'
```

### 去重防呆

```bash
# 检查是否已有 @codex review 触发且被 👀 接单
LAST_TRIGGER=”$(gh pr view {PR_NUMBER} --json comments | jq -r '
  [.comments[] | select(.body | test(“^@codex\\s+review\\s*$”; “m”))] | last | .url // empty
')”
if [ -n “$LAST_TRIGGER” ]; then
  echo “⚠️ 已有 @codex review 触发: $LAST_TRIGGER”
  echo “只有以下情况可再次触发：”
  echo “  - HEAD SHA 变化（有新 commit push）”
  echo “  - 上次触发收到 create-environment 回复（= 没接单）”
  echo “  - 触发 5 分钟后仍无 👀 reaction”
fi
```

### 触发后执行策略（必须遵守）

1. 进入**等待通知**模式，优先等 Cat Café 的 `GitHub Review 通知`
2. 不要高频轮询，不要”看起来没回就再发一次”
3. 10 分钟无通知，只允许一次人工检查：

```bash
gh pr view {PR_NUMBER} --json comments,reviews
```

4. 允许再次触发的条件（满足任一即可）：
   - HEAD SHA 变化（有新 commit）
   - 首次触发收到 “create an environment” 回复（= Codex 没接单）
   - 触发 5 分钟后仍无 👀 reaction

### 注意事项

- `@codex review` 必须写在 PR **comment** 中，不能写在 PR body 里
- 写在 body 里会错误触发 Codex 获取代码修改权限，而非 review 权限
- **PR body（含 HTML 注释）禁止出现任何 `@句柄`（例如 `(@codex)`）**
- 反面案例：PR #160 在 body 签名写 `(@codex)`，触发环境提示评论，污染 review 流程
- 反面案例：PR #1300 用详细模板（含 SHA + 规则描述），触发 “create an environment” 而非 review

## 常见 QA（必须读）

### Q1: 看到 “Create an environment for this repo”，是不是 review 权限缺失？

**不是。**

**⚠️ THIS IS NOT A REVIEW-PERMISSION ERROR. THIS MESSAGE IS ABOUT CODE-WRITE ENVIRONMENT PERMISSION.**

**最常见原因**：comment body 里带了多行内容（SHA、审查标准、规则描述等），Codex connector 把它解析成了**代码修改请求**而非 review。即使第一行是 `@codex review`，附加描述在当前解析规则下仍会触发 code-write intent。

**动作**：删掉详细内容，**只发 `@codex review` 一行**重新触发（同 SHA 不需要新 commit）。

```bash
gh pr comment {PR_NUMBER} --body '@codex review'
```

> 教训演进：2026-04-18 曾以为是”后台 bug / 没接单”，2026-04-20 PR #1300 确认根因是**详细格式触发 code-write 解析**。极简格式是唯一可靠触发方式。

### Q2: PR comment 区出现小眼睛（👀）是什么意思？

**小眼睛 = 云端 reviewer 已接单/已看到请求。**

**⚠️ EYES ICON MEANS “REQUEST RECEIVED”, NOT “FAILED”.**

是否通过要看后续 review 结果，不看这条提示文案本身。
