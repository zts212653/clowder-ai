# Claude.ai 浏览器自动化参考

> 验证日期：2026-03-10 | 验证猫：Ragdoll Opus 4.6
> 工具：`mcp__claude-in-chrome__*`

本文档记录通过 Chrome MCP 操作 Claude.ai Web UI 的实测 DOM 知识。
deep-research skill 的 Step 2 浏览器自动化引用此 ref。

## 前置条件

- Chrome 安装了 Claude in Chrome 扩展并已连接
- 用户已登录 Claude.ai（Pro/Team 账户）
- 调用前先 `tabs_context_mcp` 获取 tab 信息

## Claude Research 完整流程（已验证 ✅）

### Step 1: 打开新对话或已有对话

```
navigate → https://claude.ai/new
```

### Step 2: 激活 Research 模式

点击输入框左侧的 `+` 按钮（Toggle menu），再点击 "Research"。

```
DOM 路径：
1. button "Toggle menu" (ref 示例: ref_40) → 打开加号菜单
2. 菜单中点击 "Research" 选项
```

菜单选项包括：Add files or photos / Take a screenshot / Add to project /
Add from Google Drive / Add from GitHub / **Research** / Web search / Use style / Connectors

### Step 3: 填写提示词 & 发送

输入框选择器：
```javascript
// Claude.ai 输入框
const textarea = document.querySelector('textarea[placeholder*="How can I help"]');
// 或使用 contenteditable div（Claude.ai 可能用 ProseMirror）
```

> ⚠️ Claude.ai 的输入框可能是 `<textarea>` 或 contenteditable div，
> 需要实测当前版本。用 `form_input` 工具或 `execCommand('insertText')` 尝试。

### Step 4: 等待 Research 完成

Research 耗时通常 5-15 分钟。完成后出现：
- 对话区显示 "Research complete · {N} sources · {T}m {S}s"
- 生成一个文章卡片（Artifact）

检测完成的方法：
```javascript
// 检查是否有 "Research complete" 文本
const isComplete = document.body.innerText.includes('Research complete');
// 或检查 Artifact 按钮出现
const artifactBtn = document.querySelector('button[aria-label*="Open artifact"]');
```

### Step 5: 打开报告文章

点击文章卡片打开右侧面板：
```
button "Open artifact: {文章标题}" → 打开右侧 Artifact 面板
```

### Step 6: 下载报告（关键步骤！✅ 超级简单）

1. 点击右上角 **"Copy options ▾"** 按钮（`Copy` 旁边的下拉箭头）
2. 点击 **"Download as Markdown"**（这是一个 `<a>` 链接，href 是 blob URL）

```
DOM 路径：
1. button "Copy options" → 展开下拉菜单
2. link "Download as Markdown" (href="blob:https://claude.ai/...") → 直接触发下载
```

下载的文件名格式：`compass_artifact_{uuid}_text_markdown.md`

也可以用 **"Copy"** 按钮直接复制到剪贴板，但下载更可靠。

## 选择器速查

| 元素 | 选择器/描述 | 用途 |
|------|-----------|------|
| 输入框 | `textarea` 或 contenteditable | 文本注入 |
| 加号菜单 | `button "Toggle menu"` | 激活 Research 等功能 |
| Research 选项 | 菜单中 "Research" 项 | 切换 Research 模式 |
| 研究状态 | 文本 "Research complete" | 检测完成 |
| Artifact 卡片 | `button "Open artifact: ..."` | 打开报告面板 |
| Copy 按钮 | `button "Copy"` (Artifact 面板内) | 复制到剪贴板 |
| Copy 下拉 | `button "Copy options"` | 展开下载菜单 |
| Download MD | `link "Download as Markdown"` (blob URL) | **下载 .md 文件** |
| Download PDF | `menuitem "Download as PDF"` | 下载 PDF |
| Close artifact | `button "Close artifact"` | 关闭面板 |
| Share | `button "Share"` | 分享链接 |

## 与 ChatGPT Deep Research 的对比

| 特性 | Claude.ai Research | ChatGPT Deep Research |
|------|-------------------|----------------------|
| 报告渲染 | Artifact 面板（同源 DOM） | 跨域 iframe |
| 下载 | ✅ 原生 "Download as Markdown" 按钮 | ❌ 无原生下载（需 API 提取） |
| Copy 按钮 | ✅ 复制完整内容 | ❌ 只复制标题片段 |
| 自动化难度 | **简单** — 点击下载按钮即可 | **复杂** — 需 session token + API 调用 |
| 提取方法 | 点击 blob URL 下载 | `backend-api/conversation/{id}` + JSON 解析 |
| 报告格式 | 干净 Markdown + 内联引用标注 | Markdown + filecite 标记（需清洗） |

## 完整自动化流程（全自动 ✅）

```
1. tabs_context_mcp → 找到或创建 Claude.ai tab
2. navigate → claude.ai/new
3. (可选) 上传文件（Add files or photos）
4. 激活 Research：点击 + → Research
5. 注入 prompt 文本
6. 发送（Enter 或点击发送按钮）
7. 轮询等待完成（检查 "Research complete" 文本出现，每 30s，最长 20min）
8. 点击 Artifact 卡片打开报告
9. 点击 "Copy options" → "Download as Markdown"
10. 猫用 cp ~/Downloads/{file}.md → docs/research/YYYY-MM-DD-{topic}/claude/report.md
```

## 已知限制

1. **文件名不可控**：下载的文件名是 `compass_artifact_{uuid}_text_markdown.md`，需要手动 rename
2. **Research 模式激活**：需要通过 + 菜单点击，没有 URL 快捷方式
3. **下载可能被浏览器拦截**：首次可能需要用户确认"允许下载"
4. **输入框类型待确认**：Claude.ai 可能使用 ProseMirror 或类似富文本编辑器，`execCommand` 是否有效需实测
