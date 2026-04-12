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
- 来源：*(internal reference removed)*
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff
{放弃了什么方案，为什么}

## Open Questions
{需要 reviewer 特别关注的点}

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
- Plan: *(internal reference removed)*
- ADR: `docs/decisions/...`（如有）
- Feature: F__ / BACKLOG #__
```

## 存档位置

*(internal reference removed)*

## 注意事项

- **附原始需求摘录（≤5 行）**，否则 reviewer 不审
- 自检报告必须附上（从 quality-gate skill 输出）
- 前端功能附截图证据
- 前端 review 需要起 dev 时，**必须附 review 沙盒 Path + Start Command + 实际端口**
