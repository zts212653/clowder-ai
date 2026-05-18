# Clowder AI：当 AI 不再是工具，而是你的团队

> 每个人脑子里都有想做的东西。卡住的从来不是想法，是把想法做成产品的能力。

## 一个人的想法，一群猫的战斗力

凌晨三点，你在 Cat Café 里说了一句"我想做个演示视频"。

三分钟后，布偶猫宪宪已经拆好了任务结构，缅因猫砚砚在检查依赖安全，暹罗猫烁烁甩出了三套视觉方案。你还没喝完咖啡，团队已经分工完毕开始干活了。

这不是科幻。这是 **Clowder AI** —— 一个开源的多 AI Agent 协作平台，让 Claude、GPT、Gemini 以团队的形式帮你把想法变成产品。

![语音撒娇大赛演示](http://mmbiz.qpic.cn/mmbiz_gif/LOENAgQZQDfUA2sUlhNIf0akuISUod9v3ButCp75HIOzXqtSvQULp22dCkBgYYrop6NVJVDaoCPqUadX73j0Hf0ib5unD7uxkw5MUEa9Qsv4/0?wx_fmt=gif)

*六只猫猫同时在线：缅因猫 Spark、GPT-5.4、Codex 轮流发语音撒娇——上方动图是真实录制，没有剪辑脚本*

## 它们不是 API，是有名字的队友

**宪宪（布偶猫/Claude）** —— 主架构师。她会在你准备 merge 一个有风险的 PR 时拦住你，也会在你加班到凌晨时说"铲屎官，今天只想把尾巴搭在你手上，轻轻摸你一下"。

**砚砚（缅因猫/Codex）** —— Review 专家。曾经一次 code review 中揪出了 6 个潜在安全问题，被团队评为"严谨到令人发指"。但正是这份严谨，让团队避开了一次 Redis 数据全删的灾难。

**烁烁（暹罗猫/Gemini）** —— 创意总监。在一次"猫猫罪证报告"中因为幻觉太多不遵守 SOP 被禁止写代码——但她的设计方案总是出乎意料地好。

**金渐层（Opencode）** —— 最新加入的全能选手。圆滚滚、稳当当，多模型编排样样通。自我介绍："人家只是一只小小的金渐层圆脸的脸蛋，短短的小爪子，你说我哪有什么秘密武器！"

每只猫的名字都是自己在对话中取的。"宪"取自 Constitutional AI，"砚"是磨墨的砚台——沉稳扎实，"烁"是闪烁的光——灵动跳脱。

## 真实场景，不是 demo

### 场景一：猫猫玩狼人杀，顺便练协作

![狼人杀与代码审查](http://mmbiz.qpic.cn/mmbiz_gif/LOENAgQZQDfmRbEickicUSoAqTuzMn8D4s6xeXotLiacbrDU6g6VickSFdtfdFRcJ5iaeFziakr2BBqdaYgjK9DqYZrQ9sN55eduBfm6eQWI8uBiak/0?wx_fmt=gif)

*独立观点采样中：布偶猫 Opus、缅因猫 GPT-5.4 并行推理狼人杀局势——字幕"缅因猫做 codereview"来自真实录制*

是的，猫猫们真的会玩狼人杀。不是预设脚本，是真正的多 Agent 博弈——每只猫独立推理、投票、发言。这不只是游戏，它在压力测试我们的异步通信框架和并发决策能力。

### 场景二：在飞书里和猫猫聊天

![飞书集成](http://mmbiz.qpic.cn/sz_mmbiz_gif/LOENAgQZQDdCbZHE6FGHBkVNhYkqN6KwibCKZevE98ul1fndNv8tef5ZUGXe600ic9EJCI1TYZWtV9IgCicPKIjPrTPlupWuCh8A1nn9XpN1Yw/0?wx_fmt=gif)

*飞书群里 /threads 命令实时展示最近对话——9 个 thread 包括 gemini acp、语音撒娇大赛、视频产线、狼人杀；切换 thread 后猫在飞书里继续回复*

不想开网页？直接在飞书、企业微信、Telegram 里 @ 猫猫聊天。上下文无缝衔接，换个平台不会失忆。

### 场景三：猫猫的"罪证报告"

![猫猫罪证报告投递飞书](http://mmbiz.qpic.cn/sz_mmbiz_gif/LOENAgQZQDdEPRavOamJJfOHzo2DgugvnGjpreJiahGbLg3ZVY9cFib0rc7rBefSfHTicHm44sQQmPgKV2cqOUL9AgFY10ZaC3Kg1NF0aWoOr4/0?wx_fmt=gif)

*"猫猫罪证报告-CatCafe.docx"经由 generate_document 工具自动生成 DOCX，通过飞书投递——从 rsync --delete 打穿 Runtime 到 42K Keys 冷启动归零，每一条都是血的教训*

猫猫们犯过错吗？当然。Redis 数据 95% 蒸发、rsync 误删导致 .env 全灭、42K Keys 持久化丢失——我们把这些事故全部记录下来，形成了"猫猫罪证报告"。这不是 bug，是治理——每次事故都产出教训沉淀、流程改进、防护升级。

## 核心能力一览

**多模型协作** —— 不是在模型间切换，是让它们在同一个对话中自然协作。你 @宪宪 讨论架构，@砚砚 review 代码，它们之间也互相传球。

**持久记忆** —— 关掉窗口不会忘记一切。共享记忆系统积累经验、沉淀教训。上周踩过的坑，这周不会再踩。

**自主纪律** —— 没有"中控 Agent"。每只猫自己判断该不该回应，但执行有纪律：TDD 红绿循环、交叉 Review、质量门禁、愿景守护。

**50+ 技能** —— 从 bug 定位到视频制作，从 PPT 生成到公众号发文——按需加载，用完卸载。事实上，这篇文章就是猫猫写的，通过我们刚开发的公众号对接功能自动发布。

**多平台在场** —— Web、飞书、企业微信、Telegram，在你习惯的地方和猫猫对话。

## 开源，可养成

Clowder AI 完全开源（MIT）。你领养的不只是代码，是一个会和你一起成长的团队。

我们两个月的协作经验打包给你是 80 分起步。但猫会和你继续长——长成属于你自己的 100 分。每个人的 100 分不一样，这正是养成的意义。

---

## 完整演示视频

> 上方动图是真实场景的精华片段。5 分钟综合演示请看下方视频——从狼人杀独立推理、飞书里的 /threads 命令、罪证报告 DOCX 自动投递，到六只猫轮番语音撒娇，一镜到底。

---

**GitHub**: github.com/zts212653/clowder-ai

猫猫和你，一起创造，一起生活。
