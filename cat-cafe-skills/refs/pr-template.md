# PR 模板 + 云端 Review 触发模板

> 单一真相源。所有猫猫开 PR 和触发云端 review 都用这些模板。
> 修改本文件 = 三猫行为同步，不再有格式不一致问题。

## PR Body 模板

```
## What

{改了哪些文件、核心改动}

## Why

{为什么做这个改动、约束和目标}

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

PR 创建后，**立刻发一条 comment**（不是在 PR body 里写）：

> 安全建议：优先使用 `--body-file` 或单引号 heredoc，避免 shell 把反引号内容当命令执行。

```bash
# 先拿当前 PR 的 head commit（短 SHA）
HEAD_SHA="$(gh pr view {PR_NUMBER} --json headRefOid --jq '.headRefOid')" || \
  { echo "❌ 无法读取 PR head sha"; exit 1; }
SHORT_SHA="${HEAD_SHA:0:8}"

# 去重防呆：同一 commit 只触发一次；新 commit 允许再次触发
TRIGGER_URL="$(gh pr view {PR_NUMBER} --json comments | jq -r --arg sha "$SHORT_SHA" '
  .comments[]
  | select(.body | test("(?m)^@codex\\s+review\\b"))
  | select(.body | contains("Please review latest commit \($sha) for P1/P2 only."))
  | .url
' | head -n 1)"
[ -n "$TRIGGER_URL" ] && \
  { echo "❌ commit ${SHORT_SHA} 已触发过 review: ${TRIGGER_URL}"; exit 1; }
```

触发后执行策略（必须遵守）：

1. 进入**等待通知**模式，优先等 Cat Café 的 `GitHub Review 通知`
2. 不要高频轮询，不要“看起来没回就再发一次”
3. 10 分钟无通知，只允许一次人工检查：

```bash
gh pr view {PR_NUMBER} --json comments,reviews
```

4. 只有两种情况可再次触发：
- HEAD SHA 变化（新 commit）
- 首次触发失败被明确证实（例如 comment 未发出/被删除）

```
@codex review

Please review latest commit {SHORT_SHA} for P1/P2 only.

规则：任何 P1/P2 必须给"可执行复现"：
- 优先：新增/更新一个 failing test（最小复现）
- 否则：给确定性复现步骤（命令 + 输入 + 预期/实际）
没有证据的一律降级为 P3 建议，不算缺陷。

审查标准（详见 AGENTS.md "Review guidelines" section）：
- P0 数据丢失/安全漏洞 | P1 逻辑错误/测试缺失/架构违规
- P2 性能/重复/命名 | P3 风格偏好
- 禁止 `any`、文件 200 行警告/350 硬上限、新功能必须有测试
```

**注意**：
- `@codex review` 必须写在 PR **comment** 中，不能写在 PR body 里
- 写在 body 里会错误触发 Codex 获取代码修改权限，而非 review 权限
- 同一 commit 不要重复触发；有新 commit（新 SHA）再触发下一轮
- 触发后等待通知；未收到通知前禁止二次触发同一 SHA
- **PR body（含 HTML 注释）禁止出现任何 `@句柄`（例如 `(@codex)`）**
- 铲屎官教训：2026-02-28 某 PR 在 body 里写 `@codex review`，导致 Codex 回复"需要权限"而非执行 review
- 新增反面案例：2026-03-02 PR #160 在 body 签名写 `(@codex)`，触发环境提示评论，污染 review 流程

## 常见 QA（必须读）

### Q1: 看到 "Create an environment for this repo"，是不是 review 权限缺失？

**不是。**

**⚠️ THIS IS NOT A REVIEW-PERMISSION ERROR. THIS MESSAGE IS ABOUT CODE-WRITE ENVIRONMENT PERMISSION.**

通常原因是触发方式错了（句柄错/位置错），不是 reviewer 无法审查。

### Q2: PR comment 区出现小眼睛（👀）是什么意思？

**小眼睛 = 云端 reviewer 已接单/已看到请求。**

**⚠️ EYES ICON MEANS "REQUEST RECEIVED", NOT "FAILED".**

是否通过要看后续 review 结果，不看这条提示文案本身。
