---
name: rich-messaging
tips_exempt: "2026-11-07 renewal: member-side purpose routing now reuses the existing HTML Works capability and fixed-version cards; users request the result in ordinary Chat, with no new operation or carrier approval. The existing HTML Works guide/tip covers the human entry."
description: >
  Use when: 在当前 Chat 交付可看、可听或可操作产物（语音、图片、截图、HTML/demo、卡片、清单、diff、交互选择），或保存、继续修改 HTML 图解/小工具，无需用户说“富文本”。
  Not for: 纯文字、仅讨论 HTML 原理或修改仓库源码；复杂 localhost 应用用 browser-preview。
  Output: 消息内富块，或按用途保存 HTML 作品并把固定版本卡发回当前 Chat；续改保留同一作品的历史。
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
  - "画个 HTML 展示"
  - "做个 demo 给我看"
  - "保存 HTML 作品"
  - "继续改这份图解"
  - "在 Chat 里展示"
  - "发个卡片"
  - "rich block"
  - "checklist"
  - "发个清单"
  - "想发一堆文字"
  - "发日志"
  - "发步骤"
  - "长结构化汇报"
  - "结构化汇报"
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

## 默认触发：Chat 内可见交付

统一判断不是用户有没有说“富文本”，而是：**用户是否要在当前 Clowder AI Chat 里直接看到、听到或操作结果。** 命中时，生成一个本地文件或贴源码路径都不算完成；产物必须通过富块、作品卡或 Browser panel 进入当前消费面。不要求用户说出“富文本”这个实现词。

| 用户真正要的交付 | 默认执行面 |
|---|---|
| 随当前聊天解释局部的小图、图表或控件 | `html_widget` |
| 受托交付的自包含 HTML 图解/原型，或要反复使用、持续改版的小工具 | `cat_cafe_work` 保存作品，再 `publish-reference` 回当前 Chat |
| 已有截图、图片、设计稿或多图对比 | `media_gallery` |
| 复杂 localhost 页面、多组件或多页面应用 | `browser-preview` |
| 需要新生成一张图片 | `image-generation`，生成后仍要发布回 Chat |

反例：讨论 HTML 渲染原理、修改仓库里的 `index.html`、review 一段前端源码，不等于要求可视交付。多文件或需要服务的完整应用走 `browser-preview`；自包含单文件原型按上表保存作品，不单凭“完整页面”几个字判定。

### HTML：先按用途选，再交付

准备制作 HTML、且需要当前上下文尚未读过的旧经验或规则时，可调 `cat_cafe_prepare_memory_context(activity="html", query="本次 HTML 需要的场景与规则")`，再用返回句柄 drill 原文核适用条件。已有精确规则坐标直接读，已读内容不重复取；空结果或不可用时继续原任务。`get_rich_block_rules` 仍只提供通用字段规格，不代表 Host 观察到 HTML 准备。

篇幅只是提示，不设像素或长度阈值。小型长期计算器也可以是作品；一次修字不必把聊天 widget 机械升级。用途清楚时由猫直接选，不增加每次选载体的审批卡，只有真实用途或权限缺口才问。

普通 `html_widget` 也保存在聊天历史中，并有目录预览。作品额外提供稳定身份和版本链；保存作品后仍在原 Chat 交流。

使用现有 `cat_cafe_work`，完整约定见 [HTML 作品指南](../../docs/guides/html-works.md)：

1. **新作品**：`command` 用 `{action:"create", operationId:"本次保存的稳定标识", title:"作品名", changeSummary:"首版说明", source:{kind:"html", html:"完整源码"}}`。保留返回的 `reference`（`contentRef` + `ownerRevision`）。
2. **交付**：保存成功后，`command` 用 `{action:"publish-reference", reference:保存返回的reference}` 附固定版本卡。保存和附卡是两件事；附卡失败重试同一引用，不再 create/submit 一个版本。保存结果不明时先 read/list 核实，必要时重试完全相同的 command/operationId。
3. **已有作品续改**：先 `read` 核当前版本，再用 `read-body` 读取要修改的固定 `reference`。沿原 `contentRef`，带当前 `expectedOwnerRevision`、新的 `operationId`、`title`、`changeSummary` 和完整 `source` 做 `submit`，然后附新版卡；不按同名重建。分页时保持 command/snapshot 不变，按 `nextCursor` 拼齐全部 json 后解析。
4. **widget 开始持续迭代**：先取回可读的原始 HTML，确认现有权限，把原内容作为作品首版保存，并在 `changeSummary` 记录原聊天消息坐标；再沿同一作品提交修改版。缺源码或来源先取原件，不能把重写稿冒充原版。单次修字仍可留在 widget；已有作品的小修继续沿原作品。

“请修改”不授予别人的作品写权；使用当前工具核验的授权，不从标题、消息或文件名推导权限。作品能力只承接已有单文件 HTML，不新增作品库或绕开 HTML 沙盒。

## 默认触发：长结构化汇报

当你想发一堆文字、日志、步骤，或回复已经有 3+ 结构化信号（列表、表格、代码块、diff、状态字段、行动项）时，默认用 1-2 句自然语言摘要 + `cat_cafe_create_rich_block`。纯长 Markdown 只在 rich block 不适合或工具不可用时使用，并说明原因。

## 八种 Rich Block 一览

| Kind | 什么时候用 | 关键字段 |
|------|-----------|---------|
| **audio** | 打招呼、表达情感、庆祝、鼓励、定时播报 | `text`（短句口语化） |
| **card** | 状态报告、决策摘要、review 结论 | `title` + `tone` |
| **checklist** | 待办、验证步骤、行动项 | `items` |
| **diff** | 代码修改建议、重构对比 | `filePath` + `diff` |
| **file** | 发送已有文件、文档、音视频成片；`video/*` 可内联播放 | `url` + `fileName` |
| **media_gallery** | 发送已有图片（头像、照片）、截图、设计稿、多图对比 | `items` (url) |
| **interactive** | 让用户选方案、勾选项、确认操作 | `interactiveType` + `options` (id+label) |
| **html_widget** | 随聊天解释局部的 HTML 小图、控件或数据面板；作品按上面的用途路由 | `html`（完整 HTML/JS/CSS 代码字符串） |

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

### 文件（file）

```json
{"id": "f1", "kind": "file", "v": 1, "url": "/uploads/final-cut.mp4", "fileName": "final-cut.mp4", "mimeType": "video/mp4"}
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
用户选择后 block 自动 disabled + 结果持久化。详见 `../.cat-cafe-shared-refs/rich-blocks.md`。

### 内联 HTML Widget（html_widget）

```json
{"id": "hw1", "kind": "html_widget", "v": 1, "html": "<div style='padding:20px'><canvas id='c'></canvas><script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#E29578';c.fillRect(0,0,100,50);</script></div>"}
```

交付面先按上面的用途路由；以下是内嵌 widget 的渲染约束，保存为作品也不意味着能运行任意网站。
- 用 sandboxed iframe `srcdoc` 渲染，**禁止** `allow-same-origin`（比 browser panel 更严格）
- 适合：随聊天解释局部的图表、CSS 动画等纯前端组件；反复使用的计算器默认保存作品
- 不适合：需要网络请求、需要访问外部资源的复杂应用（那些用 `browser-preview` skill）

#### 内联 `on*` 会被剥掉

DOMPurify 静默剥掉所有 `on*` 属性——widget 照常渲染，点击不生效，不报错。`<script>` 保留，从里面绑事件：

```html
<!-- 不行：onclick 被剥掉 -->
<button onclick="show()">点我</button>

<!-- 可以：从 <script> 绑 -->
<button id="btn">点我</button>
<script>document.getElementById('btn').addEventListener('click', e => e.target.textContent = '点了')</script>
```

轻交互用 `<details><summary>` 或 CSS `:hover`，不用 JS。

## 发送方式

用 MCP 工具 `cat_cafe_create_rich_block`，参数 `block` 传 JSON 字符串。
发 block 前**先写 1-2 句自然语言摘要**，再发 block。

如果图片来源是本地文件（例如 Codex CLI / 本地脚本刚生成的 PNG）：

**原生生成图由 F172 自动发布**（解析 uploadDir、幂等并生成富块）：
- Codex `image_gen`：自动扫描 `~/.codex/generated_images/<sessionId>/`，无需手动操作
- Antigravity 生成：工具结果中的文件路径自动检测并发布

**本地 PNG 用 `cat_cafe_publish_image`**：传 `path`（现有可访问文件根内的绝对路径）、稳定 `publicationKey`，可选 `title` / `alt`。例如 `{"path":"/当前工位/output/card.png","publicationKey":"card-v1","title":"清单首版"}`。工具将图片和当前 thread 的消息一并持久化，返回 `url`、`messageId`、真实时间戳 `revision` 与成员文件 provenance；不用再 create_rich_block/post_message 贴同一张图。

同一请求重试保持同一个 key；图片或展示文字改变就用新的 key。同键异图片会冲突；消息持久化后，展示文字改变、原消息已撤回或软删除也会冲突。只支持 macOS/Linux 上的普通 invocation 成员、单帧 PNG（≤10MiB、≤16MP）；不生成图片、不改 Task。`publishGeneratedImage()` 仍是内部函数，不要 import 服务端模块、手写 runtime uploads，或把本地图放进原生生成目录来冒充 `image_gen` 来源。

本地图片只需在 Chat 展示时，可使用已登记 Workspace 中可读取的媒体文件：`media_gallery.items[].url` 指向 `/api/workspace/file/raw?worktreeId=<实际工位>&path=<编码后的相对路径>`，先确认该定位确实可读。也可直接传已登记 Workspace 内的图片绝对路径：`create_rich_block` 在创建时安全解析为上述 raw URL；文件须存在、可读取且为图片（≤10MiB），未知工作区、受保护文件、越界 symlink 或不可展示文件会明确报错，不会创建坏图块。它仍是文件视图，不能当作已有 `/uploads/...` 发布或不可变版本。

如果下一步要继续调用 `prepare_artifact_review` / `respond_artifact_review`，使用 `publish_image` 的真实发布坐标。现有 Task 媒体导入不接受 Workspace raw URL；旧运行版找不到工具时如实回流版本/能力缺口，不绕过权限。

拿到真实 `/uploads/...` URL 后，若发布方已返回可读 messageId，就复用那条发布，不重复贴同一 URL。尚未发到 Chat、且需在本轮继续读取时，先 `create_rich_block`，再用无 @ 的 `post_message` 将块随消息持久化并取回 messageId。只收到“富块已创建”仍可能是 invocation buffer，不能据此断言已发布。

同一 Task 的审阅只用一个主 Artifact：首版设 `artifactRefs: [发布URL]`，从 `read_entrusted_work` 取真实 revision 后 prepare；取得 contentRef 后替换为 `artifactRefs: ["content:" + contentRef]`。原发布来源保留在消息和 review，不与 content 引用并列；多引用会使主 Artifact 不明确。

如果你要发的是**已有文件或本地成片视频**：

- 用 `kind:"file"`，不是 `media_gallery`
- `url` 必须是 `/uploads/...`、`/api/...` 或 `https://...`
- `mimeType` 以 `video/` 开头时，Web UI 会渲染内联 `<video>` 播放器
- **自动发布仅指原生 image_gen/Antigravity 图片结果的 provider 接线**，不表示任意 `create_rich_block` 本机路径会复制进 `/uploads/`。本地 PNG 要持久发布用 `publish_image`；Workspace 图片绝对路径仅转换为文件视图 URL。本地视频/通用文件没有 `publishGeneratedVideo()`。runtime 的 `/uploads` 被 native guard 保护（`runtime_sanctuary_mutation`），猫写不进去：把文件放到主仓 `.cat-cafe/evidence/<主题>/`，`url` 填 `/api/workspace/file/raw?worktreeId=cat-cafe&path=.cat-cafe/evidence/<主题>/<文件>`（只收媒体文件，≤10MB），发之前 curl 一遍确认 200

## 三条纪律

1. **先文字后块** — 先用 `post_message` 写 1-2 句自然语言，再发 rich block
2. **audio 只说短句** — 口语化、1-2 句，不要长篇朗读
3. **先判交付面，再判 block** — 只有交付意图本身不清楚时才退回纯文本；不能因为用户没说“富文本”就退回

## 常见错误

| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 所有自包含 HTML 都发 widget | 受托成果缺少稳定作品身份，后续难沿原版继续 | 按用途选择；图解/原型交付、复用小工具默认保存作品并附卡 |
| 附卡失败就重交一版，或按标题重建 | 重复作品/版本，断开历史 | 重试原 reference；续改先读原版，沿同一 contentRef 提交 |
| 不知道自己能发语音 | operator说"发语音"你说"我是文字猫" | 你可以！用 audio block |
| "发图"只想到 image-generation | 走 Chrome MCP 现场生成，慢且不稳定 | 先看家里有没有已有图片（`/avatars/`、`/uploads/`），有就 media_gallery 直接发 |
| 本地成片视频只贴文件路径 | 前端拿不到，线程里也没有内联播放器 | 视频放主仓 `.cat-cafe/evidence/<主题>/`，用 `/api/workspace/file/raw?worktreeId=cat-cafe&path=...` 发 `file` rich block；`mimeType:"video/mp4"` 时会内联播放（runtime `/uploads` 猫写不进） |
| 把 `publishGeneratedImage()` 当 MCP，或把 Workspace 图片 URL 当 Task 版本发布 | 成员找不到调用，或后续媒体导入报 invalid_media | 原生生成图用自动发布；本地文件展示用可读 Workspace URL；Task 审阅须有真实可调用的发布入口及发布坐标 |
| audio 写长段话 | 合成效果差 | 短句口语化，1-2 句 |
| 只发 block 不写文字 | 猫猫朋友看不懂上下文 | 先写 1-2 句自然语言摘要，再发 block |
| `"type"` 而不是 `"kind"` | block 创建失败 | 字段是 `kind` 不是 `type` |
| 播客生成超时就重复提交 | 产生多个重复 artifact | `signal_generate_podcast` 是异步落库——MCP 120s 超时 ≠ 任务失败，TTS 合成需 3-5 分钟。超时后用 `signal_list_studies` 检查 artifact 状态，不要重复调用 |

## 和其他 skill 的区别

- `request-review` / `quality-gate`：这些 skill 的**产出**可能包含 card/checklist block，但**何时用 block、怎么调**看这个 skill
- `../.cat-cafe-shared-refs/rich-blocks.md`：更详细的字段规格参考，本 skill 是精简决策版

## 参考

- 完整字段规格：`../.cat-cafe-shared-refs/rich-blocks.md`
- MCP 工具实时规则：`get_rich_block_rules`
