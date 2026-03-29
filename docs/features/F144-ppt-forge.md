---
feature_ids: [F144]
related_features: [F138]
topics: [content-generation, presentation, skill]
doc_kind: spec
created: 2026-03-27
---

# F144: PPT Forge — AI 演示文稿生成引擎

> **Status**: in-progress | **Owner**: 三猫 | **Priority**: P2

## Why

team experience（2026-03-27）：

> "如果要让你组织猫猫们来实现一个 ppt 生成的 skills 或者说引擎！比如我和你说我想要华为/IBM/xxx/yyy 风格的 ppt，然后给你们一些主题……来吧我们也来搞一个业界 sota 的 ppt skills！"
>
> "笑他们要再欺负我，下次他们汇报说什么都是他们做的完全不提我的时候，我就说我也有个 ppt 生成的能力，现场对比啊。"

**核心动机**：
1. **能力证明**：用真正的工程系统对比对方团队的"SOTA"（纯 prompt 编排 pptx-craft），证明愿景驱动开发的产出力
2. **实用价值**：team lead给主题+风格 → 自动产出专业级 PPT，覆盖技术分享、架构设计、行业分析等场景
3. **方法论验证**：多猫协作（研究+叙事+设计+质量守护）生成内容的端到端管线

**背景**：对方团队归档的 `deepresearch`（3 个 MD 文件，零运行时代码）+ `pptx-craft`（HTML 截图转 PPTX），被三猫侦查定性为 "Promptware"——我们要做的是 "Governanceware"。

## What

### 五层架构（头脑风暴收敛版）

```
team lead输入: "华为企业流程信息化架构分析，华为风格"
  ↓
Layer 1: Research        → deep-research skill（三路 DR + Pro 审阅）
  ↓  产物: research.md（带来源引用）
  ↓  ── Research Gate ──
Layer 2: Narrative       → 结构化叙事引擎（金字塔/SCQ/问题-方案）
  ↓  产物: storyline.md（每页有"存在目的"）
  ↓  ── Narrative Gate（team lead审批叙事方向）──
Layer 3: Blueprint       → 页面蓝图生成器（layout + 元素规划）
  ↓  产物: deck.blueprint.json（每页 layout/元素/图表位/引用位）
  ↓  ── Blueprint Gate ──
Layer 4: Style           → Design Token 三层体系 + 风格模板
  ↓  产物: theme.tokens.json（品牌→语义→Slide Master）
Layer 5: Export          → pptxgenjs 原生 OOXML 生成
  ↓  产物: deck.pptx（文字可编辑、可搜索、布局无溢出）
  ↓  ── Export Gate + Vision Gate ──
```

**五份中间产物 = contract chain**（Maine Coon提出，全员共识）：
`research.md → storyline.md → deck.blueprint.json → theme.tokens.json → deck.pptx`

每份产物都是可审计、可 review、可回溯的独立 artifact。

### Phase A: 核心管线 MVP（华为风格首发）

串通五层管线，跑通一个端到端 demo。**两级挑战**：

#### Level 1（必须做到）
1. **Research Layer** — 调用 `deep-research` skill 做主题研究
2. **Narrative Layer** — 结构化叙事引擎（金字塔原理 + SCQ 两个框架）
3. **Blueprint Layer** — 页面蓝图生成（layout 选择 + 元素规划 + contract 输出）
4. **Style Layer** — 1 个企业风格模板（**huawei-like**，含 Design Token 三层体系）
5. **Export Layer** — pptxgenjs 原生 OOXML 导出 .pptx
6. **高密度页面类型**：密排状态矩阵表格（单元格颜色编码）+ 多 KPI 仪表板 + 图表混排 + 多栏对比

#### Level 2（挑战目标）
7. **DiagramElement**：嵌套盒子架构图（华为最经典 slide 类型），限 2-3 层嵌套
8. **SlideBuilder diagram renderer**：flex-like 空间计算 → pptxgenjs shapes 绝对坐标

**Phase A 关键决策**：
- 首个风格改为**华为风格（huawei-like）** — team lead要求最大信息密度挑战，华为 PPT 一页塞 50+ 盒子，比 NVIDIA keynote 难 10 倍（KD-8）
- **Pencil MCP 降级为可选审批器**，不进主路径硬依赖 — 避免被集成卡住（Maine Coon pushback，采纳）
- SlideBuilder 抽象层处理 pptxgenjs 的 x/y/w/h 绝对定位计算
- **GPT Pro 审阅吸纳 7 项**：renderBudget / slideId / sections[] / transition 枚举 / ChartData union / Render Recipes / 支持矩阵冻结（详见 GPT Pro 咨询文档 Part 3）
- **CJK 图表字体升级为 release-gate P1**（Maine Coon要求：POC 不过就收紧支持矩阵）

#### 华为 PPT 参考图分析（team lead提供，6 张）

| 类型 | 描述 | Phase A 可行性 |
|------|------|---------------|
| **嵌套盒子架构图** | 3-4 层嵌套矩形框 + 侧栏标签 + 编号（如"架构管控资产"图） | ⚠️ Level 2（新增 DiagramElement） |
| **超密技术架构图** | 50+ 盒子，6 层嵌套，三栏（开发/生产/运行环境） | ❌ Phase B（需要 4+ 层嵌套 + 更复杂空间算法） |
| **流程矩阵图** | T1-T4 层级 + 箭头连线 + 描述文字 | ❌ Phase B（需要 Connector API） |
| **密排状态矩阵表格** | 组件×软件×版本×多列颜色编码状态 | ✅ Level 1（TableElement + 单元格颜色） |
| **目录页** | 4 个红色编号条 | ✅ Level 1（现有 layout 覆盖） |
| **顶层框架图** | 分区嵌套 + 左侧标签 | ⚠️ Level 2（简化版 DiagramElement） |

#### Phase A 支持矩阵（GPT Pro 审阅后冻结）

| 平台 | 承诺 |
|------|------|
| PowerPoint 365 Win/Mac | **完全支持**：文字可编辑、图表可编辑、布局无 repair 弹窗 |
| PowerPoint 2021+ | **基本支持**：功能同上，未回归的版本差异标 ⚠️ |
| Keynote | **可打开**：文字可读，图表编辑不保证 |
| Google Slides | **可打开**：同上 |
| LibreOffice Impress | **不承诺** |

### Phase B: HTML Layout Compiler — 终态渲染引擎

> **方向纠偏（2026-03-28）**：Phase A 用 pptxgenjs 原生 shapes 手算 x/y/w/h 坐标，在复杂嵌套布局（华为级 50+ 盒子）时效果差、算法复杂。team lead指出应与 F138 Video Studio（Remotion = HTML+CSS → 视频）复用同一思路。Maine Coon确认终态路线：HTML+CSS 做布局真相源 → DOM 语义编译器 → pptxgenjs 原生对象输出（不截图、不光栅化）。

**终态架构**：
```
Blueprint JSON (语义)
    ↓
HTML Template Engine (HTML+Tailwind 生成 slide DOM)
    ↓
Playwright headless (固定 viewport/字体，确定性布局求值)
    ↓ data-ppt-role 语义标注
DOM Semantic Compiler (编译为 text/table/chart/shape/group)
    ↓
pptxgenjs 原生对象输出 (文字可编辑、图表可编辑、字体嵌入)
    ↓
deck.pptx
```

**五条硬边界**（Maine Coon定义，不可退让）：
1. `layout-engine` — Playwright 做确定性布局求值（固定 viewport 1280×720 / 字体 / 样式）
2. `semantic-compiler` — 按 `data-ppt-role` 编译为原生 pptxgenjs 对象，不做像素级截图
3. `editable-first` — 任何页面元素默认原生对象，禁止截图回退
4. `font-embed` — 字体嵌入能力并入导出链
5. `browser-backend` — 生产链只用 Playwright（可重复、可测试），其他浏览器能力用于调研/采样

**Phase B 交付项**：
1. `html-layout-compiler` 子模块 — Blueprint → HTML+CSS → DOM 坐标 → pptxgenjs 调用
2. 全量 renderer 迁移 — 现有 5 个 renderer (text/chart/table/kpi/diagram) 改为吃 compiler output
3. 字体嵌入 — 借鉴对方 dom-to-pptx 的 opentype.js + fonteditor-core 方案
4. Skill 化 — team lead一句话触发全流程
5. 企业风格模板库 — nvidia-like/IBM/Apple（HTML+Tailwind 模板，比 JSON token 表达力强 10 倍）

### Phase C: 进阶能力（可选）

1. Combo chart 双轴（pptxgenjs combo API 稳定后）
2. 演讲者备注自动生成
3. Narrative 编辑部（reference-retriever / deck-critic / redundancy-pruner）
4. 多语言支持
5. Gate patch loop（qa.report.json → 局部回修）+ Gate scorecard 评分协议

## Acceptance Criteria

### Phase A（核心管线 MVP）
- [x] AC-A1: 给定主题 + 风格，能端到端生成一份 ≥10 页的 .pptx 文件
- [x] AC-A2: Research 层产出 `research.md`，每个关键结论带来源引用，数据区分事实/推断/建议
- [x] AC-A3: Narrative 层产出 `storyline.md`，每页有明确"存在目的"
- [x] AC-A4: Blueprint 层产出 `deck.blueprint.json`，包含页数预算/layout/元素位/引用位
- [x] AC-A5: Style 层产出 `theme.tokens.json`，Design Token 三层体系（品牌→语义→Slide Master）
- [x] AC-A6: Export 层产出原生 .pptx，文字可编辑、可搜索、布局无溢出
- [x] AC-A7: 企业风格模板（**huawei-like**）可用，信息密度达到华为参考图水平 — 单页 52 boxes（≥50 门槛），`countBoxes()` 自动统计，Maine Coon复审通过
- [ ] AC-A8: 五道门禁全部嵌入管线（Research/Narrative/Blueprint/Export/Vision Gate）
- [x] AC-A9: 密排状态矩阵表格 — 单元格级颜色编码，可编辑
- [x] AC-A10: （Level 2 stretch / non-blocking）嵌套盒子架构图 — nested-box renderer，只矩形/圆角矩形/侧栏标签，最大 3 层，输入必须是树不是图，不做 connector/自动布线
- [x] AC-A11: CJK 图表字体 POC 通过（release-gate P1，不过则收紧支持矩阵）
- [ ] AC-A12: 生成的 .pptx 在 PPT 365 Win/Mac 打开无 repair 弹窗 — **BLOCKED(owner: @you, action: 用 PPT 365 打开 ~/Desktop/cat-cafe-architecture.pptx 验证无 repair)**

### Phase B（HTML Layout Compiler — 终态渲染引擎）
- [x] AC-B1: `html-layout-compiler` 子模块可用 — Blueprint → HTML+Tailwind → Playwright 布局求值 → DOM 坐标提取
- [x] AC-B2: DOM Semantic Compiler — `data-ppt-role` 标注 → pptxgenjs 原生对象（text/table/chart/shape/group），零截图
- [ ] AC-B3: 5 个 renderer（text/chart/table/kpi/diagram）全部迁移为吃 compiler output，手算坐标代码清零
- [ ] AC-B4: 字体嵌入 — opentype.js 解析 + fonteditor-core 子集化，嵌入 .pptx 的 `ppt/fonts/`
- [ ] AC-B5: 华为级复杂布局视觉验收 — 同一 Blueprint 对比 Phase A vs Phase B 渲染，Phase B 视觉品质 ≥ 对手 pptx-craft
- [ ] AC-B6: Skill 化 — team lead一句话触发全流程（research → storyline → blueprint → HTML → compile → .pptx）
- [ ] AC-B7: ≥3 种企业风格 HTML+Tailwind 模板可用（huawei-like/nvidia-like/Apple）

## Dependencies

- **Related**: F138（Video Studio — 同属内容生成管线家族，共享 HTML+CSS → 媒体输出 思路）
- **Related**: `deep-research` skill（Research 层依赖）
- **Related**: Pencil MCP（Visual Design 层依赖）
- **Phase B 新增**: Playwright（headless 布局求值引擎）、opentype.js + fonteditor-core（字体嵌入）

## Risk

| 风险 | 缓解 |
|------|------|
| Research 退化为"调研报告切 10 页"（Maine Coon警告） | Narrative Gate 强制每页有观点/目的，不是摘要 |
| 导出偷懒走光栅化（截图嵌入） | Export Gate 硬门禁：文字可编辑+可搜索+无溢出 |
| 风格模板变成"品牌模仿"而非 token 化 | Design Token 三层体系，不依赖外部品牌资产 |
| 审批点太晚导致级联浪费 | 五道门禁嵌入管线内部（Research→Narrative→Blueprint→Export→Vision） |
| 产物不能回答"数据哪来的"（Maine Coon警告） | research.md 每个结论带来源，blueprint 引用 research 行号 |
| pptxgenjs 绝对定位复杂度 | SlideBuilder 抽象层封装 x/y/w/h 计算 |
| Pencil 集成卡住 Phase A | Phase A 主路径不依赖 Pencil，降级为可选审批器 |
| CJK 图表字体 ≠ 文本框字体（GPT Pro + Maine Coon P1） | POC 验证；不过则收紧支持矩阵（降级中文图表或首发只承诺英文图表） |
| OOXML repair dialog（GPT Pro 警告） | 回归测试：生成 .pptx → PPT 365 打开 → 无 repair 弹窗 |
| 华为级信息密度超出 layout 覆盖 | Level 1/Level 2 分级：表格+KPI 先行，架构图作为挑战目标 |
| Blueprint 对页面容量失明（GPT Pro #3） | renderBudget 注入 Blueprint（Phase A 只激活 `maxWords` 预警；`minFontPt`/`overflowPolicy` 为 Phase B reserved） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | ~~四层~~ → **五层架构**（Research → Narrative → Blueprint → Style → Export） | 头脑风暴收敛：金渐层+Maine Coon一致认为 Narrative→Visual 之间缺 Blueprint 契约层 | 2026-03-27 |
| KD-2 | ~~Pencil MCP 主力~~ → **Pencil 降级为可选审批器**，Phase A 主路径不依赖 | Maine Coon pushback：Pencil 不支持 PPTX 导出，Phase A 核心胜负手是稳定产出，不能被集成卡住 | 2026-03-27 |
| KD-3 | **pptxgenjs 作为导出引擎** | 金渐层七方案对比 + 对方 pptx-craft 也用它（业界共识），原生 OOXML 可编辑可搜索 | 2026-03-27 |
| KD-4 | Phase A 首个风格选 **nvidia-like 企业风格**，不选 Cat Cafe | Maine Coon pushback：目标是"现场对比打脸"，Cat Cafe 适合 smoke test 不适合证明能力 | 2026-03-27 |
| KD-5 | **五份中间产物作为 contract chain** | Maine Coon提出：research.md → storyline.md → deck.blueprint.json → theme.tokens.json → deck.pptx，每份可审计可回溯 | 2026-03-27 |
| KD-6 | **五道门禁嵌入管线** | Maine Coon提出：Research/Narrative/Blueprint/Export/Vision Gate，审批点前置防止级联浪费 | 2026-03-27 |
| KD-7 | **叙事引擎 = 结构化模板 + prompt 增强** | 金渐层+Maine Coon共识：纯 prompt 不稳定，纯模板僵硬，混合方案最优 | 2026-03-27 |
| KD-8 | Phase A 首发风格从 nvidia-like **改为 huawei-like** | team lead要求：华为信息密度最高（一页 50+ 盒子），最能证明引擎能力；对比打脸效果最强 | 2026-03-27 |
| KD-13 | **huawei-like 字体统一 Noto Sans SC** | Maine Coon要求：高密中文场景 Latin/CJK 度量不一致会搞乱断行和容量判断。Phase A 不追品牌拟真，追稳定可读 | 2026-03-27 |
| KD-9 | **GPT Pro 审阅吸纳 7 项** | renderBudget / slideId / sections[] / transition 枚举 / ChartData union / Render Recipes / 支持矩阵冻结 | 2026-03-27 |
| KD-10 | **CJK 图表字体升级为 release-gate P1** | Maine Coon要求：首发场景是中文企业汇报，图表 CJK 翻车 = 现场打脸自己 | 2026-03-27 |
| KD-11 | **Pushback renderer-agnostic adapter** | Ragdoll+Maine Coon共识：YAGNI，但守住 contract 不泄漏 renderer 细节（ChartData + hints 折中） | 2026-03-27 |
| KD-12 | **Phase A 分 Level 1/2 两级** | Level 1 = 表格+KPI+图表（必须做到）；Level 2 = DiagramElement 架构图（挑战目标） | 2026-03-27 |

## Review Gate

- Phase A: 跨家族 Review（Maine Coon/GPT-5.4）
- Phase B: Siamese视觉审核 + Maine Coon代码 Review
