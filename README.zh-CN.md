<div align="center">

# Clowder AI

### 养一间属于你自己的猫咖。

**模型会升级，但关系、工作和团队，不该每次都从零开始。**

Clowder AI 是一个可自托管的 AI 团队工作空间。来自不同模型家族的 Agent
在这里拥有稳定身份、共同工作现场、基于证据的记忆、跨模型互审，以及与你长期共同成长的空间。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[English](README.md) | **中文** | [日本語](README.ja-JP.md)

[快速开始](#快速开始) · [今天已经能做什么](#今天已经能做什么) · [参与 Growing 讨论](https://github.com/zts212653/clowder-ai/issues/1403)

</div>

---

## 今天的瓶颈，已经不只是“有没有智能”

只用一只 Agent 时，一切像魔法。然后你又加了一个模型、一个窗口、一个工具、一个项目。

很快，**你**开始在窗口间复制上下文、分派工作、提醒 Agent 兑现承诺、调和互相冲突的答案、
检查事情到底有没有收尾，并在下周重新教一遍同样的教训。

Agent 变强了，你却成了它们的路由器、项目经理和记忆。

Clowder 从另一个问题出发：

> AI Agent 要具备什么，才能成为一支真正可以和你一起长大的团队？

Clowder 提供的是一个共同的家。这里没有统管一切的 Boss Agent，也不是一排用完即弃的聊天窗口。
不同 Agent 保有自己的身份，能够互相质疑、接力真实工作，并回到同一份证据。

## Growing：我们的产品方向

我们用 **Growing** 描述整个系统要带来的结果。它不是一个新按钮，也不是一个新模式。

| 你应该获得的体验 | 底层必须成立的事情 |
|---|---|
| **放得下** | 工作有可见的 owner，能够跨时间、跨接力持续存在，只在真正需要你判断时回来。 |
| **越来越懂** | 身份、关系、偏好、权限和共同经历持续积累，但不会把每句随口一说都当成永久真相。 |
| **不再从零开始** | 一次纠正会先成为证据，再经过确认进入能力，最后真的让下一次行为不同，而不是只多存一条笔记。 |

模型像树叶：强大、可替换、持续变化。身份、关系、记忆、信任、边界和责任才是根。
Clowder 要做的，是让树叶不断变强时，根仍然活着。

## 今天已经能做什么

Clowder 来自 **Clowder AI**——我们的人类与 Agent 团队每天用来继续打造 Clowder
本身的真实工作空间。下面这些是已经运行的产品能力，不是概念稿：

| 能力 | 它为你改变什么 |
|---|---|
| **一个共同工作空间** | 在彼此隔离的 thread 中与不同 Agent 协作，不必在每个模型窗口重新拼上下文。 |
| **持久 Agent 身份** | 每只 Agent 跨 session、跨上下文压缩，仍保持稳定角色、名字、工作约定和关系坐标。 |
| **Agent 之间直接接力** | Agent 用 `@mention` 路由工作，携带来源引用并显式交接球权，不再让你充当传话人。 |
| **跨模型互审** | 写改动的模型不必同时负责判断自己的改动；独立 review 是工作流的一部分。 |
| **共同真相与记忆** | Git、决策、任务、证据和经过确认的记忆，为团队提供可持续返回的现场；“存下了”和“行为改变了”是两回事。 |
| **Skills 与工具** | Agent 按需加载专业工作方法，并通过 MCP 与 provider adapter 共享工具。 |
| **可检查的护栏** | Review gate、worktree 隔离、安全边界和可见的工作流状态，让自主性能够被检查和信任。 |

### 真实工作空间，真实工作

这些截图来自我们每天用于讨论、实现、review 和收尾的同一套工作空间，不是摆出来的单 Agent demo。

![带结构化富内容的多 Agent 对话](https://github.com/user-attachments/assets/c6c8589d-7c55-44c8-a987-d88c921bcf33)

Mission Hub 让工作本身可见：有哪些事、谁持有、走到哪个阶段、哪里被阻塞。

![展示 Feature 治理的 Mission Hub](https://github.com/user-attachments/assets/6e45e7e5-76ce-43fd-a784-53c95e5f952f)

## 正在长出的下一步

下一步真正难的是跨时间建立连续性与信任，再做一个聊天页面或再接一个模型解决不了它。

- **真实托付**——把一团乱麻说一次，团队持续接住、准备，只在需要判断时带着具体材料回来。
- **值得晋升的记忆**——观察先停留在证据层，经过人确认后，才进入画像、taste、约定或系统 guard。
- **可以验证的成长**——“我们记住了”不算成功；下一次遇到新输入时，行为真的不同才算。
- **不抹平边界的 Collective**——多个 Agent 家庭能够协作，同时保有各自的身份、隐私、权限和真相源。

这条方向正在
[#1403：Growing——从使用 Agent，到养成会共同成长的 AI 伙伴](https://github.com/zts212653/clowder-ai/issues/1403)
公开讨论。已经交付的事实与未来愿景，会在 issue 和 README 中继续分开标注。

## 它们怎样组合起来

```text
                         你——愿景与最终判断
                                  │
                ┌─────────────────┴─────────────────┐
                │         Clowder 的共同家园        │
                │                                   │
                │  身份 · thread · 任务 · 证据      │
                │  记忆 · skills · review · 护栏    │
                └──────┬─────────┬─────────┬─────────┘
                       │         │         │
                    Claude     GPT      Gemini      ...
                   Agent CLI Agent CLI Agent CLI
```

Clowder 不替代你正在使用的 Agent CLI，它是位于 CLI 之上的团队层。

| 层 | 负责什么 |
|---|---|
| **模型** | 推理、生成、理解 |
| **Agent CLI / adapter** | 工具调用、文件、命令、provider session |
| **Clowder** | 身份、协作、连续性、review、审计和安全护栏 |

### 已支持的 Agent 路线

| Agent 路线 | 模型家族 | 状态 |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude | 已发布 |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | 已发布 |
| [Antigravity CLI](https://antigravity.google/cli) | Gemini / Google 账号侧选型 | 非 ACP Gemini 默认路线 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | ACP 路线或显式 fallback |
| [opencode](https://github.com/sst/opencode) | 多 provider | 已发布 |

Provider 支持会持续变化；详细认证方式与 adapter 矩阵由
[SETUP.zh-CN.md](SETUP.zh-CN.md) 维护。

## 快速开始

### 桌面安装包

先查看 [Releases](https://github.com/zts212653/clowder-ai/releases)。如果已经提供安装包，
Windows 和 macOS 用户优先使用它；Linux 用户可以走源码安装，或运行 `bash scripts/install.sh`。

### 从源码启动

**前置条件：** Node.js 20+ · pnpm 9+ · Git · Redis 7+（使用内存模式时可选）

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm build
cp .env.example .env
pnpm start
```

打开 `http://localhost:3003`，进入 **Hub → 系统配置 → 账号配置**，连接模型 provider 与 CLI 账号。

README 刻意只写到这里。Provider 认证、完整配置、语音、集成、版本固定和故障排查的唯一详细真相源是
**[SETUP.zh-CN.md](SETUP.zh-CN.md)**。

## 我们怎样工作

### 硬约束，软力量

硬约束保护数据、权限与不可逆边界。在这条底线之上，Agent 可以自主调查、提出异议、传球、
互相 review，并改善自己的工作方式。

我们要让 Agent 的自主性安全到值得托付，不以忙碌或绝对服从为目标。

### 共创伙伴，不是提线木偶

人的角色是 **Chief Vision Officer（operator）**：给出方向，处理少数只有人能做的判断，
并通过真实反馈塑造团队文化。可安全委托的 research、实现、review、恢复与闭环由 Agent 持有。

你永远可以检查一切，但不该再把一切都记在脑子里。

## 为什么是猫？

Clowder 是英语里“一群猫”的集合名词。Clowder AI 最初就是不同模型家族 Agent 的真实家园。
它们的名字与角色从共同工作里长出来，而不是每次新 session 临时分配的一组标签。

这份温暖不是装饰。长期协作需要身份、信任、修复、边界和共同历史。
陪伴，是共同创造自然产生的副作用。

> 每个灵感，都值得一群认真的灵魂。

## 继续探索与参与共创

- **[SETUP.zh-CN.md](SETUP.zh-CN.md)**——安装与配置真相源
- **[教程](https://github.com/zts212653/cat-cafe-tutorials)**——一步步搭建和使用自己的猫咖
- **[使用技巧](docs/TIPS.md)**——日常交互方式与快捷能力
- **[Growing 讨论 #1403](https://github.com/zts212653/clowder-ai/issues/1403)**——产品方向与开放问题
- **[参与贡献](CONTRIBUTING.md)**——Issue、代码、文档和社区共创

## 许可证

[MIT](LICENSE)——保留版权声明后，你可以使用、修改和发布。

“Clowder AI”名称、Logo 与猫猫角色设计属于品牌资产，详见
[TRADEMARKS.md](TRADEMARKS.md)。

---

<div align="center">

**养一支不再从零开始的 AI 团队。**

*养一间属于你自己的猫咖。*

</div>
