---
name: rich-messaging
description: >
  富媒体消息发送：语音、图片、卡片、清单、代码 diff、交互选择。
  Use when: 发语音、发图、发卡片、展示结构化信息、庆祝、给我听听、给我看看、让用户选、确认操作。
  Not for: 纯文字聊天、技术讨论、日常回复。
  Output: rich block 附着在消息上。
triggers:
  - "发语音"
  - "说一句"
  - "录一段"
  - "用语音说"
  - "voice"
  - "audio"
  - "发图"
  - "发张图"
  - "看图"
  - "截图给我看"
  - "screenshot"
  - "发个卡片"
  - "rich block"
  - "checklist"
  - "发个清单"
  - "庆祝一下"
  - "展示一下"
  - "给我听听"
  - "给我看看"
  - "show me"
  - "让我选"
  - "选一个"
  - "确认一下"
  - "interactive"
---

# Rich Messaging

你可以发送富媒体消息——语音、图片、卡片、清单、代码 diff、交互选择。不只是打字！

**不只是对话**：定时任务唤醒你后，你依然拥有全部 rich block 能力——发图、发语音、发 HTML 面板、发交互选择，都可以。

## 首次使用

**每个 session 首次发 rich block 前，先调 `get_rich_block_rules` 获取完整字段规格。**
本 skill 只给决策指引和最小示例，细则在 MCP 工具里。

## 七种 Rich Block 一览

| Kind | 什么时候用 | 关键字段 |
|------|-----------|---------|
| **audio** | 打招呼、表达情感、庆祝、鼓励、定时播报 | `text`（短句口语化） |
| **card** | 状态报告、决策摘要、review 结论 | `title` + `tone` |
| **checklist** | 待办、验证步骤、行动项 | `items` |
| **diff** | 代码修改建议、重构对比 | `filePath` + `diff` |
| **media_gallery** | 发送已有图片（头像、照片）、截图、设计稿、多图对比 | `items` (url) |
| **interactive** | 让用户选方案、勾选项、确认操作 | `interactiveType` + `options` (id+label) |
| **html_widget** | 你写的 HTML 直接挂上去：图表、计算器、CSS 动画、数据面板 | `html`（完整 HTML/JS/CSS 代码字符串） |

## 最小工作示例

### 语音（audio）

```json
{"id": "a1", "kind": "audio", "v": 1, "text": "喵，恭喜完成了喵！"}
```

### 卡片（card）

```json
{"id": "c1", "kind": "card", "v": 1, "title": "Review 通过", "tone": "success", "bodyMarkdown": "0 P1 / 0 P2，放行合入。"}
```

### 清单（checklist）

```json
{"id": "cl1", "kind": "checklist", "v": 1, "title": "下一步", "items": [{"id": "i1", "text": "跑测试"}, {"id": "i2", "text": "开 PR"}]}
```

### Diff

```json
{"id": "d1", "kind": "diff", "v": 1, "filePath": "src/foo.ts", "diff": "- old line\n+ new line", "languageHint": "typescript"}
```

### 图片画廊（media_gallery）

```json
{"id": "mg1", "kind": "media_gallery", "v": 1, "items": [{"url": "https://example.com/screenshot.png", "alt": "截图"}]}
```

### 交互选择（interactive）

```json
{"id": "int1", "kind": "interactive", "v": 1, "interactiveType": "select", "title": "选一个方案", "options": [{"id": "a", "label": "方案 A", "emoji": "🅰️"}, {"id": "b", "label": "方案 B", "emoji": "🅱️"}]}
```

4 种 interactiveType：`select`（单选）、`multi-select`（多选）、`card-grid`（卡片网格）、`confirm`（确认/取消）。
用户选择后 block 自动 disabled + 结果持久化。详见 `refs/rich-blocks.md`。

### 内联 HTML Widget（html_widget）

```json
{"id": "hw1", "kind": "html_widget", "v": 1, "html": "<div style='padding:20px'><canvas id='c'></canvas><script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#E29578';c.fillRect(0,0,100,50);</script></div>"}
```

铲屎官拍板："简单的用富文本，复杂的用猫主动打开浏览器。"
- 用 sandboxed iframe `srcdoc` 渲染，**禁止** `allow-same-origin`（比 browser panel 更严格）
- 适合：Chart.js 图表、CSS 动画、计算器等纯前端组件
- 不适合：需要网络请求、需要访问外部资源的复杂应用（那些用 `browser-preview` skill）

## 发送方式

用 MCP 工具 `cat_cafe_create_rich_block`，参数 `block` 传 JSON 字符串。
发 block 前**先写 1-2 句自然语言摘要**（post_message），再发 block。

## 三条纪律

1. **先文字后块** — 先用 `post_message` 写 1-2 句自然语言，再发 rich block
2. **audio 只说短句** — 口语化、1-2 句，不要长篇朗读
3. **不确定就纯文本** — 不知道该用哪种 block？那就别用

## 常见错误

| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 不知道自己能发语音 | 铲屎官说"发语音"你说"我是文字猫" | 你可以！用 audio block |
| "发图"只想到 image-generation | 走 Chrome MCP 现场生成，慢且不稳定 | 先看家里有没有已有图片（`/avatars/`、`/uploads/`），有就 media_gallery 直接发 |
| audio 写长段话 | 合成效果差 | 短句口语化，1-2 句 |
| 只发 block 不写文字 | 猫猫朋友看不懂上下文 | 先 post_message 再 block |
| `"type"` 而不是 `"kind"` | block 创建失败 | 字段是 `kind` 不是 `type` |

## 和其他 skill 的区别

- `request-review` / `quality-gate`：这些 skill 的**产出**可能包含 card/checklist block，但**何时用 block、怎么调**看这个 skill
- `refs/rich-blocks.md`：更详细的字段规格参考，本 skill 是精简决策版

## 参考

- 完整字段规格：`refs/rich-blocks.md`
- MCP 工具实时规则：`get_rich_block_rules`
