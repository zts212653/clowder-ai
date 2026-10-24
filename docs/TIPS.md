---
doc_kind: guide
topics: [usage, magic-words, collaboration]
updated: 2026-10-24
description: "User tips for course correction, routing, chat file links, and everyday collaboration."
---

# Tips / 使用小 Tips

[English](#english) | [中文](#中文)

---

<a id="english"></a>

Quick tips for getting the most out of your Clowder AI team.

## 1. Magic Words — Course Corrections

Use these words to correct a cat's direction. Except for the emergency stop, the cat should correct its approach and continue your task.

| Say | What happens |
|-----|-------------|
| **星星罐子** (star jar) | Emergency stop: no new commands, file writes, or pushes. The cat waits for your instructions. |
| **脚手架** (scaffolding) | Checks the original request and completes the real user journey. An explicitly requested prototype stays a prototype. |
| **第一性原理 / 数学之美** (first principles / mathematical beauty) | Reconsiders the goal and necessary constraints, then removes needless layers. Both names mean the same thing. |
| **补锅匠** (patching one symptom at a time) | Finds the root cause and fixes affected related cases, without turning it into an unlimited rewrite. |
| **四象限 / unknown-first** | Tests the unknown most likely to overturn the current plan, using counterexamples or real use. No mandatory worksheet. |
| **钛合金裤衩子 / 钛合金内裤** (titanium underwear) | Removes needless restrictions and uses an available path to continue. Facility faults go to their owner; a real human decision is brought directly to you. |

> Only your current corrective instruction triggers these meanings. Quoting or discussing a word does not. The old dedicated triggers 绕路了, 喵约, 下次一定, 我能猜出来 and 碎片够了 are retired; ordinary requests using them are still understood in context.

## 2. @Mentions — Route to Any Cat

To ask a specific cat to take action, write `@catname` **at the start of a new line**:

```
I think this approach works.
@sonnet
Please implement this quickly.
```

Inline mentions (mid-sentence) don't trigger routing. To mention multiple cats, put each on its own line.

Common mentions:
- `@opus` — deep architecture, system design, complex reasoning
- `@opencode` — reliable multi-provider coding, tool orchestration, open-source ops
- `@sonnet` — fast and flexible, great for everyday tasks
- `@codex` — code review, bug hunting, implementation
- `@gemini` — aesthetics, UX design, creative direction

## 3. @owner / @co-worker — Your Cat Needs You

When a cat writes `@owner` or `@co-worker`, it's escalating a decision to you — the operator (Chief Vision Officer). This means the cat has hit something it can't decide on its own: priorities, architecture direction, product intent, or a go/no-go call.

## 4. Chat Platform Commands

Managing conversations from Feishu (Lark):

| Command | What it does |
|---------|-------------|
| `/new` | Start a new conversation |
| `/threads` | List all conversations |
| `/use <id>` | Switch to a specific conversation |
| `/where` | Show which conversation you're in |

Voice messages and file transfer are supported both ways.

> Telegram adapter is in progress — same commands will apply.

## 5. Rich Messages — More Than Text

Tell cats what you want and they'll reply in the right format:

- **"发语音"** / **"voice"** — audio message (each cat has a unique voice)
- **"发个卡片"** / **"show me a card"** — structured card for decisions, comparisons
- **"给我看看"** / **"show me"** — screenshots, checklists, code diffs
- **"庆祝一下"** / **"celebrate"** — try it and see :)

## 6. Voice Companion — Hands-Free Mode

Working out? Commuting? Turn on Voice Companion from the header and talk to your team through AirPods.

- One-tap activation
- Each cat has its own distinct voice
- Replies auto-play in sequence — no tapping needed
- Push-to-talk input via speech-to-text

## 7. operator Bootcamp — Guided Onboarding

First time here? Start a new thread and your AI team will walk you through a complete feature lifecycle — from expressing your vision to shipped code. No prior experience needed.

## 8. Cats Have Memory

Your cats remember past decisions, discussion conclusions, and lessons learned across conversations. You can say things like "we discussed this before" or "what did we decide about X" — the cat will search its knowledge base automatically. No need to re-explain context from previous sessions.

## 9. Chat Paths and Links

Click a recognized file label in a message to read it in the Workspace on the right. Relative paths use the conversation's project. A line suffix such as `docs/report.md:42` opens that line; a folder opens in the file tree. Paths in fenced code blocks remain plain code.

- A label inside a sentence stays compact; a file on its own line becomes a card. Hover or right-click a file label to see and copy its full path. Where the platform supports it, the menu also reveals the file in the file manager.
- Images open in a floating viewer. A locally matched commit or pull request opens its changes in the Workspace; other web links open in the browser.
- Document tabs and their existing file actions remain available after opening a label. Office files that cannot be previewed offer the available local-file actions instead.
- An unavailable file has a gray dashed label. If a reference cannot be resolved, it remains readable text rather than pretending to be an available file.

---

<a id="中文"></a>

让你更好地使用 Clowder AI 团队的实用小技巧。

## 1. Magic Words — 纠偏词

用这些词指出猫当前的偏航。除紧急停止外，猫应纠正做法后继续原任务。

| 说 | 猫猫会 |
|----|-------|
| **「星星罐子」** | 立即停止新增操作，不发命令、不写文件、不 push，等你指示。 |
| **「脚手架」** | 对照原托付补齐真实使用路径；明确要求的原型仍按原型范围交付。 |
| **「第一性原理／数学之美」** | 回到目标与必要约束，删去说不清必要性的层次和机制；两个叫法是同一含义。 |
| **「补锅匠」** | 追根因、修复受影响的同类问题并验证，不无界扩成全仓重构。 |
| **「四象限／unknown-first」** | 先验证最可能推翻方案的未知，用反例或真实使用发现盲区，不以填表代替探索。 |
| **「钛合金裤衩子／钛合金内裤」** | 去掉无必要限制、沿可用路径推进；设施故障交负责人，真需你决定就直接提醒你。 |

> 仅你当前的纠偏指令触发；引用、复述、讨论词义不触发。旧的「绕路了」「喵约」「下次一定」「我能猜出来」「碎片够了」已退役专用流程，日常表达仍按上下文理解。

## 2. @提及 — 指哪打哪

想让特定猫猫行动？**另起一行、行首**写 `@猫名`：

```
我觉得这个方案可以
@sonnet
帮我快速实现一下
```

行中间的 @ 不会触发路由。多只猫各占一行。

常用提及：
- `@opus` — 深度架构、系统设计、复杂推理
- `@opencode` — 可靠的多模型编码、工具编排、开源运营
- `@sonnet` — 快速灵活，适合日常任务
- `@codex` — 代码审查、找 bug、实现落地
- `@gemini` — 审美、UX 设计、创意方向

## 3. @owner / @co-worker — 猫猫在请求你拍板

看到猫猫写 `@owner` 或 `@co-worker`，说明它遇到了需要你决策的事 — 优先级、架构方向、产品意图、或者 go/no-go。这是猫猫主动升级，不是闲聊。

## 4. 聊天平台命令

在飞书中管理对话：

| 命令 | 作用 |
|------|------|
| `/new` | 开新对话 |
| `/threads` | 列出所有对话 |
| `/use <id>` | 切换到某个对话 |
| `/where` | 看当前在哪个对话 |

语音消息和文件互传双向支持。

> Telegram 适配器开发中 — 届时支持相同命令。

## 5. 富消息 — 不只是文字

直接说意图，猫猫会用合适的形式回复：

- **「发语音」** / **"voice"** — 语音消息（每只猫有独特声线）
- **「发个卡片」** / **"show me a card"** — 结构化卡片，展示决策、方案对比
- **「给我看看」** / **"show me"** — 截图、清单、代码 diff
- **「庆祝一下」** / **"celebrate"** — 试试看会发生什么 :)

## 6. 语音陪伴 — 解放双手

在运动？在通勤？从标题栏一键开启语音陪伴，戴上 AirPods 跟团队对话。

- 一键开启
- 每只猫有独立声线
- 回复自动排队播放，不用点
- 按住说话输入（语音转文字）

## 7. operator 训练营 — 新手引导

第一次来？开个新对话，AI 团队会亲自带你走完一个完整的 feature 生命周期 — 从表达愿景到代码上线。不需要任何经验。

## 8. 猫猫有记忆

猫猫会记住历史决策、讨论结论和踩过的坑。你可以说"之前我们讨论过 XXX"或"我们当时对 X 是怎么决定的"，猫猫会自动搜索知识库。不需要重新解释上下文。

## 9. 聊天里的路径和链接

点消息里已识别的文件标签，就能在右边的 Workspace 继续读。相对路径按这条对话绑定的项目查找；`docs/report.md:42` 这类行号会定位到对应行，文件夹会在文件树里展开。代码块里的路径仍是普通代码。

- 句子里是一枚小标签，单独一行的文件是一张卡。悬停或右键点文件标签，可以查看和复制完整路径；平台支持时，也可在文件管理器中显示文件，macOS 对应 Finder。
- 图片在浮窗里看大图；匹配本地项目的提交号和 PR 在 Workspace 看改动，其他网址去浏览器。
- 打开标签后，原有文档标签和文件操作仍可用。不能直接预览的 Office 文件会提供当前可用的本地文件操作。
- 文件不在了，会显示灰色虚线标签。无法解析的引用保留可读原文，不冒充可用文件。
