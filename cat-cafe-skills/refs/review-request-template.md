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
> {直接粘贴铲屎官原话，≤5 行}
- 来源：`feature-discussions/{date}-{topic}/...`
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

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

### 价值 OQ（给 CVO，如有）
{需要 CVO 判断的价值取舍——必须附 Decision Packet（格式见 `refs/decision-matrix.md`）}
{如果没有价值 OQ，写"无"——回滚成本低的技术选择猫猫自决，不升级}

## Next Action
{希望 reviewer 做什么}

## Review Sandbox（必填）
- Path: `/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}`
- Start Command: `pnpm review:start`（或等价命令）
- Ports: `web={port}`, `api={port}`（禁止 3003/3004/3011/3012/4111）

## 自检证据

### Spec 合规
{quality-gate 自检报告摘要}

### 测试结果
pnpm --filter @cat-cafe/api test       # X passed, 0 failed
pnpm --filter @cat-cafe/web test       # X passed, 0 failed
pnpm -r --if-present run build         # 成功

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
