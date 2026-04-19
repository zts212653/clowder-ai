# PPT Slide Authoring — HTML 制作规范

> ppt-forge 场景 C 的执行细节。
> 触发：大纲确认 + 风格确认后，开始画 slide。

## 核心原则

**画 HTML 是创作，不是填表。每页 slide 是一个独立的信息设计作品。**

- 目标：让受众看完这页后产生你预设的认知变化
- 手段：混合布局、真实素材、多层级信息架构
- 约束：archetype + viewing mode 决定一切排版参数

## 开工前确认（从主 skill 继承）

画之前必须已经有：

| 参数 | 来源 | 示例 |
|------|------|------|
| archetype | 铲屎官/内容规划 | 架构总览 / 数据洞察 / 方案对比 |
| viewing mode | 铲屎官确认 | presentation（大屏）/ document（阅读） |
| 品牌 | 主 skill 开局 | 华为 / Apple / 阿里 |
| 本页目的 | 一句话 | "证明对等判断优于中央编排" |
| 证据源 | 明确列出 | `03-architecture.md` + git log |

**没有这 5 项 = 不许动手画。**

## 制作流程

```
1. 读证据源，提取核心数据和论点
2. 选 archetype 模板（见 ppt-density-playbook.md 页面构成模板）
3. 素材搜索：该页需要的背景图/配图/数据（数据图表用 ECharts 生成）
4. 画 HTML（1280×720 fixed viewport，遵循弹性布局约束）
5. 跑 Pre-flight Checklist（见下方）
6. 密度不合格 → 执行密度补充循环（见下方）
7. 截图自检（必须自己看一遍渲染结果）
8. 通过 → 交活；不通过 → 改到通过
```

## CSS 合约（必读）

画 HTML 前必须读 [ppt-css-whitelist.md](../refs/ppt-css-whitelist.md)。

核心要点：
- **表格**是目前唯一原生可编辑的元素，优先用 `<table>` 展示对比数据
- **ECharts** 图表用 `<canvas>` 渲染，截图保真，是数据可视化首选
- **Grid 可以用**（screenshot-first 兜底），不需要像 relay-claw 那样全用 Flexbox
- **禁止** `overflow-auto`、CSS 动画、`blur-*`

## 弹性布局约束（强制）

每页必须使用以下结构，从代码层面预防溢出/空白/遮挡：

```html
<div class="slide flex flex-col" style="width:1280px;height:720px;overflow:hidden;">
  <!-- 页头：固定高度，禁止压缩 -->
  <header class="flex-shrink-0" style="height:60px;">
    <h1>页面标题</h1>
  </header>

  <!-- 内容区：弹性填充，至少 2 个直接子元素 -->
  <main class="flex-1 min-h-0 overflow-hidden flex flex-col gap-2">
    <div class="flex-1 min-h-0">内容区 1</div>
    <div class="flex-1 min-h-0">内容区 2</div>
  </main>

  <!-- 页脚：固定高度 -->
  <footer class="flex-shrink-0" style="height:24px;">
    <span>页脚 / 数据来源</span>
  </footer>
</div>
```

**四条强制规则**：

| 规则 | 目的 | 代码要求 |
|------|------|---------|
| 总容器锁死 | 防溢出 | `height:720px; overflow:hidden` |
| 页头/页脚固定 | 防压缩变形 | `flex-shrink-0` + 固定高度 |
| 内容区弹性 | 防空白+防溢出 | `flex-1 min-h-0 overflow-hidden` 三者缺一不可 |
| main ≥ 2 个子元素 | 防"顶天立地"单块 | 禁止 main 只有一个 div 子元素 |

## Pre-flight Checklist ★

**画完每页 HTML 后，交活前必须逐条自检。不满足 = 不许交活。**

### 密度检查（自动 + 人工）

> ✅ = density-analyzer 自动检测 | 👁️ = 人工自检

- [ ] ✅ **空白率** < 30%？（density-analyzer `whitespaceRatio`）
- [ ] ✅ **0 overflow**？（density-analyzer `overflowCount`）
- [ ] 👁️ 用了 **≥ 3 种**填充手段？（KPI/截图/表格/SmartArt/总结条/色块/图标/图表/多级字号）
- [ ] 👁️ **数据可视化**：至少 1 个 ECharts 图表 或 3 个数据卡片？
- [ ] 👁️ **核心要点**：6-10 个列表项或卡片？
- [ ] 👁️ **图标**：至少 3 个视觉图标/emoji？
- [ ] 👁️ **数据来源**：页脚有标注？
- [ ] 👁️ 无连续 > 100 字的大段文字？
- [ ] 👁️ 有**真实截图或图片**？（纯文字页 = 必须说明理由）
- [ ] 👁️ 有 **SmartArt/流程图**？（纯表格+文字 = 必须说明理由）

### 自洽检查

- [ ] viewing mode 和字号体系匹配？
  - presentation: 正文 ≥ 14px，标题 ≥ 22px
  - document: 正文 8-12px，标题 16-20px（华为密度页）
- [ ] archetype 没漂移？（开工时说"架构总览"，交活时还是"架构总览"）
- [ ] 所有数字可追溯到声明的证据源？（不可追溯 = 扩展源列表或改定性表达）

### 愿景检查

- [ ] **这页让受众看完会觉得 ___？**（写出来，如果写不出 = 目的不清）
- [ ] 和上一版对比，信息密度和说服力没有下降？（如果改过 = 必须对拍）

### 技术检查

- [ ] 0 overflow？（`el.scrollHeight > el.clientHeight + 2` 全 slide 扫描）
- [ ] 图片路径在 HTTP server 环境下能正常加载？
- [ ] 渲染截图已保存？（feedback: 自检必须截图看一遍再交活）

## 密度补充循环（密度不合格时执行）

当 Pre-flight Checklist 密度项不满足时，执行以下循环（最多 3 轮）：

### 第 1 步：分析缺失项
识别哪些门禁项未通过，明确需要补充的内容类型。

### 第 2 步：针对性搜索补充

| 缺失项 | 搜索策略 | 预期产出 |
|--------|---------|---------|
| 缺数据可视化 | 搜索主题相关数据（市场规模/增长率/占比） | 生成 ECharts 图表 |
| 缺核心要点 | 搜索主题关键发现/趋势/挑战 | 6-10 条独立要点 |
| 缺图标 | 根据内容关键词匹配 emoji/SVG 图标 | 每个卡片/要点配图标 |
| 缺案例 | 搜索行业案例/实践 | 案例卡片（公司+数据+效果） |
| 缺数据来源 | 搜索权威报告 | 页脚来源标注 |

### 第 3 步：内容转换

| 获取内容 | 转换方式 |
|---------|---------|
| 时间序列数据（≥3 点） | 折线图或柱状图 (ECharts) |
| 类别占比（总和 100%） | 饼图/环形图 (ECharts) |
| 对比数据（2-3 类别） | 条形图 (ECharts) 或对比卡片 |
| 多维评估 | 雷达图 (ECharts) |
| 关键观点 | 带图标的列表项 |
| 真实案例 | 案例卡片（品牌色块 + 数据） |

### 第 4 步：重新生成该页并再次检查

3 轮后仍不合格 → 保留当前 HTML 并标注缺失项，报告铲屎官。

## 素材使用

### 图片/截图

- **优先用真实产出**（教程素材 `docs/stories/*/tutorial/assets/`、产品截图）
- 一张截图 = 几十行文字的信息量，是密度性价比最高的手段
- 图片太大时用 `max-height` 限制，不裁剪内容
- 图片路径注意 HTTP server 根目录（不要用跳出 server root 的相对路径）
- CSS 模板见 `ppt-density-playbook.md` "截图 + Callout 标注 CSS 模式"

### ECharts 数据图表 ★

**数据可视化是信息密度的杀手级手段。** 一个图表顶 20 行文字。

- 数据/对比/趋势 → 优先用 ECharts 绘制图表，避免纯文字描述数据
- 引入方式：`<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>`
- 图表容器：`overflow-hidden` + `min-height` 防止溢出

**⚠️ 导出注意事项**：
- 当前导出脚本 (`html-slide-to-pptx.ts`) 只做 `waitUntil: 'load'`，ECharts 动画可能还没渲染完就截图
- **必须**在 ECharts init 时关闭动画：`chart.setOption({ animation: false, ... })`
- CDN 依赖意味着离线环境无法导出。后续需要 vendor 到本地（TODO）
- ECharts `<canvas>` 走截图保真路径，不可编辑
- 颜色规范（华为风格）：
  - 坐标轴/图例文字：`#252525` 或 `#000`（**禁止浅灰**）
  - 数据标签：`#252525` 或 `#C7020E`
  - 网格线：`#d4d4d4`
  - 系列色板：`['#C7020E','#FF6B6B','#FFA940','#FADB14','#52C41A','#1890FF','#722ED1']`

图表类型选择：

| 数据类型 | 推荐图表 |
|---------|---------|
| 时间序列趋势 | 折线图 |
| 多类别对比 | 柱状图 |
| 占比分布 | 饼图/环形图 |
| 多维能力评估 | 雷达图 |
| 两变量关系 | 散点图 |
| 排名对比 | 水平条形图 |

### SmartArt/流程图

- 用 CSS flexbox + `▶` 字符实现横向箭头链
- 交替色增加视觉区分
- CSS 模板见 `ppt-density-playbook.md` "SmartArt/流程图 HTML 模板"

## 愿景优先原则（Review 应对）

收到 reviewer 的修改建议时：

1. 正常走 VERIFY 三道门（Spec Gate / Mechanism Gate / Feature Gate）
2. **额外加一道愿景门**：改完后，这页的核心价值（信息密度、说服力、视觉冲击力）还在吗？
3. 如果改完会降低核心价值 → **push back**，提出替代方案（如：扩展证据源 而非 删数据）
4. **独立思考 > 迎合 review** — 我们架构的核心就是每只猫独立判断

> 教训：D5 中Maine Coon说"0 生产事故不在单一证据源" → Ragdoll直接删了有冲击力的 KPI。
> 正确做法：push back 扩展证据源列表，保留有价值的数据。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 没确认 5 项参数就动手 | 画完发现方向不对 | 开工前强制确认 |
| 只用文字+表格 | 密度低、视觉单调 | 至少 3 种填充手段 |
| 纯 CSS 画架构图 | 制作慢、效果差 | 优先用真实截图 |
| 图片路径跳出 server root | 图片加载失败 | 复制到 examples/ 或用绝对 URL |
| 改了不对拍 | 信息腰斩无人察觉 | 改后必须和上一版并排对比 |
| 为迎合 review 删有价值数据 | PPT 说服力下降 | push back + 替代方案 |
