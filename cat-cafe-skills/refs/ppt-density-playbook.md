# PPT 密度填充 Playbook

> F144 Phase D 经验沉淀 — 猫猫画 HTML 前必查
> 来源：2026-04-03 spike 迭代 + 铲屎官反馈

## 核心原则

**一页 PPT 不只有一种元素。混合布局 >> 单一 grid。**

每页至少混合 **3 种以上**填充手段。底部空白 > 20% 时必须加内容。

## 密度检查清单（人工自检 + 部分自动）

> 从 relay-claw pptx-craft 对标学来，结合我们的实战经验。
> ⚠️ **自动化状态**：目前 `density-analyzer` 只自动检测空白率/overflow/elementCount。
> 其余指标为**人工自检项**，尚未接入 gate chain。

| 指标 | 门禁值 | 自动化 | 怎么测 |
|------|--------|--------|--------|
| 空白率 | < 30% | ✅ `densityGate` | `whitespaceRatio` |
| 溢出 | 0 个 | ✅ `densityGate` | `overflowCount` |
| 元素数 | — | 📊 报告字段 | `elementCount`（仅输出，不参与 gate 判定） |
| 数据可视化 | ≥ 1 图表 或 ≥ 3 数据卡片 | ❌ 人工 | 数 `<canvas>` + 数据卡片 |
| 核心要点 | 6-10 个列表项或卡片 | ❌ 人工 | 数主要信息单元 |
| 视觉图标 | ≥ 3 个 emoji/SVG | ❌ 人工 | 数图标元素 |
| 大段文字 | 无连续 > 100 字段落 | ❌ 人工 | 扫描文本节点 |
| 数据来源 | 页脚有标注 | ❌ 人工 | 检查 footer |
| 填充手段 | ≥ 3 种混合使用 | ❌ 人工 | 对照下方清单 |

**不满足 → 执行密度补充循环**（搜索真实数据 → 转换为可视化 → 重新生成）。
详见 `ppt-slide-authoring.md` "密度补充循环"。

## 填充手段清单（9 种）

### 1. KPI 数字块
大号数字 + 小号标签。放页面顶部做概括性数据。
```html
<div class="kpi"><span class="text-[30px] font-black">4</span> <span class="text-[11px]">AI 猫猫协作</span></div>
```

### 2. 产品截图 / 示意图
既是信息也是视觉填充。展示界面效果、对比、真实场景。
- 截图配文字标注（callout 箭头 + 短说明）
- 占位时用灰底 + "示意图" 文字

### 3. 表格（对比矩阵）
天然高密度。行列自动填满。特性对比、多维分析。
- 表头用品牌色背景 + 白字
- 单元格交替灰白底，增加可读性

### 4. SmartArt / 流程图 ★
**铲屎官特别认可这个手段。** 箭头连接的步骤图，把线性流程可视化。
- 端到端工作流 → 横向箭头链
- 决策树 → 分支图
- 层级关系 → 上下连线
- 用 CSS flexbox + 箭头字符(→)或 SVG 箭头实现

### 5. 总结条 / 摘要栏
一句话浓缩核心观点。放页面底部或侧边。每页都可以加。
```html
<div class="summary-bar bg-red-50 border-l-4 border-red-600 px-4 py-2">
  <span class="font-bold">关键结论：</span>...
</div>
```

### 6. 色块分区
不同背景色划分区域，减少视觉空白感。
- 淡色块（#fafafa, #fef2f2）做内容区域底色
- 深色块（品牌红）做 section header
- 白色区域留给最重要的内容（视觉焦点）

### 7. 图标 + 文字组合
比纯文字密度高。能力列表、特性清单。
- 用 emoji 或 SVG 小图标
- 图标 + 标题 + 一行描述 = 一个单元

### 8. 多级信息层次
每页至少 3-4 个字号层级：
| 层级 | 用途 | 字号（1280×720 HTML） |
|------|------|----------------------|
| L1 标题 | 页面主题 | 22-26px bold |
| L2 副标题 | 补充说明 | 12-14px |
| L3 正文 | 详细内容 | 11-12px |
| L4 辅助 | 灰色描述 | 9-10px |
| L5 脚注 | 来源/时间 | 8-9px gray |

### 9. ECharts 数据图表 ★★
**从 relay-claw 学来的杀手级手段。** 一个图表 = 几十行文字的信息密度。
- 数据/对比/趋势 → 必须用 ECharts，不用纯文字
- 柱状图、折线图、饼图、雷达图、散点图等
- 颜色用品牌色板，坐标轴文字用深色（禁止浅灰）

```html
<div class="border border-[#d4d4d4] bg-white p-2 overflow-hidden">
  <div id="chart-1" style="width:100%;min-height:200px;"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<script>
echarts.init(document.getElementById('chart-1')).setOption({
  animation: false, // 必须关闭！导出截图不等动画
  color: ['#C7020E','#FF6B6B','#FFA940','#FADB14','#52C41A','#1890FF'],
  xAxis: { type: 'category', data: ['Q1','Q2','Q3','Q4'],
    axisLabel: { color: '#252525' } },
  yAxis: { type: 'value', splitLine: { lineStyle: { color: '#d4d4d4' } },
    axisLabel: { color: '#252525' } },
  series: [{ type: 'bar', data: [120, 200, 150, 280] }]
});
</script>
```

## 间距规则

| 位置 | 值 | 不要用 |
|------|-----|--------|
| 格子间距 | 2-3px | 10px |
| Card padding | 5-8px | 12px |
| Section 间距 | 4-6px | 16px |
| 页面边距 | 12-20px | 40px |

**禁用**：`justify-between` 拉伸、`flex-1` 强制撑满 card 高度。
**推荐**：`gap-[2px]` 紧排、CSS Grid `auto` 行高、内容决定高度。

## 页面构成模板

### 架构 / 能力展示页
```
标题 + 副标题
KPI 数字条 (4-6 个) + 核心理念块
Layer Header (品牌色)
4×1 紧凑 card grid
Layer Header
4×1 紧凑 card grid
流程图 / 工作流摘要 (箭头连接)
三列价值总结
```

### 数据洞察页
```
标题 + 核心发现（大字）
左: 图表 | 右: 关键 takeaway (3-4 条)
对比表格（满幅）
底部：数据来源 + 方法论说明
```

### 方案对比页
```
标题
对比矩阵表格（满幅，交替色行）
推荐方案高亮（品牌色边框 + 标注）
底部总结条
```

## Spike 教训 (2026-04-03)

1. **v1-v2**: 单一 bullet grid + `justify-between` → 70% 空白
2. **v3**: 改 tight packing → card 内部还是空（3 items 撑不满 card）
3. **v4**: 混合布局（KPI + grid + workflow + summary）→ 密度明显提升
4. **PPTX 映射**: `PX_PER_INCH = 96`（LAYOUT_WIDE 13.33"×7.5"），不是 128
5. **Font size**: CSS px → PPTX pt 系数 = 0.75（px × 72/96）

## SmartArt/流程图 HTML 模板

> D5 垂直切片验证通过（2026-04-05）

### 横向箭头链（最常用）

适用：线性工作流、决策流程、管线步骤。

```html
<style>
.smartart-flow { display: flex; align-items: center; gap: 0; }
.smartart-step { background: #C7020E; color: #FFF; padding: 4px 8px; font-size: 8px;
  font-weight: 700; text-align: center; flex: 1; }
.smartart-step:nth-child(odd) { background: #C7020E; }
.smartart-step:nth-child(even) { background: #A50000; }
.smartart-arrow { color: #C7020E; font-size: 14px; font-weight: 700;
  flex-shrink: 0; padding: 0 1px; }
.smartart-label { font-size: 7px; color: #FFF; font-weight: 400;
  display: block; opacity: 0.9; }
</style>

<div class="smartart-flow">
  <div class="smartart-step">步骤 1<span class="smartart-label">说明</span></div>
  <div class="smartart-arrow">▶</div>
  <div class="smartart-step">步骤 2<span class="smartart-label">说明</span></div>
  <div class="smartart-arrow">▶</div>
  <div class="smartart-step">步骤 3<span class="smartart-label">说明</span></div>
</div>
```

要点：
- 交替色（`#C7020E` / `#A50000`）增加视觉区分
- `flex: 1` 让步骤等宽
- 子标签用 `<span class="smartart-label">` 加第二行说明
- 箭头用 `▶` 字符，不用 SVG（简单 + 无依赖）

## 截图 + Callout 标注 CSS 模式

### 带底部标注的截图

适用：产品界面展示、架构图、真实产出证据。

```html
<style>
.arch-screenshot { border: 1px solid #D4D4D4; position: relative; }
.arch-screenshot img { width: 100%; height: auto; display: block; }
.arch-screenshot .caption { position: absolute; bottom: 0; left: 0; right: 0;
  background: rgba(199,2,14,0.9); color: #FFF; font-size: 8px; padding: 2px 8px; }
</style>

<div class="arch-screenshot">
  <img src="path/to/image.png" alt="描述">
  <div class="caption">来源说明 — 证据标注</div>
</div>
```

要点：
- 图片路径用相对路径，方便 worktree/example 目录引用
- 红底半透明 caption 叠在图片底部，不额外占版面
- `width: 100%` 让图片自适应容器宽度
- 如需 callout 箭头标注，用 `position: absolute` + CSS 箭头

### 截图使用原则

1. **优先用真实产出**（教程素材、产品截图），不用占位图
2. **素材目录**：`docs/stories/*/tutorial/assets/`（18+ 张现成素材）
3. **一张截图 = 几十行文字的信息量** — 密度性价比最高的手段
4. **图片太大时**用 CSS `max-height` 限制，不裁剪内容

## Spike 教训更新

### D5 垂直切片教训 (2026-04-05)

6. **v5-D5**: 纯文字+表格 → 67% fill，加图片+SmartArt 后视觉冲击力明显提升
7. **图片 vs CSS 手绘**：真实截图比纯 CSS 架构图说服力强 100 倍，且制作时间短
8. **SmartArt 用 flexbox + ▶**：简单有效，不需要 SVG 依赖
9. **单一证据源约束**：页面上所有数字必须可追溯到声明的证据源（Maine Coon D1 审查 P1 教训）
10. **观看模式自洽**：7-8px 字号 = document 模式，不要声明 presentation（Maine Coon P1 教训）

### D5 HTML→PPTX 转换教训 (2026-04-12)

11. **Screenshot-first > flat extraction**：CSS 布局（flexbox/grid/overflow/absolute）无法用独立 text box 还原。截图做背景 + 关键元素（表格）原生 overlay = 视觉保真 + 局部可编辑
12. **SCREENSHOT_SCALE = 4**（`types.ts`）：1x/2x 截图在 Retina/5K 屏上模糊。4x（5120×2880）才清晰。这是产线常量，不是临时参数
13. **截图前隐藏 overlay 元素**：截图背景 + 原生 overlay 同位叠加 = 重影。截图前 `visibility:hidden` 隐藏 overlay 区域，保持占位不影响布局
14. **XML 通过 ≠ 视觉通过**：PPT 场景渲染结果是唯一裁决标准，文本拆分正确不代表视觉正确（Maine Coon D5 R2 教训）

## 待补充

- [ ] 华为真实 PPT 样本学习（铲屎官后续提供）
- [ ] 竖向流程图模板（上下布局，适合决策树）
- [ ] 多图并排 + callout 对比模式
