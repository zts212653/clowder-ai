# Review 请求信模板

> 单一真相源。所有猫猫请求 review 都用此模板。

## 标准格式

```markdown
# Review Request: {标题}

Review-Target-ID: {id}
Branch: {branch-name}

## What
{改了什么、核心变更}

## Why
{为什么做、约束、目标}

## Original Requirements（必填）
> {直接粘贴operator experience，≤5 行}
- 来源：`feature-discussions/{date}-{topic}/...`
- **请对照上面的摘录判断交付物是否解决了operator的问题**

## Tradeoff
{放弃了什么方案，为什么}

## Architecture Ownership（必填）
<!-- F191 reviewer 视角来自 cat-cafe-skills/request-review/SKILL.md；改 checklist 时两边保持同步。 -->
Architecture cell: {cell_id}
Map delta: none | update required | new cell required
Why: {一句话}

请 reviewer 检查：
- diff 是否与 `Map delta` 一致
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`
- 若修改 `docs/architecture/ownership/cells/*.md`，是否确实改变了 owner / boundary / extension point / canonical anchor

## Open Questions

### 技术 OQ（给 reviewer）
{需要 reviewer 特别关注的实现正确性/安全性/性能问题}

### 价值 OQ（给 operator，如有）
{需要 operator 判断的价值取舍——必须附 Decision Packet（格式见 `refs/decision-matrix.md`）}
{如果没有价值 OQ，写"无"——回滚成本低的技术选择猫猫自决，不升级}

## Fresh-Context Findings（如有）
<!-- 仅当 author 触发了 fresh-context pre-review 时填写此节。未触发时删除此节。 -->
<!-- 详见 cat-cafe-skills/fresh-context-review/SKILL.md -->

Agent: {cat signature}
SHA scanned: {short sha}
Total findings: {N} ({P1} P1, {P2} P2, {P3} P3)

| # | Finding | Author 处置 | 状态 |
|---|---------|------------|------|
| FC-1 | {摘要} | fixed (commit {sha}) | ✅ |
| FC-2 | {摘要} | dismissed: {理由} | ❌ |

**Reviewer delta tracking**: 正式 reviewer 请在你的 findings 中标注 `[FC:covered]`（fresh-context 已发现）或 `[FC:new]`（新发现）或 `[FC:N/A]`（不适用）。详见 receive-review skill "Reviewer Delta Annotation"。

## Next Action
{希望 reviewer 做什么}

## Review Sandbox（必填）
- Path: `/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}`
- Start Command: `pnpm review:start`（或等价命令）
- Ports: `web={port}`, `api={port}`（禁止 3003/3004/3011/3012/4111）

### 沙盒 Bootstrap（reviewer 在干净 sandbox 复跑 Validation 前必做）

```bash
# 1. 清掉继承的 NODE_ENV=production（否则 pnpm install 跳过 devDependencies → vitest/build 报 react resolve 失败）
unset NODE_ENV
# 等价：每条 pnpm 前缀 env -u NODE_ENV，或 NODE_ENV=development pnpm install

# 2. 干净安装依赖
pnpm install --frozen-lockfile

# 3. 如 Validation 链涉及 packages/api/test/* import dist/* → 必须先 build shared/api
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build   # 仅当 targeted API test import dist/ 时
```

事故来源：cat-cafe#1489 reviewer 复跑撞 `ERR_MODULE_NOT_FOUND`；intake clowder-ai#1010 review 撞 `react/jsx-dev-runtime` resolve fail（gpt52 在 review worktree 复跑时）。两次都不是 author 代码 bug，是 sandbox bootstrap chain 缺失。author 在 PR Validation 段落必须显式列上述前置（不是"自检通过"就够）。

## 自检证据

### Spec 合规
{quality-gate 自检报告摘要}

### 测试结果

**写入前置依赖链 + 实际跑过的命令，reviewer 在沙盒裸跑必须能复现。**

```bash
# Bootstrap（与 Review Sandbox 段落同步，sandbox 已跑则只写 author 跑的）
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build   # 如 targeted test 依赖 dist/

# Targeted vitest / node:test（最高风险 validation 链）
pnpm --filter @cat-cafe/api test       # X passed, 0 failed
pnpm --filter @cat-cafe/web test       # X passed, 0 failed
pnpm -r --if-present run build         # 成功

# Full code gate (multi-file code change 必跑，per opensource-ops Rule 12 + feedback #2347)
pnpm gate                              # ✓ pre-merge-check.sh 全套
```

### 相关文档
- Plan: `feature-specs/...`
- ADR: `docs/decisions/...`（如有）
- Feature: F__ / BACKLOG #__
```

## 存档位置

`review-notes/YYYY-MM-DD-{topic}-review-request.md`

## 注意事项

- **附原始需求摘录（≤5 行）**，否则 reviewer 不审
- **附 Architecture Ownership 三字段**，否则 reviewer 不审
- 自检报告必须附上（从 quality-gate skill 输出）
- 前端功能附截图证据
- 前端 review 需要起 dev 时，**必须附 review 沙盒 Path + Start Command + 实际端口**
