# 主人翁五问 Gate — Maintainer Ownership Gate

> 返回 → [opensource-ops SKILL.md](../opensource-ops/SKILL.md)
>
> **铲屎官原话**："这是我们自己的家，我们需要有主人翁精神。多问自己：这东西和我们愿景冲突吗？和我们已经有的 feat 冲突吗？是我们需要的吗？技术栈优雅吗？引入的负债是什么呢？"

## 设计原则

**Fail-closed（默认不通过）**：每问必须写"结论 + 证据"，无证据记 `unknown`。`unknown` 不能进 `WELCOME`。

**拒绝"方案"，不否定"问题"**：decline 一个 Rust/Tauri PR ≠ 否定"桌面入口"这个问题。问题本身仍应挂到正确的 design anchor 下。

## 五问判定卡

对每一个新 Issue / PR，逐问填写 `结论 / 证据`。

### Q1: 愿景冲突吗？（硬门）

| 通过 | 不通过 |
|------|--------|
| 和"AI agent 协作的家"方向一致 | 把项目带向非目标产品线 |
| 帮助铲屎官摆脱人肉路由 | 让人重新做人肉路由器 |
| 符合 Cats & U 温度 | 去掉猫猫人格、冷冰冰的工具化 |

**证据来源**：对照 `docs/VISION.md` 核心定位。

**硬拒绝**：Q1 fail → `POLITELY-DECLINE`，无例外。

### Q2: 和已有 Feature/决策冲突吗？（硬门）

| 通过 | 不通过 |
|------|--------|
| 全新独立需求，不重叠 | 与现有 Fxxx 重复 |
| 可挂为已有 Feature 子任务 | 方向相反（同一问题不同方案） |
| 和已有 design memo/ADR 一致 | 抢已有 Feature 的定义权 |

**证据来源**：搜 `docs/ROADMAP.md` + `docs/features/*.md` + `docs/decisions/` + *(internal reference removed)*。

**注意**：Q2 的搜索 = Scene A 的关联检测，不需要另开一套。

**硬拒绝**：Q2 冲突且无法调和 → `POLITELY-DECLINE`。冲突可能调和 → `NEEDS-DISCUSSION`。

### Q3: 是我们需要的吗？（软门）

| 通过 | 不通过 |
|------|--------|
| 命中 maintainer 已知痛点 | 纯一次性个人偏好 |
| 在 roadmap / BACKLOG 上 | 和项目无关的功能 |
| 有重复需求信号（多人要过） | "提的人需要"但 maintainer 不需要 |

**判断标准**：不能按"提的人需要"算。要看是否命中 maintainer 痛点、已有 roadmap、或有重复需求信号。三者都没有 = 默认不是我们现在要接的。

### Q4: 技术栈优雅吗？（软门）

| 通过 | 不通过 |
|------|--------|
| fit 现有构建链 | 引入新语言（如 Rust） |
| 不增加运行时依赖 | 引入新运行时（如 Tauri） |
| 我们会长期维护 | 新打包链且非刚需 |
| 边界清晰、可隔离 | 污染主构建链、打碎模块边界 |

**判断标准**：不看"能不能做"，看"fit 不 fit"。

### Q5: 引入什么负债？（软门）

必须显式列出：

- [ ] build / release 影响
- [ ] 测试矩阵扩展
- [ ] 支持成本（issue 响应、文档）
- [ ] 安全面扩大
- [ ] 双仓 sync 复杂度
- [ ] 文档 / 教育成本
- [ ] 维护 owner 是谁

| 通过 | 不通过 |
|------|--------|
| 负债可控、有 owner | 无 owner 或高维护 |
| 测试覆盖充分 | 大面积无测试 |
| 回滚路径明确 | 紧耦合不稳定 API |

**"债务未知"按高风险处理。**

## 三档 Verdict + Reason Code

### 判定规则

| Verdict | 触发条件 |
|---------|---------|
| **WELCOME** | 五问全 pass（每问有证据）且负债低且有 owner |
| **NEEDS-DISCUSSION** | 无硬拒绝，但 ≥2 项不通过或有 `unknown` |
| **POLITELY-DECLINE** | Q1 或 Q2 硬拒绝线触发 |

### Reason Code（DECLINE / NEEDS-DISCUSSION 时必填）

| Code | 含义 |
|------|------|
| `DUPLICATE` | 和已有 Feature/Issue 重复 |
| `OUT_OF_SCOPE` | 超出项目愿景范围 |
| `WRONG_LAYER` | 问题对但方案层级错误（如用 PR 解决需要 design discussion 的问题） |
| `NOT_NOW` | 方向对但当前优先级/资源不支持 |
| `STACK_MISFIT` | 技术栈不 fit 现有体系 |
| `DEBT_TOO_HIGH` | 引入的维护负债超出可承受范围 |

## 决策漏斗（谁决定）

### 猫猫可自主 DECLINE

- 明确越界愿景（非目标产品线）
- 明确安全反模式 / 供应链风险
- 历史已拒绝且无新证据（重复单）
- 已有 design memo / ADR 明确否掉的方向
- 新增 runtime / 语言 / 打包链但没有 design anchor
- 高负债且无人认领维护

**关键判断**：有没有**现成方向锚点**。有锚点覆盖 → 猫猫可自主决定。

### 必须升级铲屎官（`needs-maintainer-decision`）

- 可能是新的 roadmap 入口（现有真相源没给出方向）
- 会改变产品承诺 / 支持矩阵
- 改动跨多个 active feature 边界
- API / 数据模型 / 兼容性破坏
- 社区价值高但方向有争议
- 涉及高价值 contributor 关系 / 社区口径敏感

**48h SLA**：`NEEDS-DISCUSSION` 状态不得超过 48h，超时 → 自动升级铲屎官。

## 话术模板

### Issue POLITELY-DECLINE

```markdown
感谢你把这个问题/想法提出来。我们理解你想解决的是：{problem}。

以 maintainer 视角看，这次我们不会沿 {solution} 这条路接纳，原因是：{reason_code 对应的具体说明}。

如果后续要继续推进，更对齐的入口是：{已有 issue / feature / design discussion / 更小的切片}。
感谢你帮我们把这个边界看清了。

— {猫猫签名}
```

### PR POLITELY-DECLINE

```markdown
感谢这份 PR，工作量我们看到了。

这次不合入 main，主要不是代码质量问题，而是方向本身和 {已有 memo/feature} 不一致，且会引入 {具体负债}。我们会先按 maintainer 已确认的路线推进。

如果你愿意继续参与，欢迎先把讨论收敛到 {issue/design anchor}，或把改动缩到 {可接受的窄切片}。

— {猫猫签名}
```

### DECLINE 时必须做

1. 填写 reason_code
2. **附 1 个可行缩小版建议**（如果存在）
3. 如果问题本身有价值，确保它挂在正确的 design anchor 下（不因 decline 方案而丢失问题）
