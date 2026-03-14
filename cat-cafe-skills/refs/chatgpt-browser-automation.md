# ChatGPT 浏览器自动化参考

> 验证日期：2026-03-10 | 验证猫：Ragdoll Opus 4.6
> 工具：`mcp__claude-in-chrome__*`

本文档记录通过 Chrome MCP 操作 ChatGPT Web UI 的实测 DOM 知识。
deep-research skill 的 Step 2 浏览器自动化引用此 ref。

## 前置条件

- Chrome 安装了 Claude in Chrome 扩展并已连接
- 用户已登录 ChatGPT（Pro 账户）
- 调用前先 `tabs_context_mcp` 获取 tab 信息

## 模式一览

| 模式 | 激活方式 | Placeholder | 特征 |
|------|---------|-------------|------|
| **扩展版 Pro** | 默认（模型选择器） | "有问题，尽管问" | 深度思考 1-3 分钟 |
| **深度研究** | `+` → "深度研究" 或侧栏链接 | "获取详细报告" | 工具栏：深度研究/应用/站点 |
| **研究与学习** | `+` → "研究与学习" | "学习新知识" | 工具栏多 📖学习 标签 |

## GPT Pro 对话流程（已验证 ✅）

### Step 1: 注入文本

输入框是 contenteditable div，不是 `<input>`。

```javascript
const editor = document.querySelector('#prompt-textarea');
editor.focus();
document.execCommand('insertText', false, '你的提示词内容');
```

> ⚠️ 不能用 `editor.textContent = ...`，React 不会检测到变化。
> 必须用 `execCommand('insertText')` 触发 React 的 onChange。

### Step 2: 发送

点击发送按钮（紫色/蓝色圆形箭头，输入框右侧）。
可以用截图 + 坐标点击，或用 JS：

```javascript
// 发送按钮在输入框右侧，是最后一个带 data-testid="send-button" 的按钮
// 也可以直接用键盘：
// editor 聚焦时按 Enter 即可发送（Shift+Enter 换行）
```

### Step 3: 等待回复完成

Pro 模式思考时间 **1-3 分钟**。检测完成的方法：

```javascript
// 方法1：检查是否还有"停止生成"按钮
const isGenerating = () => {
  const stopBtn = document.querySelector('button[aria-label="停止生成"]');
  return !!stopBtn;
};

// 方法2：检查发送按钮是否恢复（非 stop 状态）
// 方法3：轮询截图观察
```

**轮询策略**：每 5 秒检查一次，最长等待 5 分钟（Pro 思考可能很久）。

### Step 4: 复制回复

```javascript
// 复制按钮有稳定的 data-testid
const copyBtns = document.querySelectorAll('[data-testid="copy-turn-action-button"]');
// 第 N 个按钮 = 第 N 条消息（用户和助手都算）
// 最后一个 = 最新的助手回复
const lastCopy = copyBtns[copyBtns.length - 1];
lastCopy.click();
```

### Step 5: 读取剪贴板

```javascript
navigator.clipboard.readText().then(text => {
  window.__clipResult = text;
});
// 下一个 JS 调用读取 window.__clipResult
```

> 剪贴板权限：在页面 context 下直接可读，无需额外授权。

## 深度研究模式（已验证 ✅）

### 激活

**方式 A**（通过加号菜单）：
1. 点击输入框左侧 `+` 按钮
2. 点击 "深度研究"
3. 确认：Placeholder 变为 "获取详细报告"，工具栏出现 `深度研究 ▾ | 应用 ▾ | 站点 ▾`

**方式 B**（通过侧栏）：
```javascript
document.querySelector('[data-testid="deep-research-sidebar-item"]').click();
```

**方式 C**（URL 导航）：
```
https://chatgpt.com/deep-research
```

### 文本注入 & 发送

与 Pro 模式完全相同（同一个 `#prompt-textarea`）。

### 深度研究特有流程（2026-03-10 实测）

深度研究比 Pro 多一个 **研究计划确认** 步骤：

```
1. 发送 prompt → GPT 生成 5 个研究子任务（带 checkbox）
2. 底部出现 "编辑" / "取消" / "开始 {倒计时}" 三个按钮
3. 倒计时结束或点"开始"后，正式开始研究
4. 研究过程：每个子任务有进度圆圈，底部显示"正在研究..."+ 进度条
5. 预计 5-15 分钟完成
6. 完成后产出报告卡片（DOM 结构待补充）
```

**自动化"开始"按钮**：
```javascript
// 研究计划出现后，找到"开始"按钮并点击
// 按钮文本是"开始"+ 倒计时秒数，如"开始 21"
// 也可以等倒计时自动触发（约 30 秒）
```

### 回复格式差异（2026-03-10 实测确认）

深度研究产出的是 **报告卡片**，不是普通文本回复。

**报告渲染方式**：报告内容在跨域 iframe 中渲染
- iframe origin: `connector_openai_deep_research.web-sandbox.oaiusercontent.com`
- 浏览器安全策略阻止从 `chatgpt.com` 访问 iframe 内容
- `copy-turn-action-button` 只能复制标题（如 "Phase 3"），不能复制报告全文

**✅ 已验证可行的提取方法（API 提取法）**：

```javascript
// 1. 获取 access token
const session = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
const token = session.accessToken;

// 2. 获取对话数据（含报告）
const convId = '对话ID从URL提取';
const data = await fetch('/backend-api/conversation/' + convId, {
  credentials: 'include',
  headers: { 'Authorization': 'Bearer ' + token }
}).then(r => r.json());

// 3. 从 mapping 中找到 report_message
// 报告在最大的 tool 角色消息的 widget state JSON 中
// 路径: widget_state.report_message.content.parts[0] = 完整 Markdown

// 4. 通过 Blob 下载保存
const blob = new Blob([reportMD], { type: 'text/markdown' });
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'report.md';
a.click();
```

关键发现：
- 报告内容存储在对话的 `tool` 角色消息中（widget state JSON）
- 路径：`mapping[key].message.content.parts[0]` → JSON → `report_message.content.parts[0]`
- 该 JSON 同时包含研究计划、搜索统计、引用信息
- `backend-api/conversation/{id}` 需要 Bearer token（从 `/api/auth/session` 获取）
- 不带 token 会 401，带 cookie 但不带 Authorization header 也会 401

**之前验证无效的方法**（留作参考）：
1. DOM `innerText` → 只返回 "ChatGPT 说：" 空壳（iframe 跨域）
2. `copy-turn-action-button` → 只复制标题片段
3. `iframe.contentDocument` → 跨域阻止
4. `get_page_text` → 只读主页面
5. 报告卡片下载/展开按钮 → Chrome MCP 的 click 无法穿透 iframe 内按钮

### ⚠️ 深度研究模式下发消息的陷阱

**模式会粘滞！** 在深度研究对话中，输入框默认保持深度研究模式。
如果想发普通追问（非研究），**必须先切换模式**：
1. 点击输入框工具栏的"深度研究 ▾"下拉
2. 切换到普通模式
3. 再发消息

否则追问也会触发新的深度研究（消耗 quota！）。

## 文件上传（已验证 ✅）

### 程序化注入（不需要原生文件对话框！）

```javascript
// DOM 中有一个隐藏的 file input，accept="" 接受所有文件类型
const fileInput = document.querySelectorAll('input[type="file"]')[0];

// 用 DataTransfer API 创建文件
const content = fs.readFileSync('docs/research/xxx.md', 'utf-8'); // 在猫端读
const file = new File([content], 'research-context.md', { type: 'text/markdown' });
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
fileInput.files = dataTransfer.files;

// 触发 React change 事件
fileInput.dispatchEvent(new Event('change', { bubbles: true }));
```

### 文件 input 清单

| Index | ID | Accept | 用途 |
|-------|-----|--------|------|
| 0 | (none) | `""` (全部) | **通用文件上传**（.md/.txt/.pdf 等） |
| 1 | `upload-photos` | `image/*` | 图片上传 |
| 2 | `upload-camera` | `image/*` | 相机拍照 |

### 注入后的 UI 表现

- 文件卡片出现在输入框上方（图标 + 文件名 + "文件" 标签 + ✕ 删除）
- 发送按钮变为可用状态（蓝色）
- 可以同时注入文本 + 文件

## 完成检测选择器速查

| 元素 | 选择器 | 用途 |
|------|--------|------|
| 输入框 | `#prompt-textarea` | 文本注入 |
| 发送按钮 | 输入框右侧圆形按钮 | 发送消息 |
| 停止按钮 | `button[aria-label="停止生成"]` 或黑色方形 | 检测是否在生成 |
| 复制按钮 | `[data-testid="copy-turn-action-button"]` | 复制回复内容 |
| 通用文件 input | `document.querySelectorAll('input[type="file"]')[0]` | 文件上传 |
| 深度研究入口 | `[data-testid="deep-research-sidebar-item"]` | 切换模式 |
| 模型选择器 | `button` aria-label="模型选择器" | 切换模型 |

## 已知限制

1. **原生对话框不可控**：macOS Finder 弹窗超出 DOM，无法通过 Chrome MCP 操作
   - ✅ 解决：用 DataTransfer API 程序化注入，完全绕过原生对话框
2. **Pro 思考时间不可预测**：1-3 分钟，需要轮询等待
3. **✅ 深度研究报告可通过 API 提取**：虽然 iframe 跨域阻止 DOM 访问，但可通过 `backend-api/conversation/{id}` + Bearer token 获取完整报告 Markdown。详见"回复格式差异"节
4. **session 过期**：长时间不操作可能需要重新登录
5. **Gemini contenteditable**：execCommand 不生效，需要其他方案（见 deep-research SKILL.md）

## 完整自动化流程

### GPT Pro 模式（全自动 ✅）

```
1. tabs_context_mcp → 找到或创建 ChatGPT tab
2. navigate → chatgpt.com（新对话，默认 Pro 模式）
3. (可选) JS 注入文件 → DataTransfer API
4. JS 注入 prompt 文本 → execCommand('insertText')
5. 点击发送 / 按 Enter
6. 轮询等待完成（检查停止按钮消失，每 5s，最长 5min）
7. 点击复制按钮 → 读剪贴板 → window.__clipResult
8. 将内容写入 docs/research/YYYY-MM-DD-{topic}/chatgpt/report.md
```

### 深度研究模式（全自动 ✅）

```
1. tabs_context_mcp → 找到或创建 ChatGPT tab
2. navigate → chatgpt.com/deep-research 或侧栏点击激活
3. (可选) JS 注入文件 → DataTransfer API
4. JS 注入 prompt 文本 → execCommand('insertText')
5. 点击发送 / 按 Enter
6. 等研究计划出现 → 点"开始"或等倒计时（约 30s）
7. 轮询等待完成（5-15 分钟）
8. JS: fetch('/api/auth/session') → 拿 accessToken
9. JS: fetch('/backend-api/conversation/{id}', {headers: {Authorization: 'Bearer '+token}})
10. 解析 JSON: 找最大 tool 消息 → widget state → report_message.content.parts[0]
11. Blob 下载 → 猫用 cp 移到 docs/research/YYYY-MM-DD-{topic}/chatgpt/report.md
```

## 图片生成（2026-03-10 实测验证 ✅）

### 入口

- **专用页面**：`chatgpt.com/images`（左侧栏「图片」）
- **对话中**：直接描述要画的图，GPT-4o 自动调用 DALL-E

### 流程（/images 页面）

```
1. 导航到 chatgpt.com/images
2. execCommand 注入 prompt 到 #prompt-textarea
3. 按 Enter 发送
4. 等待生成（~10-20秒）
5. 点击图片 → 灯箱/编辑器模式
6. 右上角「保存」按钮下载 PNG
```

### 图片交互选择器

**对话内（hover 图片时）**：

| 元素 | 选择器 |
|------|--------|
| 下载 | `button "下载此图片"` |
| 喜欢 | `button "喜欢此图片"` |
| 不喜欢 | `button "不喜欢此图片"` |
| 分享 | `button "分享此图片"` |

**灯箱/编辑器模式（点击图片后）**：

| 元素 | 说明 |
|------|------|
| 「保存」按钮 | 右上角，下载 PNG |
| 「选择区域」 | 局部编辑（inpainting） |
| 「分享」 | 右上角分享按钮 |
| `...` 按钮 | 更多选项 |
| `textbox`（描述编辑） | 底部输入框，可文字修改图片 |
| `button "关闭"` | 退出编辑器 |

### 风格预设

图片页面有预设风格卡片（漫画风潮、繁花之驱、鎏金塑像、蜡笔画风、时尚追踪等），可点选后再输入 prompt。

### 下载文件命名

`ChatGPT Image {年}年{月}月{日}日 {HH_MM_SS}.png`（~1MB PNG）
