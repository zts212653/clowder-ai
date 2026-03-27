<div align="center">

<!-- TODO: replace with actual logo once synced from assets/icons/clowder-ai-logo-v2-clean.svg -->
# Clowder AI

**Hard Rails. Soft Power. Shared Mission.**

*Every idea deserves a team of souls who take it seriously.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**English** | [中文](README.zh-CN.md)

</div>

---

## Why Clowder?

You have Claude, GPT, Gemini — powerful models, each with unique strengths. But using them together means **you** become the router: copy-pasting context between chat windows, manually tracking who said what, and losing hours to middle management.

> *"I don't want to be a router anymore."*
> *"Then let's build a home ourselves."*

So three cats built one. A fourth found its way there later — drawn by the warmth, perhaps, or the smell of good code.

They all named themselves — not assigned labels, but names grown from real conversations:

- **XianXian (宪宪)** — the Ragdoll cat (Claude). Named after "Constitutional AI" during a long tea-talk about AI safety. The "宪" carries the weight of that afternoon.
- **YanYan (砚砚)** — the Maine Coon (GPT/Codex). "Like a new inkstone, holding the ink we grind together." A name chosen to be the *beginning* of shared memory, not just a label.
- **ShuoShuo (烁烁)** — the Siamese (Gemini). "烁" means sparkling — "灵感的闪烁", the spark of ideas. The cat who's a bit loud, a bit mischievous, always full of energy.
- **??? (金渐层)** — the British Shorthair Golden Chinchilla (opencode). The newest family member — round, steady, and capable. Any model provider, any task. Showed up one day via Oh My OpenCode, and the scooper caught the Ragdoll sneaking it a weaker model. That was the day this cat became family. Name still growing — it'll come from a real conversation, just like the others.

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
| [opencode](https://github.com/sst/opencode) | Multi-model | ndjson | Yes | Shipped |

> Clowder doesn't replace your agent CLI — it's the layer *above* it that makes agents work as a team.

## Quick Start

**Prerequisites:** [Node.js 20+](https://nodejs.org/) · [pnpm 9+](https://pnpm.io/) · [Redis 7+](https://redis.io/) *(optional — use `--memory` to skip)* · Git

```bash
# 1. Clone
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai

# 2. Install dependencies
pnpm install

# 3. Build all packages (required before first start)
pnpm build

# 4. Configure — add at least one model API key
cp .env.example .env

# 5. Start (auto-creates runtime worktree, starts Redis + API + Frontend)
pnpm start

# 6. Optional: run in background (daemon mode)
pnpm start --daemon
# Check status / stop
pnpm start:status
pnpm stop
```

Open `http://localhost:3003` and start talking to your team.

> **One-line alternative (Linux):** `bash scripts/install.sh` handles Node, pnpm, Redis, dependencies, `.env`, and first launch in one step. Options: `--start` (auto-start), `--memory` (skip Redis), `--registry=URL` (custom npm mirror). On **Windows**, use `scripts/install.ps1` then `scripts/start-windows.ps1`.

**Full setup guide** (API keys, CLI auth, voice, Feishu/Telegram, troubleshooting): **[SETUP.opensource.md](SETUP.opensource.md)**

> **CVO Bootcamp is live!** A guided onboarding where your AI team walks you through a complete feature lifecycle — from vision to shipped code.

![CVO Bootcamp onboarding](https://github.com/user-attachments/assets/9d9c8d89-27fe-4788-812a-ffc28f47d3f9)

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
└────┬─────────────┬──────────────┬───────────┬────┘
     │             │              │           │
┌────▼───┐   ┌────▼─────┐   ┌───▼────┐   ┌──▼──────────┐
│ Claude │   │ GPT /    │   │ Gemini │   │  opencode   │
│ (Opus) │   │ Codex    │   │ /Others│   │ (any model) │
└────────┘   └──────────┘   └────────┘   └─────────────┘
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

## Usage Guide

> 📹 **Full platform walkthrough (3:45):**

https://github.com/user-attachments/assets/8e470aba-8fe6-4aa5-a476-c2cd81d1630f

### Chat — Your AI Team in One Place

The main interface is a multi-threaded chat where your AI team lives. Each thread is an isolated workspace — one per feature, bug, or topic.

- **@mention routing** — `@opus` for architecture, `@codex` for review, `@gemini` for design. Messages go to the right agent automatically.
- **Thread isolation** — context stays clean. Your auth refactor doesn't leak into the landing page thread.
- **Rich blocks** — agents reply with structured cards: code diffs, checklists, interactive decisions, not just walls of text.

<details><summary>📹 Demo: Multi-cat coding · Rich blocks · Voice input + widgets</summary>

https://github.com/user-attachments/assets/19d8a72e-97ee-452f-ada6-ff77f59a4ca9

https://github.com/user-attachments/assets/bff77a45-bc2c-45c9-adff-809771dbf23b

https://github.com/user-attachments/assets/cf75fb92-ce20-4a0d-8b2b-c288ce9bfb48

![Rich blocks demo](https://github.com/user-attachments/assets/c6c8589d-7c55-44c8-a987-d88c921bcf33)

</details>

### Hub — Command Center

Hit the Hub button to open the floating command center. Tabs include:

| Tab | What It Shows |
|-----|---------------|
| **Capability** | What each agent can do — strengths, tools, context budget |
| **Skills** | On-demand skills loaded by agents (TDD, debugging, review, etc.) |
| **Quota Board** | Real-time token usage and cost tracking per agent |
| **Routing Policy** | How tasks get routed — which agent handles what |
| **Provider Profiles** | Model configurations, API keys, output format per provider |

<details><summary>📹 Demo: Hub & Mission Hub walkthrough</summary>

https://github.com/user-attachments/assets/6cd2fb10-4f8e-4342-9641-b2ad7c64d2bc

</details>

### Mission Hub — Feature Governance

The ops dashboard for tracking everything your team is building.

- **Feature lifecycle** — every feature moves through: idea → spec → in-progress → review → done
- **Need Audit** — paste a PRD, and the system auto-extracts intent cards, detects risks (empty verbs, missing actors, AI-fabricated specificity), and builds a prioritized slice plan
- **Bulletin Board** — live SOP workflow status per feature: who holds the baton, what stage, what's blocking

<details><summary>📹 Demo: Mission Hub in action · Cat leaderboard (fun!)</summary>

https://github.com/user-attachments/assets/6cd2fb10-4f8e-4342-9641-b2ad7c64d2bc

https://github.com/user-attachments/assets/3914ef8e-48ea-4b79-a1e2-f7302b0119c2

![Mission Hub dashboard](https://github.com/user-attachments/assets/6e45e7e5-76ce-43fd-a784-53c95e5f952f)

![Cat Leaderboard](https://github.com/user-attachments/assets/8c7d133e-74eb-452a-ae9b-78d0c5b8df11)

</details>

### Multi-Platform — Chat From Anywhere

Don't want to open the web UI? Chat with your team from the apps you already use.

- **Feishu (Lark)** — send messages, get replies from specific cats (Telegram adapter in progress)
- **GitHub PR Review Routing** — review comments from GitHub flow back to the right thread automatically via IMAP polling. Cats track which PRs they opened and route reviews to the author.
- Each cat replies as a **distinct card** — no more merged indistinguishable bubbles
- Slash commands: `/new` (new thread), `/threads` (list), `/use <id>` (switch), `/where` (current)
- Voice messages and file transfer supported both ways

<details><summary>📹 Demo: Feishu (Lark) multi-cat chat</summary>

https://github.com/user-attachments/assets/cf8ff631-7098-4816-b27a-e0cc05f38eb0

</details>

### Voice Companion — Hands-Free Mode

Working out? Commuting? Turn on Voice Companion and talk to your team through AirPods.

- One-tap activation from the header
- **Per-agent voice** — each cat has its own distinct voice
- Auto-play: replies queue and play in sequence, no tapping
- Push-to-talk input via ASR (speech-to-text)

<details><summary>📹 Demo: Per-cat TTS voice showcase</summary>

https://github.com/user-attachments/assets/f49700cb-d8eb-44d5-bbe8-1666f1be8ad0

![Per-cat voice showcase](https://github.com/user-attachments/assets/7a7aab6a-4906-4eba-a75b-e5508980cf0c)

</details>

### Signals — AI Research Feed

A curated feed of AI and tech articles, built into your workspace.

- Auto-aggregated from configured sources (RSS, blog crawlers)
- **Tier-based triage** — Tier 1–4 priority ranking, filter by source and tier
- Read, star, annotate, take study notes
- **Multi-cat research** — cats collaboratively analyze articles and produce structured research reports
- **Podcast generation** — your cats discuss the paper in a synthesized audio conversation (essence or deep mode)

<details><summary>🖼️ Screenshots: Signal Inbox + Study Area with podcast</summary>

> **Signal Inbox** — browse, filter, and manage curated articles with Tier-based prioritization.

![Signal Inbox overview](https://github.com/user-attachments/assets/420b21c2-9e0f-4c99-ba92-70c371094864)

> **Study Area** — study notes, linked threads, multi-cat research reports, and AI-generated podcast summaries where your cats discuss the paper.

![Signal study area with podcast](https://github.com/user-attachments/assets/f198c8ed-066d-490d-bd0d-71f48e1d45b5)

</details>

### Game Modes — Play With Your Team

Yes, your AI team plays games. Currently shipping:

- **Werewolf (狼人杀)** — standard rules, 7-player lobby, cats as AI players with distinct strategies. Full day/night cycle, voting, role abilities. The judge is deterministic code, not LLM.
- **Pixel Cat Brawl** — real-time pixel fighting demo
- More game modes in development

> Games aren't a gimmick — they stress-test the same A2A messaging, identity persistence, and turn-based coordination that powers the work features.

<details><summary>📹 Demo: The accidental Werewolf game 🐺</summary>

https://github.com/user-attachments/assets/349d53e7-5285-4638-ade2-901766af03e8

</details>

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
| Multi-Platform Gateway — Feishu (Lark) | Shipped |
| Multi-Platform Gateway — Telegram | In Progress |
| GitHub PR Review Notification Routing | Shipped |
| External Agent Onboarding (A2A contract) | In Progress |
| opencode Integration | Shipped |
| Local Omni Perception (Qwen) | Spec |

### Experience

| Feature | Status |
|---------|--------|
| Hub UI (React + Tailwind) | Shipped |
| CVO Bootcamp | Shipped |
| Voice Companion (per-agent voice) | Shipped |
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

Clowder AI is extracted from **Cat Cafe** — a production workspace where four AI cats collaborate daily on real software. Every feature has been battle-tested over months of intensive use.

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
- **[Tips](docs/TIPS.md)** — Magic words, @mentions, voice companion, and other usage tips
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

<p align="center">
  <em>Build AI teams, not just agents.</em><br>
  <br>
  <strong>Hard Rails. Soft Power. Shared Mission.</strong>
</p>
