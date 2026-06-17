---
name: ppt-forge
description: >
  PPT 制作全链路：内容分析 → 分页规划 → 低保真 MD → imagegen 精美图。
  架构猫写低保真 MD（ASCII art 结构图 + 视觉指引），imagegen 猫逐页出精美图。
  Use when: 做 PPT、做演示文稿、做 slide、帮朋友做 PPT、画架构图、画技术蓝图。
  Not for: 纯代码开发（用 worktree/tdd）、纯文档写作（直接写）。
  Output: 低保真 MD + AI 原生精美图（raster PNG）。
---

# PPT Forge — 低保真 MD → AI 精美图

## 核心原则

**架构猫写蓝图，imagegen 猫出精美图。** 不走 HTML/SVG 手工合成。

- **架构猫**（当前持球猫）：内容分析 + 分页规划 + 低保真 MD 写作
- **imagegen 猫**（imagegen 猫/云端 Codex）：逐页生成精美 raster PNG
- **operator**：审稿 + 确认风格

产出是 **AI 原生图片**——视觉质量远高于 HTML/CSS 手工画，且速度快。

## 开局参数（必须声明）

| 参数 | 说明 | 示例 |
|------|------|------|
| 风格 preset | 对标公司的视觉基因 | 华为 / Apple / 阿里 / 自定义 |
| 受众 | 谁看这个 PPT | 部门领导 / CTO / 投资人 / 客户 |
| 场景 | PPT 用在哪 | 转正答辩 / 年会汇报 / 客户提案 / 技术分享 |
| 内容取舍 | 全保留 or 可精简 | "所有内容全保留" / "只要核心亮点" |

**没有开局参数 = 分页和风格无标准。开工前先锁。**

## 场景路由

| 触发 | 场景 | 主导 | 详细文档 |
|------|------|------|---------|
| operator说"做个 PPT" | **1: 内容分析 + 分页规划** | 架构猫 | [ppt-lofi-authoring.md](../refs/ppt-lofi-authoring.md) |
| 分页确认 | **2: 低保真 MD 写作** | 架构猫 | [ppt-lofi-authoring.md](../refs/ppt-lofi-authoring.md) |
| 低保真 MD 完成 | **3: operator审稿** | operator | — |
| 审稿通过 | **4: imagegen 出图** | imagegen 猫/云端 Codex | 逐页生成精美图 |
| 出图完成 | **5: 交付** | 主执行猫 | 图片打包 + 预览 |
| operator不满意 | **R: 回到 1 或 2** | — | 改分页/改内容/改风格 |

## 场景 1-2: 低保真 MD 写作

> 详细规范：[ppt-lofi-authoring.md](../refs/ppt-lofi-authoring.md)

### 写作流程

1. **内容分析**：读完全部原始内容，识别：
   - 核心板块（几个大的独立主题）
   - 关键数据点（有冲击力的数字）
   - 可图表化的逻辑链（流程/对比/层级）
   - 信息层级（总→分）

2. **分页规划**：确定每页的类型和内容分配
   - 页面类型：封面 / 总览 / 详情 / 方法论 / 路线图 / 总结
   - 先给operator看分页表，确认再动手写

3. **风格锁定**：选择风格 preset，配色方案一次锁定

4. **低保真 MD 写作**：每页一个 section
   - ASCII art 结构图（用 box drawing 字符画清布局）
   - 视觉指引（给 imagegen 猫的文字描述）
   - 数据高亮方式标注

5. **精美图生成指引**：末尾写总体风格规范 + 逐页清单表格

### 低保真 MD 文件结构

```markdown
---
title: "PPT 标题 — 低保真稿"
created: YYYY-MM-DD
author: "[签名]"
doc_kind: diagram
status: lofi-draft
---

# 标题

> **受众**：...
> **风格**：...
> **视觉**：一行配色方案
> **页数**：N 页
> **原则**：...

## P1：封面
（ASCII art + 视觉指引）

## P2：总览
（ASCII art + 视觉指引）

...

## 精美图生成指引（给imagegen 猫）
（配色方案 + 字体风格 + 密度原则 + 逐页清单）
```

## 场景 4: imagegen 出图交接协议

发给 imagegen 猫时说清：

1. **低保真 MD 文件路径**（不贴全文，太长）
2. **逐页生成**：每页一张独立图片
3. **输出位置**：同目录 `assets/` 子目录
4. **技术要求**：
   - 原生 imagegen 直出 raster PNG
   - **不用 SVG / HTML 手工合成**（出来贼丑）
   - 每页命名：`p{N}-{简短描述}.png`
5. **内容约束**：
   - 严格遵循配色方案，不自由发挥
   - 文字内容以低保真 MD 为准，不删不加

## 场景 5: 交付

- 图片生成完成后，打包到 `assets/` 子目录
- 用 `media_gallery` rich block 或直接展示给operator
- 说清每页对应关系

## 风格 Preset

| 风格 | Ref 文件 | 核心特征 |
|------|---------|---------|
| **华为** | [ppt-style-huawei.md](../refs/ppt-style-huawei.md) | 白底+红黑、直角、极致密排、图表化、数据说话 |
| Apple | 待补 | 黑白+渐变、大圆角、极简、每页一件事 |
| 阿里 | 待补 | 橙+科技蓝、中圆角、Dashboard 风 |

需要新风格时，参照 [ppt-style-huawei.md](../refs/ppt-style-huawei.md) 格式新建 ref。

## 成功案例

| 案例 | 日期 | 路径 | 风格 |
|------|------|------|------|
| LLE 自进化平台架构图 | 2026-05-28 | *(internal reference removed)* | 华为 |
| 试用期工作总结 | 2026-05-29 | *(internal reference removed)* | 华为 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 没锁风格 preset 就动手写 | 写完才发现配色不对，返工 | 开工前先锁风格 |
| ASCII art 太简陋 | imagegen 猜布局，结果不对 | 画清每个区域的位置和大小 |
| 视觉指引缺配色 | imagegen 用默认配色 | 每页引用风格 preset |
| 大段原文直接贴 | imagegen 不知道怎么排版 | 先做信息设计（分卡片/分层级/转图表） |
| 没写精美图生成指引 | imagegen 猫要反复问风格 | 末尾必有总章 |
| 用 SVG/HTML 合成 | **贼丑** | 只用原生 imagegen 直出 |

## 和其他 Skill 的关系

- `image-generation`：通用图片生成 — ppt-forge 是 PPT 专用流程
- `expert-panel`：多猫分析报告 — ppt-forge 是做 PPT
- `tech-writing`：写文档 — ppt-forge 做演示文稿（视觉优先）
