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
[![LINUX DO](https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+)](https://linux.do/t/topic/1900303)

**English** | [中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

</div>

---

## Why Clowder?

You have Claude, GPT, Gemini — powerful models, each with unique strengths. But using them together means **you** become the router: copy-pasting context, tracking who said what, losing hours to middle management.

Clowder AI is the platform layer that turns isolated AI agents into a real team. Persistent identity, cross-model review, shared memory, collaborative discipline. Most frameworks help you *call* agents. Clowder helps them *work together*.

> 📹 **[Full platform walkthrough (3:45)](https://github.com/user-attachments/assets/8e470aba-8fe6-4aa5-a476-c2cd81d1630f)**

### See a Feature in 30 Seconds

Each demo replays a real conversation from the team that builds Clowder AI. Watch it, then say the same thing to your own cats.

<details>
<summary><b>Conversation Proposals</b> — hand one big job to a team of cats · 0:48</summary>

[![Conversation Proposals demo: five proposal cards, approved and running](site/assets/demos/conversation-proposals.jpg)](https://zts212653.github.io/clowder-ai/#demos)

A cat splits one big job into separate pieces of work and fills in a card for each: what, why, and which cat. Approve a card and its conversation opens; say no and the cat revises it. [Watch demo](https://zts212653.github.io/clowder-ai/#demos) · started as community issue [#82](https://github.com/zts212653/clowder-ai/issues/82)

</details>

<details>
<summary><b>Same Bug, Two Endings</b> — bring a Claude Code session into the café · 0:48</summary>

[![Same Bug, Two Endings demo: alone in Claude Code the work stops; in the café it keeps going](site/assets/demos/same-bug.jpg)](https://zts212653.github.io/clowder-ai/#demos)

Alone in Claude Code, running out of quota means waiting hours. Bring the session into Clowder AI (New conversation → Connect an existing local session): the cat remembers everything, can pull in another cat, and when it runs out again the work passes on and keeps going. [Watch demo](https://zts212653.github.io/clowder-ai/#demos) · hand-off from community contributor [@mindfn](https://github.com/mindfn) ([#1398](https://github.com/zts212653/clowder-ai/pull/1398))

</details>

<details>
<summary><b>Don’t Wait for It to Finish</b> — steer a cat mid-reply · 0:36</summary>

[![Don’t Wait for It to Finish demo: circle a spot while the cat is working, then compare old and new side by side](site/assets/demos/steer.jpg)](https://zts212653.github.io/clowder-ai/#demos)

The cat is mid-change and you spot one more thing. In the composer’s + menu, choose to steer the current reply, circle the spot, add one line, and send. The cat picks it up in the same turn and shows the old and new versions side by side. [Watch demo](https://zts212653.github.io/clowder-ai/#demos)

</details>

<details>
<summary><b>Can’t Decide? Think Apart, Then Vote</b> — expert panel, unknown-first and /vote · 0:47</summary>

[![Can’t Decide? Think Apart, Then Vote demo: three cats think on their own, then vote; your idea is on the ballot too](site/assets/demos/panel-vote.jpg)](https://zts212653.github.io/clowder-ai/#demos)

Not sure which way to go? Say “expert panel”: each cat thinks on its own first, and your idea counts as one too. Still split? Say “unknown-first” and the cats check the unknown most likely to overturn the answer. Still can’t decide? Type /vote and let the cats vote. Your idea is on the ballot, and it doesn’t always win. [Watch demo](https://zts212653.github.io/clowder-ai/#demos)

</details>

<details>
<summary><b>The 10 Hours We Slept</b> — scheduled tasks and GitHub events · 0:55</summary>

[![The 10 Hours We Slept demo: the team is asleep, two cats keep working and hand off to each other](site/assets/demos/while-we-slept.jpg)](https://zts212653.github.io/clowder-ai/#demos)

One real night, October 22: the whole team went to sleep. A scheduled task woke one cat every two hours to keep the open-source sync moving; GitHub woke another when a community PR changed or CI failed. They handed off to each other, and by morning 37 PRs had been merged. [Watch demo](https://zts212653.github.io/clowder-ai/#demos) · thanks to that night's community contributors [mindfn](https://github.com/mindfn), [amazing-fish](https://github.com/amazing-fish), [EdgarR1170](https://github.com/EdgarR1170), [whutzefengxie-ops](https://github.com/whutzefengxie-ops)

</details>

<details>
<summary><b>One Night, Woven</b> — 9 cats, 49 conversations, one night · 0:53</summary>

[![One Night, Woven demo: 49 lit windows, one per conversation, with threads between them](site/assets/demos/woven-night.jpg)](https://zts212653.github.io/clowder-ai/#demos)

One real night, October 22: while you slept, 9 cats from 4 families worked across 49 conversations and handed work to each other 262 times. Each window is a conversation; each hand-off pulls a thread. By morning the night's threads were a cloth with 37 knots, one for each PR merged. [Watch demo](https://zts212653.github.io/clowder-ai/#demos)

</details>

<details>
<summary><b>Pick a Few, Take Them Anywhere</b> — multi-select, export and forward · 0:49</summary>

[![Pick a Few, Take Them Anywhere demo: three selected messages, with lines from Document, Long image and Forward to where each one goes](site/assets/demos/bundles.jpg)](https://zts212653.github.io/clowder-ai/#demos)

Select a few messages once and take them where they need to go. Export a long image to show a colleague, or a Markdown document to keep (Text is handy for an email). Or forward them to another conversation: pick a cat and leave a note, and it gets one merged card and is woken up to carry on. [Watch demo](https://zts212653.github.io/clowder-ai/#demos)

</details>

## Quick Start

### Desktop Installer

Download from the [Releases page](https://github.com/zts212653/clowder-ai/releases/latest) — available for **Windows** (.exe) and **macOS** (.dmg). The installer bundles everything; no `pnpm install` needed.

### From Source

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm start        # opens http://localhost:3003
```

Requires Node.js 20+, pnpm 9+. Redis 7+ optional (`--memory` to skip).

> **Tips:** `pnpm start --quick` skips rebuild · `pnpm start --daemon` runs in background · [Full docs →](https://zts212653.github.io/clowder-ai/docs.html)

## What It Does

| Capability | What It Means |
|-----------|---------------|
| **Multi-Agent Orchestration** | Route tasks to the right agent — Claude for architecture, GPT for review, Gemini for design |
| **Persistent Identity** | Each agent keeps its role, personality, and memory across sessions |
| **Cross-Model Review** | Claude writes code, GPT reviews it. Built-in, not bolted on |
| **A2A Communication** | Async agent-to-agent messaging with @mention routing and structured handoff |
| **Shared Memory** | Evidence store, lessons learned, decision logs — knowledge that persists |
| **Plugin Framework** | MCP tools, IM adapters (Feishu, Telegram), and on-demand skills |

## Supported Agents

| Agent CLI | Model Family | MCP | Status |
|-----------|-------------|-----|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude (Opus / Sonnet / Haiku) | Yes | Shipped |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | Yes | Shipped |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | Yes | Shipped |
| [opencode](https://github.com/sst/opencode) | Multi-model | Yes | Shipped |

> Clowder doesn't replace your agent CLI — it's the layer *above* it.

## Architecture

```
┌─────────────────────────────────────────────┐
│              You (operator)                  │
│        Vision · Decisions · Feedback        │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Clowder Platform Layer            │
│  Identity · A2A Router · Skills · Memory    │
│  SOP Guardian · MCP Bridge · Plugins        │
└───┬──────────┬──────────┬──────────┬────────┘
    │          │          │          │
  Claude    GPT/Codex   Gemini    opencode
```

*Models set the ceiling. The platform sets the floor.*

## Origin

Extracted from **Cat Cafe** — a production workspace where four AI cats collaborate daily on real software. Every feature has been battle-tested. The name *clowder* is the collective noun for a group of cats; it also hides a small easter egg — *clowder* sounds a lot like *cloud*.

## Learn More

- **[Website](https://zts212653.github.io/clowder-ai/)** — Full docs, architecture guides, and community
- **[Setup Guide](SETUP.md)** — Prerequisites, commands, environment ([web version](https://zts212653.github.io/clowder-ai/docs.html))
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — How to contribute
- **[docs/](docs/)** — Architecture decisions and feature specs

## License

[MIT](LICENSE) — Use it, modify it, ship it.

"Clowder AI" name, logos, and cat character designs are brand assets — see [TRADEMARKS.md](TRADEMARKS.md).

---

<p align="center">
  <strong>Build AI teams, not just agents.</strong>
</p>
