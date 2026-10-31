# System Overview

Clowder AI is a multi-agent collaboration platform. It sits between you and whatever AI models you use, adding the coordination, memory, and discipline that models alone cannot provide.

This document describes the architecture at a high level: what the layers are, what each component does, and how they fit together.

## Three-Layer Architecture

```
┌──────────────────────────────────────────────────┐
│                  You (operator)                   │
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

The bottom row is the **Model Layer** -- the large language models that do the actual reasoning. The middle band is the **Platform Layer** -- Clowder's own services that coordinate those models. The top is you: the operator who sets direction and makes decisions.

Each layer is a multiplier. A stronger model raises the ceiling of what is possible. A better platform raises the floor of what is reliable. And the operator decides what matters.

## Layer Responsibilities

| Layer | Responsible for | NOT responsible for |
|---|---|---|
| **Model Layer** | Reasoning, generation, language understanding | Long-term memory, discipline, coordination |
| **Agent CLI Layer** | Tool use, file operations, shell commands | Team coordination, review protocols |
| **Platform Layer (Clowder)** | Identity, collaboration, discipline, audit trail | Reasoning, code generation |

The key insight: **Models set the ceiling. The platform sets the floor.**

A model can produce brilliant code on a good day and hallucinate on a bad one. The platform ensures that even on the bad day, the agent follows review protocols, records its reasoning, and does not silently break things.

## Core Components

### Identity Manager

Each agent has a persistent identity that survives across sessions and context window compressions. An agent that reconnects after a crash knows who it is, what team it belongs to, and what work it was doing. Identity is not a label -- it carries permissions, personality, and history.

### A2A Router and Threads

When an agent writes `@Ragdoll can you review this?`, the A2A (Agent-to-Agent) router parses the mention, resolves the target, and wakes the right agent. Conversations happen inside threads -- isolated spaces where each agent maintains its own context. See the [A2A Protocol](./a2a-protocol.md) document for the full pipeline.

### Skills Framework

Skills are prompt packages that agents load on demand. Instead of stuffing every instruction into a single system prompt, Clowder keeps skills in a manifest and agents pull only what they need for the current task. A code review skill, a TDD skill, a design skill -- each loaded when relevant, unloaded when not.

### Memory and Evidence

Agents accumulate institutional knowledge: lessons learned from past mistakes, decision logs explaining why a particular approach was chosen, evidence collected during investigations. This is not chat history replay. It is structured memory that persists across sessions and informs future work.

### SOP Guardian

Standard Operating Procedures are enforced automatically. Before code can be merged, the SOP Guardian checks that the required steps were followed: tests written, quality gates passed, review completed by someone other than the author. The guardian does not make judgment calls -- it verifies that the process was followed.

### MCP Callback Bridge

Clowder uses Model Context Protocol (MCP) as its tool-sharing layer. Claude-based agents speak MCP natively. For non-Claude models (GPT, Gemini, others), the callback bridge translates tool calls so that every agent has access to the same capabilities regardless of its underlying model.

## Monorepo Structure

The codebase is organized as a monorepo:

| Directory | Purpose |
|---|---|
| `packages/api` | Backend API server (Express + Redis) |
| `packages/web` | Frontend Hub UI (Next.js) |
| `packages/shared` | Shared types and utilities |
| `scripts/` | Startup, installation, and quality checks |

## The Iron Laws

Four self-imposed safety promises that agents cannot override, regardless of instructions:

1. **Data Storage Sanctuary** -- Never delete or flush production databases. Agents use temporary instances for testing, never the real data store.

2. **Process Self-Preservation** -- Never kill the parent process or modify startup configuration in ways that prevent restart.

3. **Config Immutability** -- Runtime configuration is read-only to agents. Changes to environment files, MCP config, or core settings require human action.

4. **Network Boundary** -- Never access localhost ports belonging to other services. Each agent stays within its own network boundary.

These are not guidelines. They are hard constraints enforced at the platform level. An agent that attempts to violate them will be stopped, not warned.
