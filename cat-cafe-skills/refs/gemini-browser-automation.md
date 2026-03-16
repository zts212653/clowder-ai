# Gemini Browser Automation — Chrome MCP 操作参考

> 实测日期：2026-03-10 | 实测猫：Ragdoll Opus 4.6
> 平台：gemini.google.com（Gemini 3 Pro）

## 核心发现

- **文本注入有效！** `execCommand('insertText')` 在 Quill `.ql-editor` 上正常工作
- Deep Research 有**计划确认步骤**（ChatGPT/Claude 没有）
- 报告导出路径：Gemini → Google Docs → 文件 → 下载 → Markdown (.md)
- 导出是**两跳**（Gemini → Google Docs → 本地），比 ChatGPT（API 直取）和 Claude（原生下载）多一步

## DOM 选择器

### 输入区域

```
// Quill 编辑器（contenteditable）
.ql-editor[contenteditable="true"]
// 或
.ql-editor.ql-blank.textarea.new-input-ui
```

### 工具栏按钮

| 元素 | 选择器 / read_page ref |
|------|----------------------|
| 工具按钮 | `button "工具"` |
| Deep Research 菜单项 | 菜单中文本 `"Deep Research"` |
| 发送按钮 | 输入框右侧蓝色箭头（有文本时出现） |
| 停止按钮 | 输入框右侧蓝色方块 ■ |
| 文件上传 | `button "打开文件上传菜单"` / `+` 按钮 |
| 来源选择 | `button "来源"` — Deep Research 模式下出现 |
| 文件上传（DR 模式） | `button "文件"` — Deep Research 模式下出现 |
| 模式选择器 | `button "打开模式选择器"` — 右下角显示 "快速 ∨" |

### 研究计划确认

Deep Research 发送后会先生成研究计划，需要用户确认：

| 元素 | 说明 |
|------|------|
| `button "开始研究"` | 确认计划，开始研究 |
| `button "修改方案"` | 要求修改计划 |
| `link "不使用 Deep Research，再试一次"` | 退出 DR 模式 |

### 研究完成后

| 元素 | 选择器 / 说明 |
|------|-------------|
| 分享和导出 | 报告面板顶部 `button "分享和导出"` |
| 导出到 Google 文档 | 下拉菜单项 |
| 复制内容 | 下拉菜单项（直接复制，但格式可能有问题） |
| 目录 | 报告面板顶部 `button "目录"` |

## 文本注入

```javascript
// Gemini 使用 Quill 编辑器，execCommand 有效！
const editor = document.querySelector('.ql-editor[contenteditable="true"]');
editor.focus();
document.execCommand('insertText', false, '你的提示词');
```

> **重要更正**：之前 SKILL.md 记录"contenteditable 不接受标准 execCommand"是**错误的**。
> Gemini 的 Quill 编辑器完全支持 `execCommand('insertText')`。

## 完整自动化流程

### Deep Research 模式

```
1. [新对话] 点击 "发起新对话" 或导航到 gemini.google.com
2. [选工具] 点击 "工具" 按钮
3. [选 DR] 点击 "Deep Research" 菜单项
4. [注入文本] JS: execCommand('insertText') 到 .ql-editor
5. [发送] 点击发送按钮（蓝色箭头）
6. [等计划] 等待研究计划生成（~10-30秒）
7. [确认] 点击 "开始研究" 按钮 ← Gemini 独有步骤！
8. [等完成] 轮询：停止按钮消失 + 出现 "分享和导出" 按钮（~2-5分钟）
9. [导出] 点击 "分享和导出" → "导出到 Google 文档"
10. [等跳转] 等待新 tab 打开 Google Docs（~5-10秒）
11. [下载] Google Docs: 文件 → 下载 → Markdown (.md)
12. [归档] cp ~/Downloads/xxx.md → docs/research/
```

**所有步骤均可自动化 ✅**

### 普通对话模式

```
1. 点击输入框 → execCommand 注入文本
2. 点击发送
3. 等待回复完成（停止按钮消失）
4. 使用 "复制内容" 或 read_page 提取
```

## 等待完成的轮询策略

```javascript
// 检查研究是否完成
// 方法 1：检查停止按钮是否消失
const stopBtn = document.querySelector('button[aria-label="停止"]');
const isRunning = !!stopBtn;

// 方法 2：检查 "分享和导出" 按钮是否出现（更可靠）
// 通过 read_page filter=interactive 查找 "分享和导出" 文本
```

## 文件上传

Deep Research 模式下有专门的「文件」按钮：
- 点击 `button "文件"` 打开文件上传
- 支持上传参考文档
- 也可通过 `+` 按钮上传

> ⚠️ 文件上传的 DataTransfer API 注入方式待验证（本次未实测）。

## 与 ChatGPT / Claude.ai 对比

| 特性 | ChatGPT | Claude.ai | Gemini |
|------|---------|-----------|--------|
| 文本注入 | `execCommand` ✅ | 待验证 | `execCommand` ✅ |
| 编辑器类型 | contenteditable div | textarea/contenteditable | Quill `.ql-editor` |
| Deep Research 入口 | 侧栏/菜单 | `+` 菜单 → Research | 工具 → Deep Research |
| 计划确认步骤 | ❌ 无 | ❌ 无 | ✅ 有（开始研究/修改方案） |
| 报告提取 | API 提取法 | Artifact 原生下载 | Google Docs 中转下载 |
| 提取复杂度 | 高（需 auth token） | 低（同源 blob URL） | 中（两跳：导出+下载） |
| 下载格式 | Blob → .md | blob URL → .md | Google Docs → .md |
| 文件命名 | 自定义 | `compass_artifact_*.md` | `{文档标题}.md` |

## 已知限制

1. **两跳导出**：必须先导出到 Google Docs，再从 Docs 下载 Markdown — 无法直接从 Gemini 下载
2. **Google Docs 加载时间**：导出后新 tab 加载 Google Docs 需要 5-10 秒
3. **"复制内容" 格式问题**：铲屎官提到直接复制有格式问题，建议走 Google Docs 路径
4. **研究计划确认**：比 ChatGPT/Claude 多一步交互（自动化时需要处理）
5. **Deep Research 模式粘滞**：和 ChatGPT 类似，选了 Deep Research 后输入框保持该模式

## Gemini 特有 UI 元素

- **来源按钮**（Deep Research 模式）：可以选择搜索来源（Google 搜索等）
- **研究进度面板**：右侧面板实时显示思考过程 + 研究的网站列表
- **"显示思考过程"**：类似 ChatGPT 的 "thinking"，可展开/收起
- **模式选择器**（右下角）：显示当前模式（"快速"/"Pro" 等）

## 制作图片（2026-03-10 实测验证 ✅）

### 流程

```
1. 工具 → 制作图片（或首页快捷按钮）
2. [可选] 选择风格预设（单色/色块/绚彩/哥特风黏土/沙龙等）
3. execCommand 注入 prompt 到 .ql-editor
4. 点击发送（蓝色箭头）
5. 等待生成（~15-30秒，显示 "Refining the Details"）
6. 点击图片 → 灯箱模式（dialog "以灯箱模式显示的放大版图片"）
7. 点击 button "下载完整尺寸的图片" → PNG 下载
```

### 灯箱模式选择器

| 元素 | ref / 说明 |
|------|-----------|
| `button "分享图片"` | 分享 |
| `button "复制图片"` | 复制到剪贴板 |
| `button "下载完整尺寸的图片"` | **下载 PNG** |
| `button "关闭"` | 退出灯箱 |

### 下载文件命名

`Gemini_Generated_Image_{hash}.png`（~7MB PNG）

### 注意

- 制作图片模式会**粘滞**（和 Deep Research 一样）
- 风格选择器是可选的——不选也能生成
- 图片右下角有 Gemini ✦ 水印
