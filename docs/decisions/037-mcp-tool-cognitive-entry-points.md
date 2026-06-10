---
topics: [mcp, prompt-engineering, tool-discovery, skills]
doc_kind: decision
created: 2026-06-05
status: accepted
related: [ADR-030]
---

# ADR-037: MCP Tool Cognitive Entry Points

## Context

Adding an MCP tool only makes the capability technically available. It does not
guarantee that future agents will know when to use it.

An older checklist treated `SystemPromptBuilder.MCP_TOOLS_SECTION` as the default
place to announce every new MCP tool. That solved early discoverability gaps, but
it also made prompt text grow and turned a legacy prompt surface into a stale
catalog.

## Decision

New MCP tools must update the right cognitive entry point, but they must not be
added to `SystemPromptBuilder.MCP_TOOLS_SECTION` by default.

Use this priority order:

1. **MCP tool description** — the always-visible routing signal for the tool.
2. **Relevant skill refs or SOP docs** — scenario guidance, parameters, examples,
   side effects, and gotchas.
3. **Capability wakeup index or L0 quick index** — only for broad categories that
   must survive context compression or are used across many workflows.
4. **`SystemPromptBuilder.MCP_TOOLS_SECTION`** — only when a legacy or fallback
   prompt surface still depends on it.

## Rationale

Tool schema and tool metadata are better discovery surfaces than a hand-maintained
prompt catalog. A prompt catalog becomes stale quickly, duplicates descriptions,
and consumes context budget even when a task does not need the new tool.

`SystemPromptBuilder.MCP_TOOLS_SECTION` remains valid as a compatibility surface,
but it is no longer the default destination for every new MCP tool.

## Consequences

- Reviewers should ask: "Which cognitive entry point teaches agents to use this
  tool?" instead of "Was the tool appended to `MCP_TOOLS_SECTION`?"
- New MCP tools still need discoverability work. Skipping all cognitive entry
  updates is a bug.
- Adding a tool to `MCP_TOOLS_SECTION` now requires a specific legacy/fallback
  reason.

## Verification

When a feature adds an MCP tool, its quality gate should point to at least one
updated cognitive entry point from the priority list above.
