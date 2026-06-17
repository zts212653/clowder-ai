---
feature_ids: [F221]
related_features: [F102, F192, F200]
topics: [taste-memory, per-user-alignment, personal-operating-environment]
doc_kind: spec
created: 2026-06-03
---

# F221: Taste Lane — per-user 品味导航

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-06-03

## Architecture Ownership

Architecture cell: memory
Map delta: none（复用 F102 existing evidence lane 机制，不新建 cell）

## Why

Cat Cafe 的猫猫已经在 L0/家规/Magic Words/feedback 里积累了大量operator品味信号（"不要客服式结尾"/"先证据后漂亮话"/"共创伙伴不是工具"），但这些味道散落在不同文件里，猫在需要做品味判断时不一定能找到。

2026-06-01 的 taste 实验证明：本地猫（有 L0/feedback 空气层）比云端猫更有 You 味——**味道已在空气里，缺的是目录（能搜到）和反射（当场记新的）。**

operator experience（2026-06-03）："我们是需要建立一整套 taste 机制才对吧？"

## Current State / 现状基线

- 空气层 ✅ 已在跑：L0 摩擦检测反射 + Magic Words + 家规 + 40+ feedback 文件
- 目录层 ❌ 缺：味道散落在 feedback/家规/lessons 里，没有 taste 维度的导航入口
- 海马体层 ❌ 缺产生反射：猫没有"当场记 taste 信号"的路径

## What

### Phase A: Taste Evidence Lane + code-as-harness taste 路径

**事情 1：建 `docs/taste/` evidence lane**

```
docs/taste/
  index.md          — 搜索先验（关键词 + 维度 + vignette 链接）
  vignettes/
    no-customer-service-ending.md
    first-principles-not-scaffold.md
    partner-not-tool.md
    ...（初始种子 5-10 个）
```

- Scanner 自动索引（.md，已有能力）
- search_evidence 自动检索（BM25 + embedding，已有能力）
- F200 自动追踪消费（已有能力）
- 敏感内容进 `private/taste/`
- Outbound sync 安全：`docs/taste/` 不在 allowlist（白名单模式，已确认）

**事情 2：code-as-harness skill 加 taste 路径**

现有根因分类加一条：
```
taste 信号（"这不美"/"太客服了"/"aha"/"这就是我要的"）
  → 当场写 vignette 到 docs/taste/vignettes/
```

不是 harness 缺陷需要代码修，是品味信号需要被记住。

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal
- **Users**: 所有猫（通过 search_evidence 访问 taste lane）+ operator（品味真相源）
- **Activation signal**: 猫在做品味判断时搜到 taste vignette 并使用

### 2. Friction Metric
- taste 搜索无命中（index 内容不够 / 关键词不匹配）
- 猫搜到了但没用（vignette 质量不够 / 不相关）
- 过度触发 taste 路径（把非品味问题当品味处理）

### 3. Regression Fixture
- `search_evidence("客服式结尾")` 必须命中 taste vignette
- `search_evidence("共创伙伴")` 必须命中 taste vignette
- code-as-harness 收到 "太客服了" → 走 taste 路径不走 harness fix 路径

### 4. Sunset Signal
- 如果 F200 消费数据显示 taste vignettes 连续 3 个月零消费 → lane 可能过时
- 如果模型升级后猫不搜 taste 也能做出正确品味判断 → 说明味道已完全进入空气层

## Acceptance Criteria

### Phase A（Taste Lane + code-as-harness taste 路径）
- [x] AC-A1: `docs/taste/index.md` 存在，含 ≥5 条 taste entries（关键词 + 维度 + vignette 链接）
- [x] AC-A2: `docs/taste/vignettes/` 含 ≥5 个种子 vignettes（从最高信号 feedback 写成场景，保留原话）
- [x] AC-A3: `search_evidence("taste 客服式结尾")` 命中 index 或 vignette
- [x] AC-A4: code-as-harness SKILL.md 含 taste 路径（信号→写 vignette），区分 taste 信号 vs harness 缺陷
- [x] AC-A5: Outbound sync dry-run 不含 `docs/taste/` 内容
- [x] AC-A6: 敏感 vignette 在 `private/taste/`，非敏感在 `docs/taste/vignettes/`

## Dependencies

- F102（memory 基座）— 已有，Scanner + search_evidence
- F200（consumption tracking）— 已有
- code-as-harness skill — 已有，加 taste 路径
