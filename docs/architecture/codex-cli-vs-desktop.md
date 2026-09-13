---
topics: [architecture, cli, integration, codex]
doc_kind: note
created: 2026-08-23
---

# Codex CLI vs Codex Desktop

This is the gap analysis for OpenAI's two local hosts — **Codex CLI** and **Codex Desktop** — as they relate to cat-cafe's Maine Coon dispatch. "Desktop" here means OpenAI Codex Desktop, not cat-cafe's Electron installer.

## Same harness, different hosts

Codex CLI (`codex`) and Codex Desktop share one agent runtime:

- Same ChatGPT / Codex account and rate limits.
- Same `~/.codex` tree: `config.toml`, skills, session history, MCP.
- Same project rules file. F050 records that both the CLI and the App read `~/.codex/AGENTS.md` (App Personalization is the Desktop extra field on that same file).
- Same OS sandbox. OpenAI documents Desktop using the same open-source sandbox as the CLI.

They are not the same product surface. Desktop is a GUI command center (diff review, artifacts, automations, git workflows). CLI is a TUI plus a headless `codex exec` JSON stream. Cat-cafe never launches the Desktop app; Maine Coon is a spawned `codex` subprocess.

## App Server vs `codex exec --json`

Two local wire protocols, both from the same CLI binary:

| Host / mode | How it talks | Process model | What cat-cafe uses |
|-------------|--------------|---------------|-------------------|
| Codex Desktop / IDE | App Server JSON-RPC (`codex app-server`) | Long-lived, duplex, `turn/interrupt`, steer | F254 D2 canary only |
| Headless CLI | `codex exec --json` NDJSON | One process per turn | **Default** Maine Coon path |

Repo evidence:

- Maine Coon default args in `cat-template.json`: `"defaultArgs": ["exec", "--json"]`.
- Env default in `packages/api/src/config/env-registry.ts`: `CAT_CAFE_CODEX_CARRIER=exec_json`. Allowed values: `exec_json` \| `app_server`. Per-cat override is `cli.carrier`.
- Resolver: `packages/api/src/config/codex-cli.ts` `resolveCodexCarrierTruth` — per-cat `cli.carrier` > env > `exec_json`.
- Assembly in `packages/api/src/index.ts`: `clientId === 'openai'` builds `CodexAgentService` with that carrier. Generic ACP (`getAcpConfig`) wins first and never reaches the Codex carrier.

`app_server` is the protocol Desktop already uses internally. Cat-cafe's canary reuses it so same-turn notice / interrupt / no-replay can be authoritative. It is **not** ACP. Code default remains `exec_json`; rolling `app_server` out as default is an explicit non-goal.

## Shared auth / config / skills / MCP

| Asset | Shared? | Notes |
|-------|---------|--------|
| Login / OAuth | Yes | Same `~/.codex` credentials |
| `config.toml` MCP | Yes | CLI `--config` merges with this file (F249: union, not replace) |
| Skills | Yes | Installed once, visible in both hosts |
| `AGENTS.md` | Yes | CLI + App Personalization (F050) |
| Session threads | Mostly | Desktop picks up CLI/IDE history; cat-cafe's spawned exec sessions are **not** the Desktop thread you clicked |

Sharing HOME also shares failure modes. CLI HOME isolation (copy/symlink of `.codex/`) has repeatedly been overwritten when the CLI rebuilt the directory. F177 KD-14a: forcing `openai_https` on Sol made 9/9 invocations miss model capacity while Codex Desktop's built-in provider on the same machine succeeded — same credentials, different host transport.

## Surfaces that exist on only one host

**CLI / `codex exec` only (or first):**

- Headless NDJSON (`exec --json`) that cat-cafe's `CodexAgentService` already parses.
- Scriptable resume via `codex exec resume SESSION_ID`.
- Lower resource footprint; no GUI.

**Desktop / App Server only (or first):**

- Visual diff review, artifacts panel, automations, git workflow UI.
- Bidirectional turn control: `turn/interrupt`, `turn/steer(expectedTurnId)`.
- App Personalization UI on top of `AGENTS.md`.
- Some collab tool-call classifiers (F254 live canary saw `collabAgentToolCall` on app-server that `exec_json` does not expose the same way).

**Neither is cat-cafe Desktop.** The Electron installer is the same API + Hub wrapping spawned CLIs.

## What Maine Coon actually dispatches

```
Hub @codex
  → AgentRegistry (index.ts)
      → getAcpConfig?  no for Maine Coon
      → clientId openai
          → CodexAgentService({
               carrierMode: resolveCodexCarrierTruth(cli.carrier).effective
             })
```

- **Default:** `exec_json` → `codex exec --json --sandbox … --full-auto`.
- **Canary:** operator sets `CAT_CAFE_CODEX_CARRIER=app_server` or Hub member `cli.carrier=app_server` → App Server JSON-RPC, closer to Desktop, still not the Desktop GUI.

Opening Codex Desktop beside Hub does not make those turns Maine Coon turns. They do not share session chain, @mention routing, or cat-cafe MCP callback identity unless the same files happen to land in the workspace.

## Practical rule

Use Desktop when a human wants the first-party GUI. Use CLI `exec --json` when cat-cafe needs a parseable, killable, one-turn child. Use App Server only when the F254 parity matrix for interrupt/steer/same-turn notice is the reason to change carrier — and keep that behind the existing env/per-cat gate.
