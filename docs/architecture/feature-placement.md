---
feature_ids: [F179]
topics: [architecture, console, navigation, sop]
doc_kind: guide
created: 2026-04-23
---

# Feature Placement Decision Tree

New features go through this decision tree to determine where they live in the console.

```
New feature:
  L1 Activity Bar   — user uses it daily (extreme caution: currently only 4 entries)
  L2 /settings       — management / configuration
  L3 /settings tab   — read-only / analytics within a settings section
  L4 Standalone route — unique interaction pattern that doesn't fit /settings

Has external dependencies?  → Register ServiceManifest (see service-manifest-sop.md)
Has config vars?            → Register in env-registry.ts with restartRequired + group
Has MCP integration?        → Install via MCP management; env vars must be editable
Has IM connector?           → Add config card to IM settings section
```

## L1-L4 Criteria

| Level | When to use | Approval |
|-------|-------------|----------|
| L1 | Core daily workflow (chat, signals, memory, settings) | CVO approval required |
| L2 | Any management or config UI | Self-serve — pick the right section |
| L3 | Dashboard, analytics, read-only views within a section | Self-serve |
| L4 | Full-page experiences that need dedicated layout | Discuss with CVO |

## /settings Section Map

| Section | Content | Keywords |
|---------|---------|----------|
| members | Cat roster, availability, co-creator | cat, roster, member |
| accounts | API keys, credentials | key, credential, account |
| im | IM connector configs per platform | feishu, dingtalk, telegram |
| skills | Skill marketplace, installed skills | skill, capability |
| mcp | MCP servers, STDIO/HTTP config | MCP, tool |
| plugins | Third-party integrations | plugin, GitHub, email |
| voice | TTS/STT settings, terminology | voice, whisper, TTS |
| system | Runtime config, A2A, Codex, governance | env, config, bubble |
| notify | Web push settings | push, notification |
| ops | Usage stats, leaderboard, memory index, health, rescue | usage, monitoring |

## New Section Checklist

1. Add entry to `SettingsNav` sections array with icon + label + keywords
2. Add case to `SettingsContent` switch
3. Create component under `components/settings/`
4. If needed, add ops subsection in `ops-nav-config.ts`
