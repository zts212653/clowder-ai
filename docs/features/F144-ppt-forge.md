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

> **Spec Reconciliation（2026-04-14）**：KD-16 / KD-17 落定后，**Phase B 不再是默认产品路径**，而是保留为可复用的编译基础设施。核心页面创作走 **Phase D（AI 直接画 HTML）**，diagram/复杂结构 fallback 走 **Phase C（SVG→shapes）**。因此 B3/B5/B6 不再作为 feature 完成的阻塞项，B4/B7 保留为跨 Phase 能力项。

**五条硬边界**（Maine Coon定义，不可退让）：
1. `layout-engine` — Playwright 做确定性布局求值（固定 viewport 1280×720 / 字体 / 样式）
2. `semantic-compiler` — 按 `data-ppt-role` 编译为原生 pptxgenjs 对象，不做像素级截图
3. `editable-first` — 任何页面元素默认原生对象，禁止截图回退
4. `font-embed` — 字体嵌入能力并入导出链
5. `browser-backend` — 生产链只用 Playwright（可重复、可测试），其他浏览器能力用于调研/采样

**Phase B 保留交付项（经 2026-04-14 对账后）**：
1. `html-layout-compiler` 子模块 — Blueprint → HTML+CSS → DOM 坐标 → pptxgenjs 调用（B1/B2，已完成）
2. 字体嵌入 — 借鉴对方 dom-to-pptx 的 opentype.js + fonteditor-core 方案（B4，仍保留）
3. 企业风格模板库 — ≥3 种 HTML+Tailwind authoring kit，服务 D 路径而非 compiler-only 路径（B7，仍保留）
4. **不再单独推进**：全量 renderer 迁移 / compiler-only 视觉验收 / compiler-only skill 化，已并入 Phase D 主路径或 Phase C fallback

### Phase C: SVG 渲染后端 — 确定性 SVG 编译器

> **方向纠偏（2026-03-31）**：Phase B 的 HTML→DOM→pptxgenjs 路线在复杂中文嵌套布局（diagram 71 shapes）仍然崩溃。team lead指出应学习 pptx-craft 的 SVG 路线。核心发现：pptx-craft 不是"Promptware"，其 `svg_to_shapes.py`(70k) 是成熟的 SVG→DrawingML 原生 shapes 转换器。
>
> **选型收敛（2026-04-02）**：Ragdoll+Maine Coon讨论，team lead约束"不引入 Python，用我们自己的 TS/JS 技术栈"。最终方案：**C3 为主（确定性 SVG 编译）+ C2 为辅（AI-direct SVG 可选高创意模式）**。C1（Python）team lead否决，C4（图片降级）只做应急兜底。

#### 选型决策过程

**team lead约束**：❌ 不引入 Python | ✅ 有 Pencil MCP | ✅ 纯 TS/JS 技术栈

| 方案 | 结论 | 理由 |
|------|------|------|
| C1 吸收 Python 转换器 | ❌ 否决 | team lead约束：不引入 Python |
| **C3 确定性 SVG 编译（默认）** | ✅ **主选** | 确定性强、可测、可回归，符合 Phase B「语义编译器」方向（Maine Coon推荐） |
| C2 AI-direct SVG（可选） | ⚠️ 辅助 | 创意强但输出不稳定，进入人工验收通道（非默认） |
| C4 Diagram 图片降级 | ⚠️ 兜底 | 改动最小但不可编辑，仅应急 |

#### 终态架构

```
简单元素 (text/table/kpi/chart)
    → 现有 pptxgenjs renderer（已验证可用，不改）

复杂元素 (diagram/架构图)  [C3-Core]
    → Blueprint DiagramElement
    → TS SVG 编译器（确定性生成 1280×720 SVG string）
    → TS svg-to-shapes 转换器（SVG → pptxgenjs addShape/addText 调用）
    → pptxgenjs 组装 deck.pptx（原生可编辑）

高创意模式（可选）  [C2-Assist]
    → AI 直接生成 SVG（非确定性，需人工验收 gate）
    → 同一 svg-to-shapes 转换器
    → pptxgenjs 组装
```

**Pencil MCP 定位**：design-time 模板产出与视觉校准，不在 runtime 主路径（Maine Coon pushback：运行时依赖 Pencil 不够硬）。

#### C3-Core: TS SVG→Shapes 转换器

**核心子集**（diagram-first，不追 pptx-craft 全覆盖）：

| SVG 元素 | Phase C | 映射 |
|----------|---------|------|
| `<rect>` | ✅ | `addShape('rect', {x,y,w,h,fill,line})` |
| `<text>` | ✅ | `addText([{text,options}], {x,y,w,h})` — CJK 字宽表 |
| `<line>` | ✅ | `addShape('line', ...)` |
| `<g transform>` | ✅ | 递归坐标变换（translate/scale） |
| `<circle>` | ✅ | `addShape('ellipse', ...)` |
| `<path>` | Phase D | 复杂路径 |
| gradient/filter | Phase D | 视觉增强 |

**工程量评估**（Maine Coon校准）：
- 代码：2.5k–4k 行 TS（含 CJK 文本排版、baseline/字距/行高）
- 测试：1.5k–3k 行
- 周期：2–3 周（1 只主力猫）

#### 风险（Maine Coon补充）

| 风险 | 缓解 |
|------|------|
| 中文文本不只是换行：baseline/字距/行高/fallback 字体跨平台漂移 | CJK 字宽预设表 + 跨平台测试矩阵 |
| 字体嵌入/子集化未补齐前视觉保真反复打脸 | Phase C 与 AC-B4 字体嵌入并行推进 |
| SVG 安全（外链资源/filter/foreignObject） | 白名单机制：只允许 Phase C 核心子集 SVG 元素 |
| 高密 slide（50+ box）编译耗时与输出体积 | 性能 gate：编译时间 < 5s / 单 slide 体积 < 2MB |

#### pptx-craft 架构参考（不直接引入）

```
AI 生成 SVG (1280×720 viewBox, 逐页)
    ↓ page_N_draft.svg (640×360 低分辨率先定布局)
    ↓ page_N.svg (1280×720 精装修)
svg_to_shapes.py (70k Python) → DrawingML native shapes
svg_to_pptx.py (41k Python) → python-pptx 组装
```

**我们学方法论，不学实现**：SVG 作为布局中间层的思路正确，但用 TS 重写核心子集（不引入 Python）。

#### OfficeCLI 评估

- github.com/iOfficeAI/OfficeCLI，Apache 2.0，925 stars，.NET CLI
- **结论**: 不适合我们 Node.js 管线

#### Phase C 交付项

1. **C3-Core**: TS SVG 编译器 + svg-to-shapes 转换器（diagram-first），确定性生产链
2. **C2-Assist**: AI-direct SVG 可选通道 + 人工验收 gate
3. **AC-B4 并行**: 字体嵌入（SVG 保真的前置依赖）

### Phase D: AI 猫猫画 HTML — 学 pptx-craft 超越 pptx-craft

> **方向转变（2026-04-03）**：Phase C 的确定性 SVG 编译器解决了 CJK 渲染问题（不再竖排乱码），但布局密度仍不够华为级。team lead分析 pptx-craft 后拍板：**核心页面让猫猫直接写 HTML+CSS，不靠编译器算布局**。

#### 核心思路

pptx-craft 的关键技术：**AI (Opus) 直接生成 HTML+Tailwind (1280×720) → Playwright → dom-to-pptx → pptxgenjs**。密度高是因为 AI 懂 CSS 布局、会自动填充空间，且有两阶段设计强制密度。

我们的差异化：
1. **Research 质量**：deep-research + 多猫讨论 >> 对方 web fetch
2. **多猫审核**：Siamese视觉审 + Maine Coon准确性审
3. **Phase C SVG 编译器作为 diagram fallback**：结构化数据仍走确定性路径

#### Phase D 交付项

1. **D1-Core**: AI 猫猫直接写 HTML+Tailwind 页面布局（不走 Blueprint→编译器，猫猫拿 storyline.md + theme tokens 直接画）
2. **D2-TwoPhase**: 两阶段密度控制 — Draft(640×360, 强制高密度) → Final(1280×720, 只增强不减密)
3. **D3-DensityGate**: Playwright 渲染后自动检测白空间占比 + 溢出检测，不达标退回猫猫重画
4. **D4-Integration**: 集成进 F144 管线 — Research → Narrative → **AI 画 HTML** → Playwright → dom-to-pptx → .pptx
5. **D5-VerticalSlice**: 先做 1 页高密页验证"猫猫画 HTML → PPTX"全链路（HTML→截图→density 报告→PPTX），通过后再扩页。输入六件套（品牌/受众/页型/观看模式/页目的/证据源），输出四件套（HTML/截图/density/PPTX）

#### 华为级密度填充技巧（team lead反馈沉淀 2026-04-05）

team lead反复指出猫猫画的 HTML"空白太多"。根本问题不是空白检测不够，而是猫猫没有用足页面空间。华为真正的 PPT 会用以下手段把页面塞满：

1. **SmartArt/流程图**：把端到端工作流画成箭头连接的步骤图，占满横向空间
2. **多区块混排**：一页同时包含表格 + 文字总结 + 图表 + 截图/示意图
3. **格子间距极小**：表格/卡片的 cell padding 和 gap 压到最小（4px 级）
4. **文字密度**：关键信息用加粗/颜色区分，辅助信息用 9-10px 紧排
5. **全版面利用**：华为 PPT 几乎不留空白区域，每个角落都有内容或装饰
6. **数据可视化填充**：空余区域用迷你图表、进度条、状态指示器填充
7. **信息层级压缩**：别人用 4-5 页讲的内容，华为用 1-2 页讲清，靠的是排版密度而非内容删减
8. **结论性文字条**：页面底部用深色底条放核心结论，不浪费任何空间

#### 其他进阶能力（Phase E+）

1. SVG 全覆盖（path/gradient/filter/clipPath）
2. Combo chart 双轴（pptxgenjs combo API 稳定后）
3. 演讲者备注自动生成
4. Narrative 编辑部（reference-retriever / deck-critic / redundancy-pruner）
5. 多语言支持
6. Gate patch loop（qa.report.json → 局部回修）+ Gate scorecard 评分协议

## Acceptance Criteria

### Phase A（核心管线 MVP）
- [x] AC-A1: 给定主题 + 风格，能端到端生成一份 ≥10 页的 .pptx 文件
- [x] AC-A2: Research 层产出 `research.md`，每个关键结论带来源引用，数据区分事实/推断/建议
- [x] AC-A3: Narrative 层产出 `storyline.md`，每页有明确"存在目的"
- [x] AC-A4: Blueprint 层产出 `deck.blueprint.json`，包含页数预算/layout/元素位/引用位
- [x] AC-A5: Style 层产出 `theme.tokens.json`，Design Token 三层体系（品牌→语义→Slide Master）
- [x] AC-A6: Export 层产出原生 .pptx，文字可编辑、可搜索、布局无溢出
- [x] AC-A7: 企业风格模板（**huawei-like**）可用，信息密度达到华为参考图水平 — 单页 52 boxes（≥50 门槛），`countBoxes()` 自动统计，Maine Coon复审通过
- [ ] AC-A8: 五道门禁全部嵌入管线（Research/Narrative/Blueprint/Export 已有；**Vision Gate 仍未收进统一执行链**）
- [x] AC-A9: 密排状态矩阵表格 — 单元格级颜色编码，可编辑
- [x] AC-A10: （Level 2 stretch / non-blocking）嵌套盒子架构图 — nested-box renderer，只矩形/圆角矩形/侧栏标签，最大 3 层，输入必须是树不是图，不做 connector/自动布线
- [x] AC-A11: CJK 图表字体 POC 通过（release-gate P1，不过则收紧支持矩阵）
- [ ] AC-A12: 生成的 .pptx 在 PPT 365 Win/Mac 打开无 repair 弹窗 — **BLOCKED(owner: @you, action: 用 PPT 365 打开 ~/Desktop/cat-cafe-architecture.pptx 验证无 repair)**

### Phase B（HTML Layout Compiler — 共享编译基础设施，见 KD-19）
- [x] AC-B1: `html-layout-compiler` 子模块可用 — Blueprint → HTML+Tailwind → Playwright 布局求值 → DOM 坐标提取
- [x] AC-B2: DOM Semantic Compiler — `data-ppt-role` 标注 → pptxgenjs 原生对象（text/table/chart/shape/group），零截图
- [x] AC-B3: ~~5 个 renderer（text/chart/table/kpi/diagram）全部迁移为吃 compiler output，手算坐标代码清零~~ → **Superseded by KD-16/KD-17**：核心页面默认走 D 路径（AI 直接画 HTML），diagram 走 Phase C SVG fallback，不再追求“所有页面都经 compiler-output renderer 迁移”
- [ ] AC-B4: 字体嵌入 — opentype.js 解析 + fonteditor-core 子集化，嵌入 .pptx 的 `ppt/fonts/`
- [x] AC-B5: ~~华为级复杂布局视觉验收 — 同一 Blueprint 对比 Phase A vs Phase B 渲染，Phase B 视觉品质 ≥ 对手 pptx-craft~~ → **Superseded by AC-D6**：视觉验收对象已改为 AI 直画 HTML 的主路径页面，而不是 compiler-only 输出
- [x] AC-B6: ~~Skill 化 — team lead一句话触发全流程（research → storyline → blueprint → HTML → compile → .pptx）~~ → **Superseded by AC-D7**：一键触发现在指向 Research → Narrative → AI 画 HTML → Playwright → PPTX 的主路径
- [ ] AC-B7: ≥3 种企业风格 HTML+Tailwind 模板可用（huawei-like/nvidia-like/Apple）— **保留需求，但已从 compiler blocker 改为 D 路径 authoring kit backlog**

### Phase C（SVG 渲染后端 — 确定性 SVG 编译器）
- [x] AC-C1: TS SVG 编译器 — DiagramElement → 确定性 1280×720 SVG string（含 CJK 字宽预设表）
- [x] AC-C2: TS svg-to-shapes 转换器 — SVG(rect/text/line/circle/g) → pptxgenjs shapes，原生可编辑
- [x] AC-C3: 同一 DiagramElement 对比 V1 renderer vs Phase C SVG 编译器，中文不再竖排/溢出
- [x] AC-C4: SVG 安全白名单 — 只允许 Phase C 核心子集元素，拒绝外链/filter/foreignObject
- [x] AC-C5: 性能 gate — 50+ box diagram 编译 < 5s，单 slide 体积 < 2MB
- [x] AC-C6: （可选）C2-Assist 通道 — AI-direct SVG + 人工验收 gate 可用

### Phase D（AI 猫猫画 HTML — 学 pptx-craft 超越 pptx-craft）
- [x] AC-D1: AI 猫猫直接写 HTML+Tailwind 页面（拿 storyline.md + theme tokens 画布局，不走确定性编译器）
- [x] AC-D2: 两阶段密度控制 — Draft(640×360) 强制高密度 → Final(1280×720) 只增强不减密
- [x] AC-D3: Playwright 白空间检测 — 渲染后自动检测白空间占比 < 30%，溢出检测，不达标退回
- [x] AC-D4: 同一主题对比 pptx-craft vs Phase D 输出，信息密度 ≥ 对方，内容准确性 > 对方（research 质量差异）
- [x] AC-D5: 垂直切片验证 — 1 页高密页走完 HTML→截图→density 报告→PPTX 全链路。输入六件套（品牌/受众/页型/观看模式/页目的/证据源），输出四件套（HTML/截图/density/PPTX）。Maine Coon D1 结构审 + Siamese D2 美学审
- [ ] AC-D6: 华为级视觉验收 — team lead确认"一两页讲清楚重点"，信息密度达华为参考图水平，运用密度填充技巧（SmartArt/多区块混排/极小间距/全版面利用）
- [ ] AC-D7: 集成进管线 — Research → Narrative → AI 画 HTML → Playwright → dom-to-pptx → .pptx，team lead一句话触发

## Phase B Reconciliation（2026-04-14）

| AC | 结论 | 说明 |
|----|------|------|
| AC-B1 | ✅ 已完成 | 仍是 D 路径 / C 路径共用基础设施 |
| AC-B2 | ✅ 已完成 | 仍是 D 路径 / C 路径共用基础设施 |
| AC-B3 | ✅ 关闭（Superseded） | 被 KD-16/KD-17 改写：不再要求“所有页面都经 compiler-output renderer 迁移” |
| AC-B4 | ⏳ 保留 | 字体嵌入仍是跨平台保真能力，继续保留为真实剩余项 |
| AC-B5 | ✅ 关闭（Superseded） | 视觉验收职责迁移到 AC-D6（AI 直画 HTML 主路径） |
| AC-B6 | ✅ 关闭（Superseded） | 一句话触发职责迁移到 AC-D7（端到端主路径集成） |
| AC-B7 | ⏳ 保留（重定义） | 仍需要 ≥3 套企业风格模板，但现在是 D 路径 authoring kit，不是 compiler-only blocker |

## Unified Remaining Checklist（2026-04-14）

| 类别 | 剩余项 | 对应 AC | 状态 | 说明 |
|------|--------|---------|------|------|
| 主路径 | 垂直切片签收 | AC-D5 | ✅ 已交付 | `htmlToSlide` 编排器 + 4 e2e tests (PR #1172)，Maine Coon 2 轮 review + 云端 2 轮 clean |
| 主路径 | 华为级视觉验收 | AC-D6 | 待做 | 这是当前默认产品路径的真正验收门 |
| 主路径 | 一句话触发全流程 | AC-D7 | 待做 | 这条承接了旧 AC-B6 的“一键触发”诉求 |
| 共享能力 | 字体嵌入 | AC-B4 | 待做 | 同时服务 D 路径导出保真与 C 路径 SVG 文字保真 |
| 共享能力 | 企业风格 authoring kit ≥3 | AC-B7 | 待做 | 保留需求，但执行口径改为 D 路径 HTML+Tailwind 模板库 |
| 共享能力 | Vision Gate 并入统一 gate chain | AC-A8 | 待做 | Research/Narrative/Blueprint/Export 已有，Vision Gate 仍未收进统一执行链 |
| 外部阻塞 | PPT 365 repair 验证 | AC-A12 | BLOCKED on @you | 需要用真实 PPT 365 Win/Mac 打开产物验收 |

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
| CJK 文本排版跨平台漂移（Maine Coon Phase C 补充） | baseline/字距/行高/fallback 字体差异 → CJK 字宽预设表 + 跨平台测试矩阵 |
| SVG 安全边界（Phase C） | 外链资源/filter/foreignObject 可被注入 → 白名单机制，只允许核心子集元素 |
| 高密 slide 编译性能（Phase C） | 50+ box diagram 编译耗时 / 输出体积膨胀 → 性能 gate（< 5s / < 2MB） |

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
| KD-14 | **Phase C 选型：C3 确定性 SVG 编译为主，C2 AI-direct SVG 为辅** | Ragdoll+Maine Coon共识：C3 确定性强/可测/可回归；C2 创意强但不稳定，进人工验收通道。C1 team lead否决（不引入 Python），C4 仅应急兜底 | 2026-04-02 |
| KD-15 | **Pencil MCP 定位为 design-time，不进 runtime 主路径** | Maine Coon pushback：Pencil 主打 .pen 编辑/导出，自动化 Blueprint→稳定 SVG 链路不够硬。适合模板设计与视觉校准 | 2026-04-02 |
| KD-16 | **Phase D 方向转变：AI 猫猫直接画 HTML，不靠确定性编译器排版** | team lead拍板：确定性编译器/规则自动生成布局效果不够好，密度不够华为级。学习 pptx-craft 的 "AI 直接写 HTML+CSS" 路线——让猫猫（Opus）直接画布局，而不是用算法算。Phase C SVG 编译器保留为 diagram fallback。核心差异化：我们的 research pipeline（deep-research + 多猫讨论）内容质量碾压对方 web fetch，配合 AI 画 HTML 实现"高质量内容 × 高密度布局" | 2026-04-03 |
| KD-17 | **默认主路径：AI 猫猫画 HTML 是唯一创作路径** | 编译器（Phase B/C）不替猫猫做版式决策。猫猫拿 storyline + theme tokens 直接画 1280×720 HTML+CSS。编译器降级为基础设施：只负责 HTML→可编辑 PPTX 的转换 + 密度/溢出门禁检测。chart/table/KPI 保留语义 emitter（原生可编辑对象），但版式由猫猫在 HTML 中决定。猫猫画的 D4 华为高密战略页密度远超编译器自动布局，team lead直接确认。Ragdoll+Maine Coon共识 | 2026-04-05 |
| KD-18 | **D4 对比口径：密度结论有效，baseline 是模拟非实测** | AC-D4 的 4.1% vs 43.9% 白空间对比有效证明方向正确，但 pptx-craft baseline 是竞品报告模拟生成、非实际 pptx-craft 跑出来的。后续需对方实际输出作为对拍基准集。不影响 Phase D 默认路径决策 | 2026-04-05 |
| KD-19 | **Phase B 角色重定义：从“终态主路径”降级为“共享编译基础设施”** | KD-16/KD-17 落定后，Phase B 不再拥有核心页面创作权。B1/B2 保留为基础设施，B3/B5/B6 关闭为 superseded，B4/B7 保留为跨 Phase 能力 backlog。以后判断 F144 剩余工作，以 D5/D6/D7 + B4/B7 + A8/A12 为准 | 2026-04-14 |

## Review Gate

- Phase A: 跨家族 Review（Maine Coon/GPT-5.4）
- Phase B: Siamese视觉审核 + Maine Coon代码 Review
