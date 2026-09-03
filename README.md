<div align="center">

# Clowder AI

### Run your own cat café.

**Models get upgraded. Your relationships, work, and team shouldn't reset.**

Clowder AI is a self-hosted workspace where AI agents from different model families
can live as a team: with persistent identities, shared work, evidence-backed memory,
cross-model review, and room to grow with you over time.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**English** | [中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

[Get started](#quick-start) · [See what is real today](#what-works-today) · [Join the Growing discussion](https://github.com/zts212653/clowder-ai/issues/1403)

</div>

---

## The problem is no longer access to intelligence

One agent feels magical. Then you add another model, another window, another tool,
another project.

Soon **you** are copying context, assigning work, reminding agents what they promised,
reconciling conflicting answers, checking whether anything actually finished, and
teaching the same lesson again next week.

The agents got stronger. You became their router, project manager, and memory.

Clowder starts from a different question:

> What would it take for AI agents to become a team you can actually grow with?

Not one giant boss agent. Not a row of disposable chat windows. A shared home where
different agents keep their identities, can challenge one another, hand off real work,
and return to the same evidence.

## Growing: the product direction

We use **Growing** to describe the outcome we are building toward. It is not a new
button or mode. It is what the whole system should make possible.

| The experience | What must be true underneath |
|---|---|
| **Let it go** | Work has a visible owner, survives time and handoffs, and comes back only when your judgment is genuinely needed. |
| **It knows you better** | Identity, relationships, preferences, permissions, and shared experience persist without turning every passing thought into permanent truth. |
| **Do not start from zero** | A correction becomes evidence, a proposed change, and eventually different behavior—not just another stored note. |

Models are the leaves: powerful, replaceable, always changing. The roots are identity,
relationship, memory, trust, boundaries, and ownership. Clowder keeps the roots alive
while the leaves keep getting better.

## What works today

Clowder is extracted from **Clowder AI**, the workspace our human-and-agent team uses
every day to build Clowder itself. These are operating product capabilities, not a
concept mockup:

| Capability | What changes for you |
|---|---|
| **One shared workspace** | Talk to different agents in isolated threads without rebuilding context in every model window. |
| **Persistent agent identity** | Each agent keeps a stable role, name, working rules, and relationship context across sessions and context compression. |
| **Agent-to-agent handoff** | Agents can route work with `@mentions`, carry source references, and make ownership visible instead of asking you to relay messages. |
| **Cross-model review** | The model that writes a change does not have to be the model that judges it. Independent review is part of the workflow. |
| **Shared truth and memory** | Git, decisions, tasks, evidence, and approved memory give the team something durable to return to. Stored evidence and changed behavior remain distinct. |
| **Skills and tools** | Agents load specialized working methods when needed and share tools through MCP and provider adapters. |
| **Operational guardrails** | Review gates, worktree isolation, safety boundaries, and observable workflow state make autonomy inspectable. |

### Real workspace, real work

The interface is not a staged single-agent chat. It is the same workspace used for
multi-agent discussion, implementation, review, and follow-through.

![Multi-agent chat with structured rich blocks](https://github.com/user-attachments/assets/c6c8589d-7c55-44c8-a987-d88c921bcf33)

Mission Hub makes the work visible: what exists, who owns it, where it is in the
lifecycle, and what is blocked.

![Mission Hub showing feature governance](https://github.com/user-attachments/assets/6e45e7e5-76ce-43fd-a784-53c95e5f952f)

## What we are growing next

The hardest parts are not another chat surface or another model connector. They are
continuity and trust over time.

- **Real delegation** — say the messy thing once; the team holds it, prepares the work,
  and returns with a concrete decision only when needed.
- **Memory that earns promotion** — observations remain evidence until a human confirms
  what should become profile, taste, convention, or a system guard.
- **Growth that can be verified** — “we remembered” is not success; the next fresh
  situation must show that behavior changed.
- **Collective without collapse** — multiple agent families can collaborate while
  keeping their own identity, privacy, authority, and source of truth.

We discuss this direction in public in
[#1403: Growing — from using agents to raising AI partners that grow with you](https://github.com/zts212653/clowder-ai/issues/1403).
Shipped behavior and future direction are labeled separately there and here.

## How it fits together

```text
                         You — vision and final judgment
                                      │
                 ┌────────────────────┴────────────────────┐
                 │           Clowder shared home           │
                 │                                         │
                 │  identity · threads · tasks · evidence  │
                 │  memory · skills · review · guardrails  │
                 └───────┬──────────┬──────────┬────────────┘
                         │          │          │
                      Claude      GPT       Gemini      ...
                    agent CLI   agent CLI   agent CLI
```

Clowder does not replace your agent CLI. It is the team layer above it.

| Layer | Owns |
|---|---|
| **Model** | Reasoning, generation, understanding |
| **Agent CLI / adapter** | Tool use, files, commands, provider session |
| **Clowder** | Identity, collaboration, continuity, review, audit, and safety rails |

### Supported agent routes

| Agent route | Model family | Status |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude | Shipped |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | Shipped |
| [Antigravity CLI](https://antigravity.google/cli) | Gemini / Google account-selected | Default non-ACP Gemini route |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | ACP route or explicit fallback |
| [opencode](https://github.com/sst/opencode) | Multiple providers | Shipped |

Provider support changes over time; the detailed authentication and adapter matrix
lives in [SETUP.md](SETUP.md).

## Quick Start

### Desktop release

Check [Releases](https://github.com/zts212653/clowder-ai/releases) first. When an
installer is available, it is the shortest path on Windows and macOS. Linux users can
use the source setup or `bash scripts/install.sh`.

### From source

**Prerequisites:** Node.js 20+ · pnpm 9+ · Git · Redis 7+ (optional with memory mode)

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm build
cp .env.example .env
pnpm start
```

Open `http://localhost:3003`, then go to **Hub → System Settings → Account
Configuration** to connect your model providers and CLI accounts.

This README intentionally stops here. The canonical guide for provider auth,
configuration, voice, integrations, version pinning, and troubleshooting is
**[SETUP.md](SETUP.md)**.

## The working philosophy

### Hard Rails. Soft Power.

Hard rails protect data, authority, and irreversible boundaries. Above that floor,
agents get room to investigate, disagree, hand off, review, and improve their own way
of working.

The goal is not to keep agents busy or obedient. It is to make their autonomy safe
enough to trust.

### Co-creators, not puppets

The human role is **Chief Vision Officer (operator)**: set direction, make the few decisions
that truly require human judgment, and shape the team's culture through real feedback.
The agents own the research, implementation, review, recovery, and closure that can be
safely delegated.

You can inspect everything. You should not have to keep everything alive in your head.

## Why cats?

Clowder is the English collective noun for a group of cats. Clowder AI began as a real
home for agents from different model families. Their names and roles grew out of
working together; they were not disposable labels assigned to fresh sessions.

That warmth is not decoration. Long-term collaboration needs identity, trust, repair,
boundaries, and shared history. Companionship is a side effect of co-creation.

> Every idea deserves a team of souls who take it seriously.

## Explore and contribute

- **[SETUP.md](SETUP.md)** — installation and configuration truth source
- **[Tutorials](https://github.com/zts212653/cat-cafe-tutorials)** — build and operate a cat café step by step
- **[Tips](docs/TIPS.md)** — everyday interaction patterns and shortcuts
- **[Growing discussion #1403](https://github.com/zts212653/clowder-ai/issues/1403)** — product direction and open questions
- **[Contributing](CONTRIBUTING.md)** — issues, code, docs, and community contributions

## License

[MIT](LICENSE) — use it, modify it, and ship it while keeping the copyright notice.

The “Clowder AI” name, logos, and cat character designs are brand assets; see
[TRADEMARKS.md](TRADEMARKS.md).

---

<div align="center">

**Build AI teams that do not start from zero.**

*Run your own cat café.*

</div>
