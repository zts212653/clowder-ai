---
title: Provider effective configuration and application boundaries
status: active
created: 2026-11-04
owner: codex61-sol
description: 成员、账户与 MCP 的有效配置捕获、有限进程依赖、客户端应用边界和安全切换契约。
description_source: model
description_author: codex61-sol
description_updated_at: 2026-11-05T03:45:06Z
description_generated_by: codex61-sol
description_generated_at: 2026-11-05T03:45:06Z
description_confirmed_by: codex61-sol
---

# Provider effective configuration and application boundaries

Architecture cell: identity-session, with plugin contribution descriptors as inputs.
Map delta: integrated. `FrozenExecutionBinding`, the member catalog, account adapters, existing service generations and process leases retain their ownership.
Why: process compatibility must depend on the inputs actually consumed by that process, while an admitted invocation must keep its captured configuration.

## One view, existing owners

`prepareInvocationExecutionBinding` captures the member, selected account, workspace, execution preferences, instruction input and provider MCP descriptors before waiting for a provider lease. It checks the source versions again before accepting that view. `invokePreparedSingleCat` and the concrete adapter consume this same binding. There is no second configuration store, reload coordinator or durable credential digest.

MCP environment and header references are evaluated during capture, using the admitted member/account environment before ordinary Host variables. The capture observes only referenced Host keys and actual configuration files. A change during capture rejects admission; a change after acceptance cannot change the old descriptors. Materialization adds the current invocation's callback authority without expanding ordinary references again. Secret values containing `${...}` remain opaque after their one expansion.

Ordinary configuration references and callback authority have different owners. A foreign MCP server does not gain callback credentials by selecting a first-party-looking name. The installed-entrypoint and plugin authority checks remain the only binders.

## Finite process dependencies

`acp-construction-environment.ts` projects explicit OS launch/config roots, transport/certificate variables, client credential mappings, known native client inputs and the destination keys declared by the member/account adapter. Absence is represented as `null` in this private projection. Both freshness and the pool's process-local HMAC use that exact projection. The full frozen spawn environment is retained separately for the actual cold start.

Windows key aliases follow [Node 24's child-process environment contract](https://nodejs.org/download/release/v24.16.0/docs/api/child_process.html): matching ignores case and a sorted duplicate has one effective value. Shell guard companion paths remain explicit dependencies when the guard rewrites `ZDOTDIR`.

Account selection and consumed credentials are part of compatibility. Account display names are not. OpenCode's process-scoped model/config inputs remain included because its runtime config actually consumes them. Object declaration order cannot create a new process generation. ACP `mcpWhitelist` belongs to the session capture, so changing it does not retire an otherwise compatible process.

Unknown third-party programs can read undocumented ambient variables. Existing configurations continue to inherit the first spawn's frozen compatibility environment; Host does not claim to infer those hidden dependencies. To make a value track reconfiguration, declare it explicitly on the member:

```json
{
  "env": {
    "VENDOR_ENDPOINT": "${MY_VENDOR_ENDPOINT}",
    "https_proxy": "${MY_PROXY}"
  }
}
```

This optional field is stored on the existing member variant and supports the existing catalog/API create, update and removal paths. It is not copied to siblings and does not expose values in the public member projection. `null` on PATCH removes the declaration. Existing account `${api_key}` / `${base_url}` templates keep their original semantics, including unsupported placeholders that were previously literal.

The selected account adapter has precedence over member inputs, including an omitted endpoint selecting the adapter's default destination. OAuth identity/endpoint overrides belong in the account, not member `env`. Host control keys and their aliases are rejected. AGY's isolated carriers reject member environment overrides. Qualified native Kimi retains its stricter account/environment equivalence check. These declarations do not relax any native carrier's restrictions.

## Application boundaries are carrier-specific

The table describes actual Host delivery paths, not a promise that an arbitrary external binary reloads every asset. A requested descriptor becomes applied only at the adapter's real launch/protocol seam. Existing adapter responses and binding errors remain the authority.

| Carrier | Instructions / MCP | Skills / Hooks | Safe update boundary |
| --- | --- | --- | --- |
| Claude CLI | Each launch, including resume, sends current L0 with snapshot disabled and the admitted MCP config | Native skill discovery remains CLI-managed; managed settings/hooks are composed per launch | New invocation/process; already running calls keep their launch |
| Claude SDK | Each query sends `systemPrompt.snapshot:false` and admitted MCP config | Settings/hooks are composed per query; native skills remain external discovery | New query, including resume; no mutation of a running query |
| Claude PTY / background | Own carrier launch path consumes the same admitted MCP descriptors | PTY's existing cwd settings setup/restore is distinct from CLI/SDK; background daemon discovery is not proven reloadable | Carrier launch boundary; no general hot-reload claim |
| Codex exec | Each launch sends current developer instructions and admitted MCP | Native Skills/Hooks discovery is externally managed | New invocation/process |
| Codex app-server | Both `thread/start` and `thread/resume` send instructions/config; bounded watcher dynamic tools remain start-only | Native discovery is not an update API; `skills/list` observation is not reload | Invocation/thread RPC for supported fields; account/env changes drain the existing host pool |
| ACP with load | `session/load` receives the admitted MCP view | No generic Skills/Hooks protocol | New/load protocol seam |
| ACP resume-only | Inactive history can use `session/resume`; active sessions reuse only an identical cwd/MCP binding | No generic Skills/Hooks protocol | Changed active binding requires an explicit fresh session |
| ACP without load/resume | Only an identical, healthy live session can be reused | No generic Skills/Hooks protocol | Unsupported changes reject with history preserved; no silent session replacement |
| iCode ACP | New/load accepts remote overlays; third-party stdio is explicitly reported unsupported | External/native managed | Its existing remote overlay and live-instance lifecycle |
| Kimi CLI | Each invocation sends MCP/env; bound agent/L0 changes require fresh session or exact-resume rejection | Agent-file is not resent with `--session`; native discovery is externally managed | Existing fingerprint and exact-resume checks |
| AGY Native / ACP | Identity, model, workspace, profile and permissions remain bound to the native session | Native skill mount descriptors are materialized per launch; ACP's profile projection is process-scoped. Symlinks do not freeze arbitrary source-file bytes | Existing native binding checks; incompatible old sessions reject explicitly |
| OpenCode CLI / ACP | CLI gets an invocation config; ACP provider/model/credential config is process-scoped | Native discovery remains external | CLI invocation or ACP generation; external attach is not Host-controlled reload |
| A2A / CatAgent | Remote messages / API loop inputs only | Native MCP/Skills/Hooks are unsupported or externally managed | No native reload claim |

## Switching and recovery

`StaleServiceSourceConflict` requests the existing `AgentRegistry.refreshForAdmission` path. Ordinary configuration competition does not rebuild a service. A compatible pool is reused; an incompatible generation retires through the existing lease owner and `retireWhenIdle`. New work waits for proven old-process retirement where required. Already admitted work retains its service and descriptors. No completed prompt is replayed to implement reconfiguration.

Queue/History recovery has its own authority and acceptance. Changing provider configuration does not prove a failed A2A source was delivered, nor authorize a second replay writer. Existing cancellation/recall/tombstone and dispatch-reference guards remain intact.

## Executable evidence

- `acp-effective-configuration.test.js`: unrelated Host changes, declared references, account metadata versus credentials, declaration order, session whitelist versus process identity.
- `acp-mcp-freeze.test.js`: actual capture → lease wait → session delivery, including ordinary env and remote header references.
- `provider-environment-capture.test.ts`: finite reference observation, absent sources, capture races, single expansion and authority aliases.
- `cat-config-loader.test.js`, `execution-account-selection.test.ts`, `cats-routes-runtime-catalog.test.js`: existing persistence, sibling isolation, frozen account precedence and public projection privacy.
- Existing ACP client/cache, Kimi/AGY binding, Claude SDK settings, Codex host-pool and native MCP launch fixtures verify the carrier-specific boundaries above. Fixtures prove Host delivery and protocol handling; they do not substitute for arbitrary external binary/model behavior.

The implementation plan and per-run verification records are in the accepted plan (internal). Runtime deployment is a separate operator action.
