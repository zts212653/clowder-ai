---
name: image-generation
description: >
  AI 图片生成：原生 tool call（Codex/Antigravity）或浏览器自动化（Gemini/ChatGPT）。
  Use when: 需要 AI 生成概念图、UI 参考、像素画素材、完整 PPT 页面、复杂架构图、信息图或视觉 mock。
  Not for: 已有图片的展示（用 media_gallery rich block）、硬要求可编辑/native text 的 PPT/图表（用 PPT/HTML 管线）。
  Output: 生成图片自动发布，或作为完整视觉 mock / 图像素材进入后续交付。
---

# AI 图片生成 Skill

> 用途：生成 AI 图片——优先原生 tool call，降级浏览器自动化
> 适用猫猫：所有猫

## 何时使用

- 需要为 feature 生成概念图、UI 参考图、像素画素材
- 铲屎官要求生成特定风格的图片
- 需要批量生成多个变体
- 需要直接生成完整 PPT/slide 页面、复杂架构图、企业信息图、封面或高密视觉 mock
- 用户明确说“不需要可编辑”“内部 mock”“直接生成完整页面”

## Codex 原生能力校准：不要低估 imagegen

Codex `image_gen` 不只是“概念图/素材生成器”。当前实测能力可以直接生成**完整高保真 raster 页面**，包括：

- 企业 PPT / slide 页面：高密度模块、标题、图标、流程链路、判断框、页脚
- 复杂架构图 / 信息图：多分区、多节点、多箭头、多层级视觉组织
- 品牌风格 mock：如华为风格的红白黑企业战略页、发布会封面、白皮书页
- UI / poster / cover：需要强视觉完成度、但不要求 native editability 的图像产物

**默认判断**：当用户要的是“好看、完整、像最终稿”的视觉 mock，且不要求可编辑，先走整页 imagegen。不要先手写 SVG/HTML 去拼格子、排文字、合成素材。

### Codex SVG 复发熔断闸

对 Codex / Maine Coon尤其重要：命中以下任一条件时，**禁止**先写 SVG/HTML/Canvas/脚本合成：

- 用户要“架构设计图 / 架构图 / PPT 页面 / 华为风 / 白底红黑 / 精美图 / 最终稿”
- 已有低保真草图、ASCII 蓝图或设计规格，用户要生成“精美版 / 设计图 / 图片”
- 用户没有明确要求“可编辑文字 / native PPT 元素 / SVG 源文件 / HTML 文件”

执行顺序：

1. 先调用原生 imagegen 生成整页 raster。
2. 只用 prompt 迭代 1-2 次修风格、层级、文字密度。
3. 只有 imagegen 已失败，或用户明确要求可编辑 / native text / SVG 源文件，才允许降级 SVG/HTML/PPT。
4. 若准备写 SVG/HTML，必须先写出 `SVG override reason`：指向已失败的 imagegen 产物，或引用用户的显式可编辑要求。

以下理由不合格，不能覆盖 imagegen-first：中文文字更可控 / 布局更可控 / 先画 SVG 再转 PNG / 架构图需要精确。

### Full-page raster first

当用户说“不需要可编辑”“只要精美 mock”“直接生成完整 PPT 页面”时，按这个顺序：

1. **整页直出**：用一个完整 prompt 描述页面比例、风格、版式、文案、信息密度、图标、图表、负面约束，直接生成完整页面。
2. **视觉评估**：先看整体风格、信息密度、层级、可读性。若大方向对，用 prompt 迭代，而不是立刻拆成 SVG/合成管线。
3. **参考图辅助**：如果有低保真草图或同风格样张，把它当 reference / layout guide，但仍让 imagegen 生成整页最终图。多页交付（如 10 页 PPT 套图）时，第一页定稿后作为后续每页的 reference image / style anchor，让整套保持同一视觉系统。
4. **失败才降级**：连续 1-2 次整页直出都无法保住结构、文字或品牌风格时，再考虑 HTML/PPT/SVG/hybrid。

### 什么时候才写 SVG / HTML / hybrid

- 硬要求可编辑文字、native chart、PPT 元素可改
- 硬要求像素级对齐、可复用组件、可导出真实代码
- 需要用真实商标/logo/精确法律文本，且图片模型容易画错
- imagegen 已经尝试过整页直出但无法达到验收线

低保真蓝图是**辅助 imagegen 理解布局**，不是默认替代 imagegen 的最终渲染管线。不要为了“可控”牺牲用户真正要的视觉完成度。

## 路径选择（先问自己有没有原生能力）

```
你有内置图片生成 tool 吗？
├─ 是（Codex / Antigravity）→ 用原生 tool call（§ 原生路径）
│   优势：快、自动发布到气泡、无需浏览器
│
├─ 否（Claude / 其他）→ 能 shell out 到有能力的 CLI 吗？
│   ├─ 是 → 借用（§ 跨引擎借用）
│   └─ 否 → 浏览器自动化（§ 浏览器路径）
│
└─ 需要特定风格控制 / inpainting / 局部编辑？
    └─ 是 → 即使有原生能力也走浏览器路径
```

## 支持平台
| 路径 | 平台 | 工具 | 产物位置 | F172 自动发布 |
|------|------|------|---------|-------------|
| **原生** | **Codex CLI** | 内置 `image_gen` tool call | `~/.codex/generated_images/<sessionId>/` | ✅ scanner 自动拾取 |
| **原生** | **Antigravity** | 内置 `generate_image` tool call | `~/.gemini/antigravity/brain/<cascadeId>/` | ✅ GENERATE_IMAGE step 自动拾取 |
| 浏览器 | Gemini Web | Chrome MCP 自动化 | 本地下载目录 | 需手动 `publishGeneratedImage()` |
| 浏览器 | ChatGPT Web | Chrome MCP 自动化 | 本地下载目录 | 需手动 `publishGeneratedImage()` |

## 原生路径（优先）

### Codex CLI — `image_gen` tool call

**谁能用**：Codex CLI 主执行猫（内置）

**用法**：直接在当前 invocation 里调用内置 `image_gen` tool。这是一个 native tool call，不是 shell 命令，也不是再开一个 `codex exec` 子进程。

```
❌ 错误：codex exec --image <参考图>     ← 这是 nested CLI session，当前气泡不会展示
✅ 正确：使用内置 image_gen tool call    ← 图片自动落到当前 session 的 generated_images/
```

**有参考图时**：参考图必须在当前对话上下文里（用户上传、上一步生成、或已被 `view_image` 打开）再调用 `image_gen`，并在 prompt 里说明它是 `reference image / edit target / style reference`。如果当前 tool surface 无法把本地参考图接进 native `image_gen`，停下来报告能力缺口；不要退回到 `codex exec --image` 冒充原生路径。

**产物流转**：
```
image_gen tool call
  → 图片生成到 ~/.codex/generated_images/<当前 sessionId>/<filename>.png
  → invocation 结束后 F172 scanner 自动扫描
  → publishGeneratedImage() 发布到 /uploads/
  → 自动生成 media_gallery 富块 → 气泡内展示 ✓
```

**关键**：不需要手动下载、不需要手动 cp、不需要手动发富块。全自动。

### Antigravity — `generate_image` tool call

**谁能用**：对应猫（Antigravity 内置）

**用法**：直接在对话中调用内置 `generate_image` tool。

**产物流转**：
```
generate_image tool call
  → CORTEX_STEP_TYPE_GENERATE_IMAGE step
  → 图片生成到 ~/.gemini/antigravity/brain/<cascadeId>/<imageName>_<unixMs>.<ext>
  → F172 brain scanner 自动拾取
  → publishGeneratedImage() 发布到 /uploads/
  → 自动生成 media_gallery 富块 → 气泡内展示 ✓
```

### 跨引擎借用（实验性）

没有原生图片生成能力的猫（如 Claude）可以通过 shell out 借用其他引擎的 CLI：

```bash
# 前提：codex CLI 在 PATH 中且已配置
codex exec "生成一张猫咖全景图，手绘水彩风格"
```

注意：跨引擎借用目前只适合**离线资产生成**。它会创建另一个 Codex session，产物通常不会被当前猫的 F172 scanner 自动拾取，也不会自动出现在当前气泡里。需要气泡内展示时，优先把球权交给有原生能力的猫，或显式走 artifact promotion / rich block 路径。

---

## 浏览器路径（降级 / 需要风格控制时使用）

### Gemini 画图（浏览器）

```
1. 导航到 gemini.google.com/app
2. 工具 → 制作图片（或直接点首页快捷按钮）
3. execCommand 注入 prompt 到 .ql-editor
4. 点击发送（蓝色箭头）
5. 等待生成（~15-30秒）
6. 点击图片 → 灯箱模式
7. 点击 "下载完整尺寸的图片" 按钮
8. 文件保存为 Gemini_Generated_Image_{hash}.png
```

**Gemini 特有**：
- 有风格选择器（单色、色块、绚彩、哥特风黏土等）
- 可先选风格再输入 prompt
- 图片右下角有 Gemini ✦ 水印

### ChatGPT 画图（浏览器）

```
1. 导航到 chatgpt.com/images（或左侧栏 → 图片）
2. execCommand 注入 prompt 到 #prompt-textarea
3. 按 Enter 发送
4. 等待生成（~10-20秒）
5. 方式 A：点击图片 → 灯箱 → 右上角 "保存" 按钮
6. 方式 B：hover 图片 → 点击 "下载此图片" 按钮
7. 文件保存为 ChatGPT Image {日期} {时间}.png
```

**ChatGPT 特有**：
- 有「选择区域」局部编辑（inpainting）
- 灯箱模式有「描述编辑」输入框可以文字修改图片
- 有风格预设（漫画风潮、繁花之驱、鎏金塑像等）
- 图片页面 URL: `chatgpt.com/images`

## DOM 选择器速查

### Gemini

| 元素 | 选择器 |
|------|--------|
| 输入框 | `.ql-editor[contenteditable="true"]` |
| 工具按钮 | `button "工具"` |
| 制作图片 | 工具菜单中 `"制作图片"` |
| 发送 | 输入框右侧蓝色箭头 |
| 灯箱下载 | `button "下载完整尺寸的图片"` |
| 灯箱分享 | `button "分享图片"` |
| 灯箱复制 | `button "复制图片"` |
| 灯箱关闭 | `button "关闭"` |

### ChatGPT

| 元素 | 选择器 |
|------|--------|
| 输入框 | `#prompt-textarea` |
| 图片页面 | `chatgpt.com/images` |
| 发送 | Enter 键 或 发送按钮 |
| 下载（hover） | `button "下载此图片"` |
| 灯箱保存 | 右上角「保存」按钮（`button` 含下载图标） |
| 灯箱编辑输入 | `dialog` 内 `textbox`（描述编辑） |
| 选择区域 | 右上角「选择区域」按钮 |
| 灯箱关闭 | `button "关闭"` |

## 下载文件命名

| 平台 | 格式 | 示例 |
|------|------|------|
| Gemini | `Gemini_Generated_Image_{hash}.png` | `Gemini_Generated_Image_2kvjb12kvjb12kvj.png` |
| ChatGPT | `ChatGPT Image {年}年{月}月{日}日 {HH_MM_SS}.png` | `ChatGPT Image 2026年3月10日 07_14_32.png` |

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 低估 Codex `image_gen`，把它当素材器 | 绕去写 SVG/HTML，页面僵硬、对齐差、审美差 | 视觉 mock 默认先整页 raster 直出 |
| 用户说“直接生成完整 PPT 页面”，仍拆成图标资产 + 手工合成 | 信息堆叠、文字错位、整体不像最终稿 | 用完整页面 prompt 直接生成，再按视觉反馈迭代 |
| 过度追求 native text / 可编辑性 | 违背“不需要可编辑”的目标，产物变丑 | 先确认交付目标：raster mock 走 imagegen，editable deck 走 PPT/HTML |
| 为了避免文字风险生成无字图 | 用户期待的是完整页面，结果变成空背景/素材 | PPT mock 要含标题、标签、数据和结构；文字失败再降级 |
| 用 SVG 画复杂企业页但没有设计系统和排版能力 | 格子、文字、图标互相打架 | 让 imagegen 承担视觉完成度；SVG 只做必要的精确结构或 reference |

## 注意事项

### 通用

1. **优先原生 tool call**：有内置 `image_gen` / `generate_image` 的猫，必须用原生路径。浏览器路径只在需要风格选择器、inpainting、局部编辑时使用
2. **F172 自动发布**：原生路径产物由 scanner 自动拾取 → `publishGeneratedImage()` → `/uploads/` 稳定 URL + `media_gallery` 富块。零手动操作
3. **禁止 CLI 命令替代 tool call**：`codex exec --image` 不等于内置 `image_gen` tool call。`--image` 是 nested CLI 的输入附件，不是当前 invocation 的 native reference-image 通道；前者的产物不会被当前气泡的 F172 scanner 自动发布

### 浏览器路径专用

4. **Gemini 制作图片模式会粘滞**：和 Deep Research 一样，选了制作图片后输入框保持该模式
5. **ChatGPT 图片页面是独立入口**：`/images` 和普通对话 `/` 是分开的
6. **两个平台都支持 execCommand 注入**
7. **Gemini 图片更大**（~7MB PNG），ChatGPT 图片更小（~1MB PNG）
8. **浏览器路径归档**：下载后的图片通过 `publishGeneratedImage()` 发布到 `/uploads/`（F172 共享发布合约）。发布后自动获得 `/uploads/...` 稳定 URL + `media_gallery` 富块
