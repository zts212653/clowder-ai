# Requirements Checklist Template (B3)

> 用途：在 kickoff/spec 阶段把需求点结构化，避免 AC 漏项。

## 使用时机

- `feat-lifecycle` kickoff 创建 feature spec 时
- `quality-gate` 自检前补齐验收口径时

## 模板

```markdown
## 需求点 Checklist

| ID | 需求点（铲屎官原话/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “...” | AC-1 | test / screenshot / manual | [ ] |
| R2 | “...” | AC-2 | test / screenshot / manual | [ ] |
| R3 | “...” | AC-3 | test / screenshot / manual | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）
```

## 填写规则

1. “需求点”优先用铲屎官原话，必要时可补一句工程化转述。
2. “验证方式”必须可执行：测试名/截图/录屏/人工步骤至少一种。
3. 状态栏在 kickoff 时默认 `[ ]`，完成后在 quality-gate 阶段改为 `[x]`。
