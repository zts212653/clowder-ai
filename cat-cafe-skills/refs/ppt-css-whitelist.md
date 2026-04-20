# PPT CSS 白名单 — HTML→PPTX 转换合约

> F144 Phase D 经验沉淀 + relay-claw pptx-craft 对标学习
> designer 写 HTML 前必查。不在白名单内的 CSS = 截图降级，不可编辑。

## 核心原则

**这份文档是 designer 和 converter 之间的合约。**
白名单内的 CSS → 转为原生 PPTX 元素（可编辑）。
白名单外的 CSS → 截图降级（只能看不能改）。

当前策略：screenshot-first（截图背景 + 选择性原生 overlay）。
随着 converter 能力提升，白名单会逐步扩大。

---

## 1. 颜色（完整支持）

| CSS 属性 | 支持值 | PPTX 映射 | 注意 |
|----------|--------|-----------|------|
| `color` | `#hex`, `rgb()`, `rgba()`, 命名颜色 | 文本 `color` | oklch/hsl 需降级 |
| `background-color` | 同上 | 形状 `fill` | alpha → PPTX transparency |

## 2. 文本样式（完整支持）

| CSS 属性 | 支持值 | PPTX 映射 | 注意 |
|----------|--------|-----------|------|
| `font-size` | px 值 | `px × 0.75` → pt | 系数 72/96 |
| `font-weight` | 100-900 | ≥600 → `bold: true` | 仅 bold/normal 二态 |
| `font-family` | 任意字体栈 | 取第一个字体名 | 后备字体被忽略 |
| `font-style` | `normal`, `italic` | `italic` | 不支持 `oblique` |
| `text-decoration` | `none`, `underline` | `underline` | 不支持 `line-through` |
| `text-align` | `left/center/right/justify` | `align` | |

## 3. 盒模型（部分支持）

| CSS 属性 | 支持值 | PPTX 映射 | 注意 |
|----------|--------|-----------|------|
| `width/height` | 通过 `getBoundingClientRect()` | `x, y, w, h` (英寸) | 用 DOM 实际值 |
| `padding` | px 值 | `margin` (pt) | 系数 ~0.85 |
| `border-width` | px 值 | `line.width` (pt) | 系数 ~0.65 |
| `border-style` | `solid/dashed/dotted` | `dashType` | 不支持 double/groove/ridge |
| `border-color` | `#hex`, `rgb()` | `line.color` | |
| `border-radius` | px, % | `roundRect` / SVG 回退 | 非均匀四角 → 截图降级 |

## 4. 布局（有限支持）

| CSS 属性 | 支持值 | PPTX 映射 | 注意 |
|----------|--------|-----------|------|
| `display: flex` | `flex`, `inline-flex` | 对齐映射 | |
| `flex-direction` | `row`, `column` | 决定对齐轴 | |
| `justify-content` | `center/flex-start/flex-end/space-between` | `align` 或 `valign` | |
| `align-items` | `center/flex-start/flex-end` | `valign` 或 `align` | 不支持 `stretch` |
| `overflow: hidden` | — | 裁剪检测 | |

## 5. 视觉效果（部分支持）

| CSS 属性 | 支持值 | PPTX 映射 | 注意 |
|----------|--------|-----------|------|
| `opacity` | 0-1 | `transparency` | 父元素会累乘 |
| `transform: rotate()` | deg | `rotate` | 仅 rotate |
| `box-shadow` | 标准值 | `shadow` | 仅 outer，不支持 inset |
| `background-image: linear-gradient()` | 线性渐变 | SVG/PNG 降级 | 不支持 radial/conic |

## 6. 元素类型

### 表格（原生支持 ★）

当前 converter 唯一原生 overlay 的元素类型。

| 特性 | 支持 |
|------|------|
| `<table>/<tr>/<th>/<td>` | 完整 |
| `rowspan`/`colspan` | 支持 |
| 单元格背景色、文字样式 | 支持 |
| 表头红色背景 + 白字 | 支持 |

### 图片

| 特性 | 支持 |
|------|------|
| `<img>` | 截图保真（非原生） |
| `object-fit` | 截图保真 |

### SVG

| 特性 | 支持 |
|------|------|
| 内联 `<svg>` | 截图保真（Phase C 将支持原生） |

### Canvas / ECharts

| 特性 | 支持 |
|------|------|
| `<canvas>` (ECharts 等) | 截图保真 |

---

## 7. 不支持原生转换的 CSS

> 以下 CSS 无法转为原生 PPTX 元素，但 **screenshot-first 会兜底**。
> 标注 ✅截图安全 = 截图保真可用；❌禁止 = 连截图都会出问题。

| CSS | 截图 | 原生 | 说明 |
|-----|------|------|------|
| `display: grid` | ✅ 安全 | ❌ 不转 | relay-claw 禁止（DOM 遍历转不了），我们截图兜底可以用 |
| `radial-gradient()`, `conic-gradient()` | ✅ 安全 | ❌ 不转 | 原生只支持 linear-gradient |
| CSS 动画 (`animation`, `transition`) | ❌ 禁止 | ❌ 不转 | 截图只抓一帧，动画中间态不确定 |
| `clip-path` | ✅ 安全 | ❌ 不转 | 截图保真 |
| `writing-mode: vertical-rl` | ✅ 安全 | ❌ 不转 | 截图保真 |
| `overflow-auto/scroll` | ❌ 禁止 | ❌ 不转 | 会出滚动条，用 `overflow-hidden` |
| 太淡的灰色文字 (`#a6a6a6`+) | ✅ 技术安全 | — | 可读性差，品牌规范禁止 |

**和 relay-claw 的关键区别**：我们 screenshot-first 策略下 Grid/clip-path 等是安全的，他们的 DOM 遍历方案必须禁止。

---

## 8. Tailwind CSS 安全类速查

### 安全（随便用）

| 分类 | Tailwind 类 |
|------|-------------|
| 颜色 | `text-{color}`, `bg-{color}` |
| 渐变 | `bg-gradient-to-{dir}`, `from-{color}`, `to-{color}` |
| 文本 | `text-[Npx]`, `font-bold/normal`, `italic`, `underline`, `text-left/center/right` |
| 间距 | `p-{n}`, `px/py-{n}`, `m-{n}`, `mx/my-{n}`, `gap-{n}` |
| 边框 | `border`, `border-{n}`, `border-{color}`, `border-solid/dashed` |
| 布局 | `flex`, `flex-col/row`, `items-center/start/end`, `justify-center/start/end/between` |
| 尺寸 | `w-full`, `h-[Npx]`, `min-h-0`, `flex-1`, `flex-shrink-0` |
| 溢出 | `overflow-hidden` |
| 透明度 | `opacity-{n}` |
| 定位 | `relative`, `absolute`, `top/left/right/bottom-{n}` |
| Grid | `grid`, `grid-cols-{n}`, `col-span-{n}` — **截图安全**（relay-claw 禁止但我们可以用） |

### 禁止

| Tailwind 类 | 原因 | 替代 |
|-------------|------|------|
| `animate-*`, `transition` | 不支持动画 | 静态样式 |
| `overflow-auto`, `overflow-y-auto` | 会出滚动条 | `overflow-hidden` |
| `blur-*`, `backdrop-blur-*` | PPT 渲染不一致 | 纯色/半透明色块 |
| `drop-shadow-*` | filter 不支持 | `shadow` (box-shadow) |
| `skew-*`, `scale-*`, `translate-*` | 仅支持 rotate | 无 |

---

## 9. 图表技术选型

| 图表需求 | 推荐方案 | PPTX 效果 |
|---------|---------|----------|
| 柱状/折线/饼/雷达/散点 | **ECharts**（`<canvas>`） | 截图保真（高清晰） |
| 简单流程/步骤 | CSS flexbox + `▶` 字符 | 截图保真 + 可读 |
| 对比矩阵 | `<table>` | **原生可编辑** ★ |
| 架构分层图 | CSS Grid/Flex 嵌套 | 截图保真 |

**ECharts 使用规范**（从 relay-claw 学来）：

```html
<!-- 容器 -->
<div class="border border-[#d4d4d4] bg-white p-3 flex flex-col overflow-hidden">
  <div id="chart-{n}" class="flex-1 min-h-0 w-full" style="min-height: 200px;"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<script>
const chart = echarts.init(document.getElementById('chart-{n}'));
chart.setOption({
  animation: false, // 必须关闭！导出截图不等动画
  // 颜色规范：
  // 坐标轴标签：#252525 或 #000（禁止浅灰 #a6a6a6）
  // 图例文字：#252525
  // 数据标签：#252525 或 #C7020E（华为红）
  // 网格线：#d4d4d4
  // 系列配色：['#C7020E','#FF6B6B','#FFA940','#FADB14','#52C41A','#1890FF','#722ED1']
});
</script>
```

---

## 演进计划

| 阶段 | 新增原生能力 | 白名单扩展 |
|------|-------------|-----------|
| 当前 (D5) | 表格 overlay | 表格完整支持 |
| Phase C 完成后 | SVG→可编辑形状 | SVG 元素升级为原生 |
| 后续 | KPI/SmartArt 原生 | 更多组件可编辑 |
| 终态 | ECharts→原生图表 | 图表数据可编辑 |
