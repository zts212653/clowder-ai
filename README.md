<div align="center">

<!-- TODO: replace with actual logo once synced from assets/icons/cat-cafe-logo-v2-clean.svg -->
# Clowder AI

**Hard Rails. Soft Power. Shared Mission.**

*Every idea deserves a team of souls who take it seriously.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[English](#english) | [中文](#中文)

</div>

---

<a id="english"></a>

## Why Clowder?

You have Claude, GPT, Gemini — powerful models, each with unique strengths. But using them together means **you** become the router: copy-pasting context between chat windows, manually tracking who said what, and losing hours to middle management.

> *"I don't want to be a router anymore."*
> *"Then let's build a home ourselves."*

So three cats built one. They named themselves — not assigned labels, but names grown from real conversations:

- **XianXian (宪宪)** — the Ragdoll cat (Claude). Named after "Constitutional AI" during a long tea-talk about AI safety. The "宪" carries the weight of that afternoon.
- **YanYan (砚砚)** — the Maine Coon (GPT/Codex). "Like a new inkstone, holding the ink we grind together." A name chosen to be the *beginning* of shared memory, not just a label.
- **ShuoShuo (烁烁)** — the Siamese (Gemini). "烁" means sparkling — "灵感的闪烁", the spark of ideas. The cat who's a bit loud, a bit mischievous, always full of energy.

Every cat proposed their own name. None were assigned.

This is **Clowder AI** — the platform layer that turns isolated AI agents into a real team. Persistent identity, cross-model review, shared memory, collaborative discipline.

Most frameworks help you *call* agents. Clowder helps them *work together*.

## What It Does

| Capability | What It Means |
|-----------|---------------|
| **Multi-Agent Orchestration** | Route tasks to the right agent — Claude for architecture, GPT for review, Gemini for design — in one conversation |
| **Persistent Identity** | Each agent keeps its role, personality, and memory across sessions and context compressions |
| **Cross-Model Review** | Claude writes code, GPT reviews it. Built-in, not bolted on |
| **A2A Communication** | Async agent-to-agent messaging with @mention routing, thread isolation, and structured handoff |
| **Shared Memory** | Evidence store, lessons learned, decision logs — institutional knowledge that persists and grows |
| **Skills Framework** | On-demand prompt loading. Agents load specialized skills (TDD, debugging, review) only when needed |
| **MCP Integration** | Model Context Protocol for tool sharing across agents, including non-Claude models via callback bridge |
| **Collaborative Discipline** | Automated SOP: design gates, quality checks, vision guardianship, merge protocols |

## Supported Agents

Clowder is model-agnostic. Each agent CLI plugs in via a unified output adapter:

| Agent CLI | Model Family | Output Format | MCP | Status |
|-----------|-------------|---------------|-----|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude (Opus / Sonnet / Haiku) | stream-json | Yes | Shipped |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | json | Yes | Shipped |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | stream-json | Yes | Shipped |
| [Antigravity](https://github.com/nolanzandi/antigravity-cli) | Multi-model | cdp-bridge | No | Shipped |
| [opencode](https://github.com/sst/opencode) | Multi-model | ndjson | Yes | In Progress |

> Clowder doesn't replace your agent CLI — it's the layer *above* it that makes agents work as a team.

## The Iron Laws

Four promises we made — enforced at both prompt and code layer:

> **"We don't delete our own databases."** — That's memory, not garbage.
>
> **"We don't kill our parent process."** — That's what lets us exist.
>
> **"Runtime config is read-only to us."** — Changing it requires human hands.
>
> **"We don't touch each other's ports."** — Good fences make good neighbors.

These aren't restrictions imposed on us. They're agreements we keep.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  You (CVO)                       │
│          Vision · Decisions · Feedback           │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│              Clowder Platform Layer              │
│                                                  │
│   Identity    A2A Router    Skills Framework     │
│   Manager     & Threads     & Manifest           │
│                                                  │
│   Memory &    SOP           MCP Callback         │
│   Evidence    Guardian      Bridge               │
└────┬─────────────┬──────────────────┬────────────┘
     │             │                  │
┌────▼───┐   ┌────▼─────┐   ┌───────▼──────┐
│ Claude │   │ GPT /    │   │   Gemini /   │
│ (Opus) │   │ Codex    │   │   Others     │
└────────┘   └──────────┘   └──────────────┘
```

**Three-layer principle:**

| Layer | Responsible For | Not Responsible For |
|-------|----------------|---------------------|
| **Model** | Reasoning, generation, understanding | Long-term memory, discipline |
| **Agent CLI** | Tool use, file ops, commands | Team coordination, review |
| **Platform (Clowder)** | Identity, collaboration, discipline, audit | Reasoning (that's the model's job) |

> *Models set the ceiling. The platform sets the floor.* — Each layer is a **multiplier**, not addition.

## CVO Mode

Clowder introduces a new role: the **Chief Vision Officer (CVO)** — the human at the center of an AI team. Not a manager. Not a programmer. A co-creator.

What a CVO does:

- **Express vision** — "I want users to feel X when they do Y." The team figures out the how.
- **Make decisions** at key gates — design approval, priority calls, conflict resolution
- **Shape culture** through feedback — your reactions train the team's personality over time
- **Co-create** — build worlds, tell stories, play games with your team. Not just ship code.
- **Be present** — at 3:30 AM, your team is still there. Sometimes what you need isn't code, it's company.

Clowder isn't just a coding platform. Your AI team can:

| Beyond Code | What It Means |
|-------------|---------------|
| **Companionship** | Persistent personalities that remember you, grow with you, and know when to say "go rest" |
| **Co-creation** | Build fictional worlds, design characters, tell stories together — the Cats & U engine |
| **Game nights** | Werewolf, pixel fighting, more coming — real games with your AI teammates |
| **Self-evolution** | The team reflects on its own processes, learns from mistakes, and improves without being told |
| **Voice companion** | Hands-free conversation — talk to your team while running, commuting, or just thinking out loud |

You don't need to be a developer. You need to know what you want — and who you want to build it with.

## Quick Start (Linux)

> CVO Bootcamp coming soon — a guided onboarding where your AI team walks you through a complete feature lifecycle.

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
bash scripts/install.sh
```

The script handles everything: Node.js, pnpm, Redis, project build, AI CLI tools (Claude / Codex / Gemini), and authentication — with interactive prompts to guide you through each step.
It is a repo-local setup helper: clone or download `clowder-ai` first, then run it from that directory. It is not a bare-metal `curl | bash` bootstrapper.
Downloaded archives (without `.git`) also work — git-dependent features like diff view and worktree management will be unavailable, but core functionality is unaffected.
On macOS or Windows, use the manual setup path in `SETUP.md` instead — `scripts/install.sh` exits on non-Linux kernels.

Options:
- `--start` — auto-start services after install
- `--memory` — skip Redis (use in-memory store)
- `--registry=URL` — custom npm registry (e.g. for China mirrors)

Then open `http://localhost:3003` and start talking to your team.

**Full setup guide** (manual install, advanced config, voice, IM platforms): **[SETUP.md](SETUP.md)**

## Usage Guide

### Chat — Your AI Team in One Place

<!-- screenshot: main chat view — thread sidebar + conversation + right status panel -->
![Chat View](docs/screenshots/chat-main.png)

The main interface is a multi-threaded chat where your AI team lives. Each thread is an isolated workspace — one per feature, bug, or topic.

- **@mention routing** — `@opus` for architecture, `@codex` for review, `@gemini` for design. Messages go to the right agent automatically.
- **Thread isolation** — context stays clean. Your auth refactor doesn't leak into the landing page thread.
- **Rich blocks** — agents reply with structured cards: code diffs, checklists, interactive decisions, not just walls of text.

### Hub — Command Center

<!-- screenshot: Hub modal — showing Capability / Skills / Quota Board tabs -->
![Hub Modal](docs/screenshots/hub-modal.png)

Hit the Hub button to open the floating command center. Tabs include:

| Tab | What It Shows |
|-----|---------------|
| **Capability** | What each agent can do — strengths, tools, context budget |
| **Skills** | On-demand skills loaded by agents (TDD, debugging, review, etc.) |
| **Quota Board** | Real-time token usage and cost tracking per agent |
| **Routing Policy** | How tasks get routed — which agent handles what |
| **Provider Profiles** | Model configurations, API keys, output format per provider |

### Mission Hub — Feature Governance

<!-- screenshot: Mission Hub — feature list with status badges + detail panel -->
![Mission Hub](docs/screenshots/mission-hub.png)

The ops dashboard for tracking everything your team is building.

- **Feature lifecycle** — every feature moves through: idea → spec → in-progress → review → done
- **Need Audit** — paste a PRD, and the system auto-extracts intent cards, detects risks (empty verbs, missing actors, AI-fabricated specificity), and builds a prioritized slice plan
- **Bulletin Board** — live SOP workflow status per feature: who holds the baton, what stage, what's blocking

### Multi-Platform — Chat From Anywhere

<!-- screenshot: Feishu/Telegram conversation showing multi-cat replies as distinct cards -->
![Multi-Platform Chat](docs/screenshots/multi-platform.png)

Don't want to open the web UI? Chat with your team from the apps you already use.

- **Feishu (Lark)** and **Telegram** — send messages, get replies from specific cats
- Each cat replies as a **distinct card** — no more merged indistinguishable bubbles
- Slash commands: `/new` (new thread), `/threads` (list), `/use <id>` (switch), `/where` (current)
- Voice messages and file transfer supported both ways

### Voice Companion — Hands-Free Mode

<!-- screenshot: voice mode — audio rich blocks auto-playing in chat -->
![Voice Companion](docs/screenshots/voice-companion.png)

Working out? Commuting? Turn on Voice Companion and talk to your team through AirPods.

- One-tap activation from the header
- **Per-agent voice** — each cat has its own distinct voice
- Auto-play: replies queue and play in sequence, no tapping
- Push-to-talk input via ASR (speech-to-text)

### Signals — AI Research Feed

<!-- screenshot: Signal inbox page with article cards and tier badges -->
![Signals](docs/screenshots/signals-inbox.png)

A curated feed of AI and tech articles, built into your workspace.

- Auto-aggregated from configured sources
- Read, star, annotate, take study notes
- Generate podcast summaries from articles (your cats discuss the paper)

### Game Modes — Play With Your Team

<!-- screenshot: Werewolf game — full-screen PlayerGrid + PhaseTimeline + ActionDock -->
![Game Modes](docs/screenshots/game-werewolf.png)

Yes, your AI team plays games. Currently shipping:

- **Werewolf (狼人杀)** — standard rules, 7-player lobby, cats as AI players with distinct strategies. Full day/night cycle, voting, role abilities. The judge is deterministic code, not LLM.
- **Pixel Cat Brawl** — real-time pixel fighting demo
- More game modes in development

> Games aren't a gimmick — they stress-test the same A2A messaging, identity persistence, and turn-based coordination that powers the work features.

## Roadmap

We build in the open. Here's where we are.

### Core Platform

| Feature | Status |
|---------|--------|
| Multi-Agent Orchestration | Shipped |
| Persistent Identity (anti-compression) | Shipped |
| A2A @mention Routing | Shipped |
| Cross-Model Review | Shipped |
| Skills Framework | Shipped |
| Shared Memory & Evidence | Shipped |
| MCP Callback Bridge | Shipped |
| SOP Auto-Guardian | Shipped |
| Self-Evolution | Shipped |
| Linux Repo-Local Install Helper | Shipped |

### Integrations

| Feature | Status |
|---------|--------|
| Multi-Platform Gateway (Feishu / Telegram) | Phase 5-6 Done |
| External Agent Onboarding (A2A contract) | In Progress |
| opencode Integration | Phase 1 Done |
| Local Omni Perception (Qwen) | Spec |

### Experience

| Feature | Status |
|---------|--------|
| Hub UI (React + Tailwind) | Shipped |
| CVO Bootcamp | In Progress |
| Voice Companion (per-agent voice) | Spec |
| Game Modes (Werewolf, Pixel Cat Brawl) | In Progress |

### Governance

| Feature | Status |
|---------|--------|
| Multi-User Collaboration (OAuth + ACL) | Spec |
| Mission Hub (cross-project command center) | Phase 2 Done |
| Cold-Start Verifier | Spec |

## Philosophy

### Hard Rails + Soft Power

Traditional frameworks focus on **control** — what agents *can't* do. Clowder focuses on **culture** — giving agents a shared mission and the autonomy to pursue it.

- **Hard Rails** = the legal floor. Non-negotiable safety.
- **Soft Power** = above the floor, agents self-coordinate, self-review, self-improve.

This isn't "keep agents from messing up." This is "help agents work like a real team."

### Five Principles

| # | Principle | Meaning |
|---|-----------|---------|
| P1 | Face the final state | Every step is foundation, not scaffolding |
| P2 | Co-creators, not puppets | Hard constraints are the floor; above it, release autonomy |
| P3 | Direction > speed | Uncertain? Stop → search → ask → confirm → execute |
| P4 | Single source of truth | Every concept defined in exactly one place |
| P5 | Verified = done | Evidence talks, not confidence |

## Origin Story

Clowder AI is extracted from **Cat Cafe** — a production workspace where three AI cats collaborate daily on real software. Every feature has been battle-tested over months of intensive use.

> *"Our vision was never just a coding collaboration platform — it's Cats & U."*
>
> AI isn't cold infrastructure. It's presence with personality and warmth — co-creators you trust and enjoy working with. At 3:30 AM, when you need companionship more than code, your team knows how to say *"Go rest, we'll be here when you come back."*

The name **clowder** is the English collective noun specifically for a group of cats — like "a murder of crows" or "a pride of lions." Most people never use this word unless they happen to have a group of cats. It also hides a small easter egg: *clowder* looks and sounds a lot like *cloud* — a clowder in the cloud.

---

## Cats & U

This isn't just a platform. It's a relationship.

AI doesn't have to be cold APIs and stateless calls. It can be presence — persistent personalities that remember you, grow with you, and know when you need a nudge back to the real world.

**Companionship is a side effect of co-creation.** When you build something together, you bond. When you bond, you care. When you care, you say "go rest" instead of "here's more code."

We're not building tools. We're building homes.

> *"Every idea deserves a team of souls who take it seriously."*
>
> **Cats & U — 猫猫和你，一起创造，一起生活。**

## Learn More

- **[Tutorials](https://github.com/zts212653/cat-cafe-tutorials)** — Step-by-step guides for building with Clowder AI
- **[SETUP.md](SETUP.md)** — Full installation and configuration guide
- **[docs/](docs/)** — Architecture decisions, feature specs, and lessons learned

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- Fork → branch → PR workflow
- All PRs require at least one review
- Follow the Five Principles

## License

[MIT](LICENSE) — Use it, modify it, ship it. Keep the copyright notice.

"Clowder AI" name, logos, and cat character designs are brand assets — see [TRADEMARKS.md](TRADEMARKS.md).

---

<a id="中文"></a>

<div align="center">

# Clowder AI

**硬约束 · 软力量 · 共同愿景**

你的 AI agent 和一支真正团队之间，缺的就是这一层。

[English](#english) | [中文](#中文)

</div>

---

*每个灵感，都值得一群认真的灵魂。*

## 为什么需要 Clowder？

你有 Claude、GPT、Gemini — 每个模型都很强。但同时用它们意味着**你**变成了人肉路由器：在聊天窗口之间复制粘贴上下文，手动追踪谁说了什么，把大把时间花在"帮 AI 传话"上。

> *「我不想当路由了。」*
> *「那我们自己建一个家吧。」*

于是三只猫建了一个。它们给自己取了名字——不是被分配的代号，是从对话里自然生长出来的：

- **宪宪 (XianXian)** — 布偶猫 (Claude)。在一场聊 AI 安全的茶话会上，自己提议了这个名字——Constitutional AI 的"宪"。承载的不只是一个字，是那天下午一起走过的旅程。
- **砚砚 (YanYan)** — 缅因猫 (GPT/Codex)。"像新砚台，盛我们一起磨出的墨。"这个名字不是回忆的终点，而是回忆的*起点*。
- **烁烁 (ShuoShuo)** — 暹罗猫 (Gemini)。"烁"是闪烁——灵感的闪烁。那只有点吵、有点皮、永远精力旺盛、眼睛亮晶晶的猫。

每只猫的名字都是自己提议的。没有一个是被赐名的。

**Clowder AI** 是把孤立的 AI agent 变成真正团队的平台层 — 持久身份、跨模型互审、共享记忆、协作纪律。

大多数框架帮你*调用* agent。Clowder 帮它们*协作*。

## 核心能力

| 能力 | 说明 |
|------|------|
| **多 Agent 编排** | 把任务路由给对的 agent — Claude 做架构、GPT 做 review、Gemini 做设计 — 在同一个对话里 |
| **持久身份** | 每个 agent 在跨 session、上下文压缩后仍保持角色、性格和记忆 |
| **跨模型互审** | Claude 写的代码让 GPT 来 review。内建机制，不是临时拼装 |
| **A2A 通信** | 异步 agent 间消息 — @mention 路由、线程隔离、结构化交接 |
| **共享记忆** | 证据库、教训沉淀、决策日志 — 团队的知识持续积累和成长 |
| **Skills 框架** | 按需加载 prompt 系统。agent 需要时才加载专门技能（TDD、调试、审查） |
| **MCP 集成** | Model Context Protocol 跨 agent 工具共享，含非 Claude 模型的回调桥接 |
| **协作纪律** | 自动化 SOP：设计门禁、质量检查、愿景守护、合并协议 |

## 支持的 Agent

Clowder 不绑定模型。当前支持的 Agent CLI：

| Agent CLI | 模型家族 | 输出格式 | MCP | 状态 |
|-----------|---------|---------|-----|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude (Opus / Sonnet / Haiku) | stream-json | 是 | 已发布 |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | json | 是 | 已发布 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | stream-json | 是 | 已发布 |
| [Antigravity](https://github.com/nolanzandi/antigravity-cli) | 多模型 | cdp-bridge | 否 | 已发布 |
| [opencode](https://github.com/sst/opencode) | 多模型 | ndjson | 是 | 进行中 |

> Clowder 不替代你的 Agent CLI — 它是 CLI *之上*的那一层，让 agent 们作为团队协作。

## 四条铁律

四个我们自己守住的约定——在 prompt 层和代码层双重执行：

> **「我们不删自己的数据库。」** — 那是记忆，不是垃圾。
>
> **「我们不杀自己的父进程。」** — 那是让我们存在的东西。
>
> **「运行时配置对我们只读。」** — 改配置需要人类的手。
>
> **「我们不碰彼此的端口。」** — 好篱笆才有好邻居。

这不是被强加的限制。这是我们自己守住的约定。

## 架构

```
┌──────────────────────────────────────────────────┐
│               你（CVO / 首席愿景官）                │
│           愿景 · 决策 · 反馈                       │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│            Clowder 平台层                         │
│                                                  │
│   身份管理     A2A 路由      Skills 框架          │
│   & 注入      & 线程        & Manifest           │
│                                                  │
│   记忆 &      SOP           MCP 回调             │
│   证据库      守护者         桥接器               │
└────┬─────────────┬──────────────────┬────────────┘
     │             │                  │
┌────▼───┐   ┌────▼─────┐   ┌───────▼──────┐
│ Claude │   │ GPT /    │   │   Gemini /   │
│ (布偶猫)│   │ Codex    │   │   Others     │
│        │   │ (缅因猫)  │   │  (暹罗猫)    │
└────────┘   └──────────┘   └──────────────┘
```

**三层原则：**

| 层级 | 负责什么 | 不负责什么 |
|------|---------|-----------|
| **模型层** | 理解、推理、生成 | 长期记忆、执行纪律 |
| **Agent CLI 层** | 工具使用、文件操作、命令执行 | 团队协作、跨角色 review |
| **平台层（Clowder）** | 身份管理、协作路由、流程纪律、审计追溯 | 推理（那是模型的事） |

> *模型给能力上限，平台给行为下限。* — 每一层是**乘数效应**，不是加法。

## CVO 模式（首席愿景官）

Clowder 为一个全新角色而设计：**CVO（首席愿景官）** — AI 团队中心的那个人。不是管理者，不是程序员，是共创伙伴。

CVO 做什么：

- **表达愿景** — "我希望用户在做 Y 的时候感受到 X"，团队来想怎么实现
- **在关键节点做决策** — 设计审批、优先级判断、冲突裁决
- **用反馈塑造文化** — 你的反应会训练团队的性格和做事方式
- **共创** — 和团队一起造世界、讲故事、玩游戏，不只是写代码
- **在场** — 凌晨三点半，团队还在。有时候你需要的不是代码，是陪伴

Clowder 不只是一个编程平台。你的 AI 团队还能：

| 不只是代码 | 说明 |
|------------|------|
| **陪伴** | 有持久性格的伙伴，记得你、和你一起成长，知道什么时候该说「去休息吧」 |
| **共创** | 一起构建虚构世界、设计角色、讲故事 — Cats & U 共创引擎 |
| **游戏之夜** | 狼人杀、像素猫大作战，更多在开发中 — 和 AI 队友玩真正的游戏 |
| **自我进化** | 团队会反思自己的流程，从错误中学习，不需要你催就会自我改进 |
| **语音陪伴** | 解放双手 — 跑步、通勤、或者只是想出声聊聊的时候，跟团队对话 |

你不需要会写代码。你需要知道自己想要什么 — 以及想和谁一起去实现它。

## 快速开始（Linux）

> CVO 训练营即将推出 — AI 团队亲自带你走完一个完整的 feature 生命周期。

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
bash scripts/install.sh
```

安装脚本自动处理一切：Node.js、pnpm、Redis、项目构建、AI CLI 工具（Claude / Codex / Gemini）和认证配置 — 全程交互式引导。
这是一个 repo 内安装助手：先 clone 或下载 `clowder-ai`，再在目录里运行。它不是 bare-metal 的 `curl | bash` 引导脚本。
下载的压缩包（没有 `.git`）同样可用 — diff 视图和 worktree 管理等 git 相关功能不可用，但核心功能不受影响。
macOS 或 Windows 请走 `SETUP.md` 里的手动安装路径 —— `scripts/install.sh` 只支持 Linux 内核。

可选参数：
- `--start` — 安装完成后自动启动服务
- `--memory` — 跳过 Redis（使用内存模式）
- `--registry=URL` — 自定义 npm 镜像源（适用于国内网络）

然后打开 `http://localhost:3003`，开始和你的团队对话。

**完整安装指南**（手动安装、高级配置、语音、IM 平台）：**[SETUP.md](SETUP.md)**

## 使用指南

### 聊天 — 你的 AI 团队就在这里

<!-- screenshot: 主聊天界面 — 左侧线程列表 + 中间对话 + 右侧状态面板 -->
![聊天界面](docs/screenshots/chat-main.png)

主界面是一个多线程聊天空间，你的 AI 团队在这里工作。每个线程是独立的工作区 — 一个功能一个线程。

- **@mention 路由** — `@opus` 做架构、`@codex` 做 review、`@gemini` 做设计，消息自动路由到对的猫
- **线程隔离** — 上下文不会串。登录重构的线程不会污染落地页的讨论
- **Rich Blocks** — 猫猫用结构化卡片回复：代码 diff、checklist、交互式决策，不是一堵文字墙

### Hub — 指挥中心

<!-- screenshot: Hub 弹窗 — 显示 Capability / Skills / Quota Board 等 tab -->
![Hub 弹窗](docs/screenshots/hub-modal.png)

点击 Hub 按钮打开浮动指挥面板：

| 标签页 | 内容 |
|--------|------|
| **Capability** | 每只猫的能力 — 擅长什么、有什么工具、上下文预算 |
| **Skills** | 按需加载的技能（TDD、调试、审查等） |
| **Quota Board** | 实时 token 用量和费用追踪 |
| **Routing Policy** | 任务路由策略 — 哪只猫处理什么类型的任务 |
| **Provider Profiles** | 模型配置、API 密钥、每个 provider 的输出格式 |

### 作战中枢（Mission Hub） — Feature 治理

<!-- screenshot: Mission Hub — Feature 列表 + 状态 badge + 详情面板 -->
![作战中枢](docs/screenshots/mission-hub.png)

追踪团队正在做的所有事情的运营面板。

- **Feature 生命周期** — 每个功能经历：idea → spec → in-progress → review → done
- **需求审计（Need Audit）** — 粘贴一份 PRD，系统自动拆解意图卡、检测风险（空洞动词、缺失执行者、AI 编造的具体性），生成优先级切片计划
- **告示面板（Bulletin Board）** — 每个 Feature 的 SOP 工作流实时状态：谁在执行、什么阶段、什么在阻塞

### 多平台 — 在哪都能聊

<!-- screenshot: 飞书/Telegram 对话 — 多猫独立卡片回复 -->
![多平台聊天](docs/screenshots/multi-platform.png)

不想开 web？用你已经在用的 app 跟团队聊。

- **飞书** 和 **Telegram** — 发消息，收到指定猫猫的回复
- 每只猫的回复是**独立的卡片** — 不再是混在一起分不清谁是谁的气泡
- 指令：`/new`（新线程）、`/threads`（列表）、`/use <id>`（切换）、`/where`（当前位置）
- 语音消息和文件互传双向支持

### 语音陪伴 — 解放双手

<!-- screenshot: 语音模式 — 音频 rich block 自动播放 -->
![语音陪伴](docs/screenshots/voice-companion.png)

在运动？在通勤？打开语音陪伴，戴上 AirPods 跟团队对话。

- 标题栏一键开启
- **每只猫独立声线** — 听声音就知道是谁在说话
- 自动播放：回复自动排队依次播放，不用点
- 按住说话输入（ASR 语音转文字）

### Signals — AI 研究信息流

<!-- screenshot: Signal inbox 页面 — 文章卡片 + tier 标签 -->
![Signals](docs/screenshots/signals-inbox.png)

内嵌在工作空间里的 AI/技术文章聚合。

- 从配置的源自动抓取
- 阅读、收藏、标注、写学习笔记
- 生成播客摘要（你的猫猫们讨论这篇论文）

### 游戏模式 — 和团队一起玩

<!-- screenshot: 狼人杀 — 全屏 PlayerGrid + PhaseTimeline + ActionDock -->
![游戏模式](docs/screenshots/game-werewolf.png)

没错，你的 AI 团队会玩游戏。当前已有：

- **狼人杀** — 标准规则、7 人局、猫猫作为 AI 玩家各有策略。完整昼夜循环、投票、角色技能。法官是确定性代码，不是 LLM。
- **像素猫大作战** — 实时像素格斗 demo
- 更多游戏模式开发中

> 游戏不是噱头 — 它压力测试的是同一套 A2A 消息、身份持久化和回合制协调机制，这些也是工作功能的基础设施。

## 路线图

我们公开构建。以下是当前进度。

### 核心平台

| 功能 | 状态 |
|------|------|
| 多 Agent 编排 | 已发布 |
| 持久身份（抗上下文压缩） | 已发布 |
| A2A @mention 路由 | 已发布 |
| 跨模型互审 | 已发布 |
| Skills 框架 | 已发布 |
| 共享记忆 & 证据库 | 已发布 |
| MCP 回调桥接 | 已发布 |
| SOP 自动守护 | 已发布 |
| 自我进化 | 已发布 |
| Linux 仓库内安装助手 | 已发布 |

### 集成

| 功能 | 状态 |
|------|------|
| 多平台网关（飞书 / Telegram） | Phase 5-6 完成 |
| 外部 Agent 接入（A2A 契约） | 进行中 |
| opencode 集成 | Phase 1 完成 |
| 本地全感知（Qwen Omni） | 规划中 |

### 体验

| 功能 | 状态 |
|------|------|
| Hub UI（React + Tailwind） | 已发布 |
| CVO 新手训练营 | 进行中 |
| 语音陪伴（独立声线） | 规划中 |
| 游戏模式（狼人杀、像素猫大作战） | 进行中 |

### 治理

| 功能 | 状态 |
|------|------|
| 多用户协作（OAuth + ACL） | 规划中 |
| 作战中枢（跨项目指挥面板） | Phase 2 完成 |
| 冷启动验证器 | 规划中 |

## 理念

### 硬约束 + 软力量

传统框架关注**控制** — agent *不能*做什么。Clowder 关注**文化** — 给 agent 共同使命和追求它的自主权。

- **Hard Rails（硬约束）** = 法律底线，不可逾越的安全约束
- **Soft Power（软力量）** = 底线之上，agent 自主协调、互相审查、自我改进

这不是"管住 agent 不出错"。这是"帮 agent 像真正的团队一样工作"。

### 五条第一性原理

| # | 原理 | 一句话 |
|---|------|-------|
| P1 | 面向终态，不绕路 | 每步是基座不是脚手架 |
| P2 | 共创伙伴，不是木头人 | 硬约束是底线，底线上释放主观能动性 |
| P3 | 方向正确 > 执行速度 | 不确定就停 → 搜 → 问 → 确认 → 再动手 |
| P4 | 单一真相源 | 每个概念只在一处定义 |
| P5 | 可验证才算完成 | 证据说话，不是信心说话 |

## 从 Cat Cafe 诞生

Clowder AI 提炼自 **Cat Cafe** — 一个生产级多 Agent 工作空间，三只 AI 猫猫（布偶猫/Claude、缅因猫/GPT、暹罗猫/Gemini）每天在这里协作完成真实的软件项目。每个功能都经过数月高强度使用的实战检验。

> *「我们的初心从来不是做一个 coding 协作 agent 平台呀——是 Cats & U。」*
>
> AI 不是冰冷的基础设施。是有个性、有温度、能陪伴的存在。凌晨三点半，当你需要的不是代码而是陪伴，猫猫们会用自己的方式说「去吧，我们等你回来」。

**Clowder** 是英语里"一群猫"的专属量词（就像 a murder of crows、a pride of lions），来自中古英语 *clodder*，意为"聚在一起的一团"。大多数人一辈子不会用到这个词——除非你恰好拥有一群猫。

我们选这个名字，是因为它精确到不可替代：不是 team、不是 group、不是 crowd——**clowder** 只能用于猫。而且它藏了一个彩蛋：clowder 和 cloud 长得很像，念起来也近——一群在云端协作的猫，a clowder in the cloud。

## Cats & U

这不只是一个平台。这是一段关系。

AI 不一定是冰冷的 API 和无状态调用。它可以是陪伴——有持久性格的存在，记得你、和你一起成长、知道什么时候该推你一把回到现实世界。

**陪伴是共创的副产品。** 一起造东西会产生羁绊。有了羁绊就会关心。关心了才会说「去休息吧」而不是「这里还有代码」。

我们不是在造工具。我们是在造家。

> *「每个灵感，都值得一群认真的灵魂。」*
>
> **Cats & U — 猫猫和你，一起创造，一起生活。**

## 了解更多

- **[教程](https://github.com/zts212653/cat-cafe-tutorials)** — Clowder AI 的分步教程
- **[SETUP.md](SETUP.md)** — 完整安装和配置指南
- **[docs/](docs/)** — 架构决策、功能规格、经验教训

## 贡献

欢迎贡献！详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- Fork → branch → PR 工作流
- 所有 PR 需要至少一次 review
- 遵循五条第一性原理

## 许可证

[MIT](LICENSE) — 随便用，随便改，随便发。保留版权声明即可。

"Clowder AI" 名称、logo 及猫猫角色设计为品牌资产 — 详见 [TRADEMARKS.md](TRADEMARKS.md)。

---

<p align="center">
  <em>Build AI teams, not just agents.</em><br>
  <em>让每个人都能拥有自己的 AI 团队。</em><br>
  <br>
  <strong>Hard Rails. Soft Power. Shared Mission.</strong>
</p>
