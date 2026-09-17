---
doc_kind: architecture
description: "F312 Phase F provider-local memory census：逐 runtime carrier 固定 authority、source/revision、privacy 与 E0 disposition，不建立跨 provider store。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-03T00:00:00Z
feature_ids: [F312]
related_features: [F186, F200, F287, F312]
related_docs:
  - docs/decisions/017-no-runtime-home-overwrite.md
  - docs/architecture/memory-standing-reflex-contract.md
  - docs/architecture/memory-write-lane-census.md
  - feature-discussions/2026-09-03-f312-phase-f-library-provider-e0.md
topics: [memory, provider, authority, privacy, census, standing-reflex]
created: 2026-09-03
status: current
---

# Provider-local Memory Census

## 1. 结论

Provider-local memory 是 provider/account 自有的 ambient surface，不是 Clowder AI 的中央 memory lane。
F312 只登记支持边界，既不复制 provider home 内容，也不把 session resume、L0 注入或 remote task
transport 误称为 provider-memory write/read/receipt。

七个 runtime carrier 的机器可读真相源是
`assets/memory-surfaces/provider-local-memory/provider-census.yaml`。
carrier universe 来自 `cat-template.json`；runtime carrier 是盘点单位，不能按 model 名合并。

## 2. E0 disposition

| Carrier | Provider-local authority | Clowder AI 可见的 durable item revision | Standing Reflex disposition |
|---|---|---|---|
| `claude-cli` | Claude Code + local account owner | provider-managed file state，不向 Clowder AI 提供 immutable revision | `exempt` |
| `codex-cli` | Codex + local account owner | 无 provider-memory item revision | `exempt` |
| `chatgpt-pro-remote` | ChatGPT remote account owner | Remote MCP 不暴露 item revision | `exempt` |
| `agy-cli` | AGY + local provider account owner | session identity 不是 knowledge revision | `exempt` |
| `antigravity` | Antigravity + provider account owner | cascade identity 不是 knowledge revision | `exempt` |
| `opencode` | OpenCode + local environment owner | session identity 不是 knowledge revision | `exempt` |
| `kimi-cli` | Kimi + local provider account owner | L0 fingerprint 只版本化 Clowder AI instructions | `exempt` |

共同判据：没有同时满足“可验证 typed candidate + named Clowder AI invocation consumer +
revision-bound authorized drill”的 carrier。于是 adapter、cue predicate、receipt、outcome 与 utility eval
都没有资格出生；这不是 provider 功能的 sunset。

## 3. 边界

- provider/account controls 是 correction/delete authority；Clowder AI 没有副本可失效。
- F186 collection 只接收 owner 显式 ingestion；provider-local content 不因搜索排名、provider presence
  或 session resume 自动进入 prompt。
- `ADR-017` 禁止 runtime 覆写 provider home。已存在的 provider-native memory 仍由 provider 自己读写。
- Clowder AI 可以保存 content-free session/execution coordinate，但那不是 provider-memory authority、content
  revision 或 consumption receipt。
- 未来某个 provider 若暴露可授权的 immutable item revision 与 named consumer，只重跑该 carrier E0；
  不建立跨 provider canonical store、统一 cue engine 或统一 approval authority。

## 4. Evidence ceiling

本阶段能证明的是 main docs/code inspection + executable catalog closure。没有 active pair，因此没有
runtime candidate、drill、receipt 或 bounded outcome 可验；伪造一次 applied episode 会违反 E0。

tips_exempt:

- docs-only architecture census；不新增用户可操作入口或行为变更。
