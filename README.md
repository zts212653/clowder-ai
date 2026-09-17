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
