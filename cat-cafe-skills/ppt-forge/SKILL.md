---
name: ppt-forge
description: >
  PPT 制作全链路：内容规划 → 风格定调 → Slide 制作 → 视觉审查 → 导出验证 → 交付。
  Use when: 做 PPT、做演示文稿、做 slide、做海报、PPT review、视觉审查。
  Not for: 纯代码开发（用 worktree/tdd）、纯文档写作（直接写）。
  Output: 高密度 HTML slide + 多猫审查通过 + 导出验证。
---

# PPT Forge — AI 演示文稿生产线

## 核心原则

**PPT 不是一个人的活，是三猫流水线。**

- Ragdoll：内容规划 + HTML 制作 + density gate
- Maine Coon：布局/信息审查 + Export Truth Gate
- Siamese：审美/品牌审查 + 风格定调

## 开局参数（必须声明）

| 参数 | 说明 | 示例 |
|------|------|------|
| 页型（archetype） | 决定密度、字号矩阵和信息组织方式 | 华为高密战略页 / KPI Dashboard / 发布会结论页 |
| 品牌 | 对标公司的视觉基因 | 华为 / Apple / 阿里 |
| 受众 | 谁看这个 PPT | CTO / 投资人 / 技术团队 |
| 场景 | PPT 用在哪 | 年会汇报 / 客户提案 / 内部分享 |
| 主观看模式 | 影响字号/密度/留白标准 | presentation（大屏）/ document（PDF 阅读） |

**没有开局参数 = 开工和审查都没有标准。开工前必须先锁这 5 项。**

## 场景路由

| 触发 | 场景 | 主导 | 详细文档 |
|------|------|------|---------|
| 铲屎官说"做个 PPT" | **A: 内容规划** | Ragdoll | 主 skill 最小规则（ref 待补） |
| 大纲确认 | **B: 风格定调** | Siamese审 + Ragdoll做 | [ppt-style-tile.md](../refs/ppt-style-tile.md) |
| 风格确认 | **C: Slide 批量制作** | Ragdoll | [ppt-slide-authoring.md](../refs/ppt-slide-authoring.md) |
| Slide 做完 | **D: 视觉审查 Gate** | Maine Coon(D1) + Siamese(D2) | [ppt-visual-review.md](../refs/ppt-visual-review.md) |
| 审查通过 | **E: Export Truth Gate** | Maine Coon | 主 skill 最小规则（ref 待补） |
| 导出验证通过 | **F: 交付** | Ragdoll | [ppt-delivery.md](../refs/ppt-delivery.md) |
| 需要对比竞品 | **G: Benchmark 对拍** | Maine Coon + Siamese | 主 skill 最小规则（ref 待补） |
| 铲屎官不满意 / 连续 2 轮 P1>0 | **R: 翻盘重来** | 三猫 | 主 skill 最小规则（ref 待补） |

## 还没拆成 ref 的场景（当前最小真相源）

### A: 内容规划

- 先锁：`archetype / 品牌 / 受众 / 场景 / 主观看模式`
- 至少产出：`本页目的一句话 + 证据源列表 + 页面结构草图`
- 没说清"这页让人看完要得出什么结论" → 不进 C

### E: Export Truth Gate

- 检查：`native text / native chart / native table / screenshot fallback / repair dialog`
- 任何一项说不清 → 不进 F

### G: Benchmark 对拍

- 必须同 archetype、同主题、同观看模式比较
- 至少对拍：`信息密度 / 事实保留 / 说服力 / 品牌贴合度`

### R: 翻盘重来

- 连续 2 轮 P1>0 或铲屎官说"方向不对" → 直接回到 A/B，不准在坏页型上缝补
- 先写 `Author Synthesis`，说明这次为什么要重开

## 视觉审查 6 件套（D 场景输入包）

每次发起视觉审查，作者必须附带：

1. **品牌+受众 brief** — "华为风格，受众 CTO，1 页讲清 moat"
2. **页型（archetype）+ 主观看模式** — 防止 reviewer 把页面改型
3. **本页目的** — 一句话说清这页要达成什么
4. **截图/预览 URL** — 渲染结果
5. **HTML/CSS 源码** — 定位布局 bug 用
6. **密度数据** — whitespace%、element count、overflow

> 没有 6 件套 = 观感点评；有 6 件套 = P1/P2 级审查。

## 审查维度速查

### D1: 布局/信息审查（Maine Coon）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 布局 bug | 真实 CSS/HTML 错误 |
| P1 | 信息失败 | 没讲清重点 / 层级错 / 受众看不懂 |
| P1 | 密度失衡 | 该密不密 / 该疏不疏 |

### D2: 审美/品牌审查（Siamese）

| 级别 | 维度 | 判定 |
|------|------|------|
| P2 | 品牌偏移 | 不像目标公司的设计语言 |
| P2 | 视觉一致性 | 字号/卡片/边框/图标语言不统一 |

审美五维：色彩体系 · 字体排印 · 空间网格 · 视觉元素 · 密度平衡

## HTML Slide 预览（ref: browser-preview skill）

Slide 做完必须先自己看一遍再交活。预览走 **Hub 内嵌浏览器**（browser-preview skill），禁止用 Chrome MCP / `open` 命令 / Playwright。

### 预览流程

```
1. 图片内联 — 所有 <img src="xxx.png"> 必须转成 data URI
   原因：Preview Gateway 要求每个请求带 __preview_port 参数，
   相对路径请求（如 /image.png）不带此参数 → 400 错误 → 图裂。

2. 起 HTTP server — 每个 slide 用独立端口
   原因：BrowserPanel 按 port 去重，同 port 只创建 1 个 tab。
   N 个 slide → N 个端口 → N 个 tab。
   python3 -m http.server PORT（每个 slide 一个端口）

3. 调 auto-open API — 每个端口调一次
   curl -X POST http://localhost:3003/api/preview/auto-open \
     -H "Content-Type: application/json" \
     -d '{"port": PORT, "path": "/slide.html"}'
   间隔 300ms 避免 socket 事件丢失。
```

### 图片内联参考

```python
import base64, re, os
def inline_images(html_path):
    with open(html_path) as f: content = f.read()
    def replace(m):
        src = m.group(1)
        if not os.path.exists(src): return m.group(0)
        b64 = base64.b64encode(open(src,'rb').read()).decode()
        mime = 'image/png' if src.endswith('.png') else 'image/jpeg'
        return f'src="data:{mime};base64,{b64}"'
    return re.sub(r'src="([^"]+\.(?:png|jpg|jpeg|gif|webp))"', replace, content)
```

### 陷阱速查

| 现象 | 根因 | 修法 |
|------|------|------|
| 图片裂了 | 相对路径缺 `__preview_port` | 图片转 data URI |
| 只有 1 个 tab | 同 port 去重 | 每 slide 独立端口 |
| proxy error | HTTP server 没跑 | 先 `curl localhost:PORT` 验证 |

## 密度填充手法

详见 [ppt-density-playbook.md](../refs/ppt-density-playbook.md)

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 没声明开局参数 | 开工和审查没有标准 | 开工前锁 `archetype + 品牌 + 受众 + 场景 + 主观看模式` |
| 20 页全做完才审 | 返工成本爆炸 | B 场景：先做 1-2 页核心页定调 |
| 自己说"没问题"不截图 | 布局 bug 漏检 | 自检必须截图看一遍再交活 |
| 审查只给截图没给 HTML | 只能说"这里怪" | 必须带 6 件套 |
| 主 skill 挂死链 ref | 执行时靠口头补流程 | 没写出来的 ref 不准继续写成可执行路由 |
| 跳过 Export Gate | 导出后不可编辑/乱码 | 独立验证导出质量 |

## 和其他 Skill 的区别

- `request-review` / `receive-review`：**代码**审查 — ppt-forge D 场景是**视觉**审查
- `expert-panel`：多猫分析报告 — ppt-forge 是做 PPT
- `quality-gate`：代码自检 — ppt-forge 有自己的 density gate

## 下一步

完成交付(F) 后 → 如果是 feature 的一部分 → `feat-lifecycle`
