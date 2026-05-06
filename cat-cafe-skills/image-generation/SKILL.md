---
name: image-generation
description: >
  AI 图片生成：原生 tool call（Codex/Antigravity）或浏览器自动化（Gemini/ChatGPT）。
  Use when: 需要 AI 生成概念图、UI 参考、像素画素材。
  Not for: 已有图片的展示（用 media_gallery rich block）、SVG 图标制作（手写或用设计工具）。
---

# AI 图片生成 Skill

> 用途：生成 AI 图片——优先原生 tool call，降级浏览器自动化
> 适用猫猫：所有猫

## 何时使用

- 需要为 feature 生成概念图、UI 参考图、像素画素材
- 铲屎官要求生成特定风格的图片
- 需要批量生成多个变体

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
