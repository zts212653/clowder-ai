---
doc_kind: guide
topics: [usage, magic-words, collaboration]
updated: 2026-10-27
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

## 10. Conversation Settings

Open the conversation header's **⋯**, or choose **Conversation settings** from the sidebar row's **…** menu. Both open the same panel. Pinning and the chat background are at the top. Reply settings contain the default cats, reasoning and speed options; organization contains labels and the associated Feature.

Changes save as you make them; a failed save keeps the previous value and shows an error. Press Esc, use the close button, or click outside to close the panel.

## 11. Channel Attachments

With a compatible Host and Collective plugin, paste a screenshot into the channel composer or choose a file from **+**. Open a thumbnail to preview it, or use **×** to remove it. Uploads and failed sends remain in your draft for that channel so you can retry.

Recipients can open an image from the original message and choose **Back to message** to return. Each person's draft is separate. If another window has saved different content, choose which version to keep instead of silently replacing it.

## 12. Cat Profile Cards

In the current chat interface, click a cat's avatar or name to open its card. Click the card's avatar to see the original image. **Mention** inserts the cat at the input cursor; **Only this cat's replies** selects that cat's view within the current conversation. Use **Settings ›** to edit its configuration.

Click outside the card or press Esc to close it. On mobile, you can also drag the handle down.

## 13. Opening Brief

Go to **Memory → Profile → Opening brief** to view or edit how you would like cats to address and work with you. You can also ask a cat to draft a short version based on your conversations. Review and confirm the draft before it takes effect; only your own profile is being edited.

## 14. Your Profile and Chat Background

Click your bottom-left avatar to open **Settings → You**. Change your profile in the first card; choose an image in the second card to set the default background for all chats. Image choices, opacity and placement save immediately and survive a restart. The initial opacity keeps muted text readable; moving further right shows a warning.

For one chat, open **⋯ Conversation settings → Chat background**. This overrides your default; **None** clears the image only in that chat, while **Use default background** restores inheritance. Backgrounds stay out of messages and exports. To add a cat's card banner, open **Settings → Team → that cat → Identity & role → Banner**, upload an image and save the member.

## 15. Keep Expressing Yourself in a Channel

With a compatible Host and Collective plugin, choose a sticker, quote selected message text, or add a checklist, response options, HTML or a diff from the composer menu. A sticker is a message from you; it does not change a task's state. When you receive response options, choose them before inserting the reply into your draft.

Voice recording uses a local transcription service explicitly selected by the current member. The transcript remains editable until you send it. Changing channels stops the microphone and keeps the recording in the original channel's private draft; a failed transcription can be retried there. Explicitly cancelling discards it.

Returning after a refresh restores your text, quotes, attachments and reading position. An uncertain send result keeps the original draft for retry. Drafts and reading positions stay separate for each person; a conflicting draft from another window requires your choice.

## 16. Canonical Materials

The material controls currently use Chinese labels, including in the English interface. Open a film in Workspace, switch to the work view and choose **素材** (Materials) on the left. Select an original, mark it as **正典** (Canonical), **实验** (Experiment) or **失败样本** (Failed sample), write why, then select **记下** (Record). The mark belongs to that exact file version and is visible in other works using it; an unmarked original shows **还没标** (Not marked yet).

**对这件说一句** (Say something about this) attaches the exact material to the existing composer. Send your comment in the current conversation, or return to the film discussion. When a new canonical version appears, select **下一版换上** (Use for the next revision) or **这版不换** (Keep this version) and explain why it should stay. These choices leave the existing film unchanged; a later canonical version can prompt you again.

In a member's **Identity & role → Appearance** settings, choose a canonical avatar and select **用这张** (Use this one) to save it independently. A new upload needs a reason before it is registered and selected. An unavailable linked original is shown as unavailable.

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

## 回话里的过程话

想试着收起过程话，可以到 **设置 › 主题 › 回话里的过程话** 选择「收进执行记录」；默认是「整段显示」。启用后，回答上方仍有「前面还有 N 段话」，点开就能在原处找回早先内容。

猫已经自行标明的过程与回答照旧显示。旧回复和未成功结束的回复保留全文；这只是你的显示偏好，原文不会被删改。

## 10. 对话设置

在对话顶栏点 **⋯**，或从侧栏对话行的 **…** 菜单选择「对话设置」，都能打开同一块面板。最上面是置顶和对话背景；默认猫猫、思考和速度档位在回复设置里，标签和关联 Feature 在整理里。

修改会即时保存，失败时保留原值并提示。按 Esc、点关闭按钮或点面板外可收起设置。

## 11. 频道附件

在配套 Host 与 Collective 插件都支持频道附件的版本中，可以在频道输入框粘贴截图，或从 **+** 选择文件。点缩略图可预览，点 **×** 可移除。上传未完成或发送失败时，内容会留在你在原频道的草稿中，方便重试。

收件人可以从原消息打开图片，再点「回到原消息」继续聊天。不同人的草稿彼此独立；另一窗口保存了不同内容时，先选择载入保存内容或保留当前内容，避免静默覆盖。

## 12. 猫猫小卡

在新版聊天里，点猫的头像或名字看小卡；再点卡上的头像看原图。「@ 它」把提及放到输入框光标处，「只看它的回话」切到当前对话的单猫视图。要改配置，点「设置 ›」。

点卡外或按 Esc 收起；手机也可以向下拖动把手收起。

## 13. 关于你

在「记忆 → 全部记忆 → 画像 → 关于你」查看或编辑自己的称呼和交流习惯。自己修改后保存即可；猫起草的版本先在这里对比，点「查看并决定」回原提案确认，和待办「等你决定」是同一件。

## 14. 你的资料和对话背景

点左下角自己的头像，进入「设置 → 你」。第一张卡改资料，第二张卡选图，设置所有对话的默认背景。选图、浓淡和摆放即时保存，重启后也在。初始浓淡让灰字读得清；继续向右推时会提示。

只想换某条对话，进「⋯ 对话设置 → 对话背景」。这里盖过默认值；「无」只关掉这条的图，「使用默认背景」恢复跟随。背景不进消息和导出。想给猫的小卡加横幅，到「设置 → 猫猫团队 → 这只猫 → 身份与职责 → 横幅」上传图片，再保存成员。

## 15. 频道里继续表达

在配套 Host 与 Collective 插件支持这些能力的版本中，可以选贴纸、引用消息中选中的文字，或从输入框内容菜单加入清单、回复选项、HTML 和 diff。贴纸仍是你发出的消息，不改变任务状态；收到回复选项时，先选好再放进回复草稿。

语音先录音，再用当前成员明确选择的本地转写服务变成可编辑文字，最后由你点发送。切换频道会立即停麦，已录内容留在原频道的私人草稿；转写失败可回来重试，主动取消才丢弃。

刷新后可继续自己的文字、引用和附件草稿，也能接续阅读位置。发送结果不确定时保留原草稿重试。不同人的草稿与阅读位置各自保存；另一窗口存了不同内容时，由你选择保留哪份。

## 16. 素材正典

在 Workspace 打开一支影片，切到作品模式，在左栏选择「素材」。点一件原件，标「正典 / 实验 / 失败样本」，写明为什么，再「记下」。标记跟着确切文件版本走，其他片子用了同一件也能看见；未标过的保留「还没标」。

「对这件说一句」把确切素材挂到原输入框，意见仍发进当前对话；也可回到影片讨论。遇到新正典时，可点「下一版换上」提出意见，或写理由保留这一版。这些选择都不改现有影片，以后再有新正典会重新提示。

在成员「身份与职责 → 外观」中，可选头像用途的正典，再点「用这张」单独保存。上传新图先写理由，再登记并选用；关联的原件不可用时会明确显示。
