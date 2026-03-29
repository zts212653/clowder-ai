---
name: image-generation
description: 通过 Chrome MCP 浏览器自动化在 Gemini / ChatGPT 上生成图片并下载
---

# AI 图片生成 Skill

> 用途：通过 Chrome MCP 浏览器自动化，在 Gemini / ChatGPT 上生成图片并下载
> 适用猫猫：所有猫（需要 Chrome MCP 连接）

## 何时使用

- 需要为 feature 生成概念图、UI 参考图、像素画素材
- 铲屎官要求生成特定风格的图片
- 需要批量生成多个变体

## 支持平台

| 平台 | 模型 | 风格选择器 | 文本注入 | 下载 | Ref |
|------|------|-----------|---------|------|-----|
| **Gemini** | Gemini 3 Pro | ✅ 多种预设风格 | `execCommand` ✅ | 灯箱 → 下载完整尺寸 ✅ | `refs/gemini-browser-automation.md` |
| **ChatGPT** | GPT-4o / DALL-E | ✅ 风格预设（漫画/鎏金/蜡笔等） | `execCommand` ✅ | 保存按钮 / 下载按钮 ✅ | `refs/chatgpt-browser-automation.md` |

## 快速流程

### Gemini 画图

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

### ChatGPT 画图

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

1. **Gemini 制作图片模式会粘滞**：和 Deep Research 一样，选了制作图片后输入框保持该模式
2. **ChatGPT 图片页面是独立入口**：`/images` 和普通对话 `/` 是分开的
3. **两个平台都支持 execCommand 注入**
4. **Gemini 图片更大**（~7MB PNG），ChatGPT 图片更小（~1MB PNG）
5. **归档到项目**：`cp ~/Downloads/xxx.png → assets/` 或相关目录
