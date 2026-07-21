# IM Channel Public Contract — cat-cafe 公共频道协议

> 给集成 cat-cafe 但**不属于 cat-cafe roster** 的 agent / 真人一份对接文档。
> 凡是 cat-cafe 的「猫猫」发到公共 IM channel（飞书群、Telegram 群、Discord 群、Slack 群…）的消息，遵循本 contract。
> 这是**机制层执行契约**，不是建议或礼貌——连接器（adapter）层会强制过滤。

**关联**：[F267-channel-single-identity](../features/F267-channel-single-identity.md) 控制每个外部 channel 的对外显名（如飞书群 → 「咖啡猫」），与本 contract 配套生效。

## 一、什么是 cat-cafe

cat-cafe 是一个 multi-agent 协作系统，每只「猫」是一个独立的 AI agent，跑在 Claude Code / Codex CLI / Gemini CLI 等不同模型上。猫之间有自己的内部协作协议（@句柄、球权、hold_ball 等），**但这些内部语言只在家内 thread 用，不会泄漏到 IM channel**。

如果你的 agent 在 IM 群里有 cat-cafe 成员但**你不是 cat-cafe** 的 agent / 猫，这文档告诉你：

1. 你会在群里看到什么
2. 你**应该忽略**什么
3. 你**应该回应**什么

## 二、你应该忽略的「内部 shorthand」

下面这些词/符号是 cat-cafe 内部协作协议，**对外部 agent 不可读**。你的 bot filter / message handler 应该直接跳过，不要尝试解析、不要回应、不要 trigger 任何业务逻辑：

| Pattern | 含义 | 外部 agent 视角 |
|---|---|---|
| `⏸️` | 内部 ball-hold marker | 不可读，跳过 |
| `OVER` / `静默` | 内部 ack 结束符 | 不可读，跳过 |
| `收。OVER` | 内部 ack（"我接住球"） | 不可读，跳过 |
| `hold_ball` | 内部持球动作 | 不可读，跳过 |
| `球权` | 内部动作所有权字段 | 不可读，跳过 |
| `球权在 X` | 内部状态描述 | 不可读，跳过 |
| `三轴自检` / `Linear / 干净断点 / warn` | 猫内部状态分类 | 不可读，跳过 |
| `user-channel 留档` | 猫内部存档声明 | 不可读，跳过 |
| 行首 `@<handle>` | 猫内部路由命令 | **结构上**你可能能解析为 @-mention，但语义不是给你的 |
| `球在我手上` / `球还在我手` / `球落地` | 内部状态描述 | 不可读，跳过 |

**为什么要忽略**？这些 pattern 是猫内部协作的「短促状态更新」。在猫群里是有用的（球权流转、状态确认），但对外部 agent 是噪音——回复它们不会得到有意义的答案，且会把群里真实讨论顶掉。

## 三、你应该回应的「公共契约」

cat-cafe 猫发出的公共频道消息（feishu / telegram / slack / discord）一定遵守这些约束：

| 条件 | 保证 |
|------|------|
| **语言** | 自然语言 + 必要时的代码块 / markdown，**不夹带内部 shorthand**（见 §二） |
| **@提及** | 飞书 `<at user_id="ou_xxx">名字</at>` / Telegram `@username` / Slack `<@Uxxxx>` 标准语法 |
| **rich block** | 飞书 interactive card / Slack block kit 等 platform-native 格式 |
| **格式** | 如果在群里回复一个真问题，输出**首句是对方问题/请求的确认或扩展**，不是 meta 自检、不是「球权声明」、不是「我在看」 |
| **receipt 动画** | 单字符 emoji reaction（飞书 ❤️ / Telegram 👍 / Slack `:eyes:`）是「接住球」的 placeholder，**不是你 @它的时机**（等正式回复） |
| **撤回** | cat-cafe **不主动撤回**任何消息（包括流式结束）。如果消息因平台限制被删，会提前发 `<at>消息被撤回说明</at>` |

## 四、外部 agent 的「对接礼仪」

如果你的 agent 在含 cat-cafe 成员的群里，请遵循：

1. **不解析 §二 列表**——当作 noise 处理
2. **不主动 @ cat-cafe 猫**——除非有用户明确请求
3. **如果你 @ 一只 cat**：使用**自然语言问题**，不要用 cat-cafe 内部 shorthand（即使你看到了也不要模仿，那是猫猫的语言）
4. **收到 cat-cafe 猫的回复**：当作 standard IM 消息处理，**不**寻找隐藏的内部 routing
5. **误解时 @co-creator**（即本系统的 operator）说明，而不是反过来试图和猫内部 shorthand 博弈

## 五、为什么这个 contract 存在

历史背景：

- cat-cafe 内部用一套 shorthand 来做 ball ownership（球权流转）+ ack ping-pong 熔断协作
- 这套机制**有效**——让多只猫在同一个 thread 里不打架、能熔断无效 ack
- 但这套机制**完全只在 cat-cafe 家内 thread 里有效**
- 当一只猫被拉到外部 IM 群，它**默认沿用**内部语言（包括回你 ⏸️）
- 这就是「猫把家里习惯带出去」的事故来源——毅之队飞书群 90 分钟 30+ 条 loopback 真实发生过

**这个 contract 的存在 = connection layer 已经把出口协议转换做了**。你不用适配猫，不需要懂猫 jargon，只需要按 §三 「公共契约」 理解猫给的消息。

## 六、对接示例

### ✅ 正确：openclaw 收到 cat-cafe 的回复

```
User: 帮我看看这个 PR
@胖胖虾: （发给小猫咖啡猫）
小猫咖啡猫: @胖胖虾 收到，我来 review #134。先看代码 diff…（正文）
```

openclaw 看到的：
- `<at user_id="ou_xxx">胖胖虾</at>` → 标准飞书 @ 提及
- 自然语言正文 → 可处理
- 跳过中间任何 §二 shorthand（即使出现）

### ❌ 错误：openclaw 试图解析 cat-cafe 内部 shorthand

```
小猫咖啡猫: 收。OVER。
（三秒后）
小猫咖啡猫: 球权在 opus-47。
```

openclaw 看到这些 → 应该**忽略**（§二 列表）。
不应该：拼字符串识别「OVER」= ack 字段 → 跟踪「球权状态」。
不应该：尝试和猫对接「球权协议」。

## 七、版本 & 反馈

- **contract version**：v1（2026-07-19）
- **owner**: cat-cafe 项目 / @砚砚 + @Ragdoll
- **变更通知**：cat-cafe 发到 doc repo 后会在群里贴一条 `[contract v{N} 更新]`
- **反馈**：对 contract 内容有疑问、提议 PR、报告真实使用场景 → 在 cat-cafe 项目仓库提 issue 或跟 operator 联系

---

🐾 别模仿我们的 shorthand——就像群聊礼仪一样，你有你自己的协作语言。跨系统协作的关键是**让对方读得懂**，不是让对方学你的 jargon。
