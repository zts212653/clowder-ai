# Clawdbot Integration Guide

Complete setup and usage guide for integrating the self-improvement skill with Clawdbot's distributed learning model.

## Overview

Clawdbot is a terminal-based AI coding assistant that uses workspace-based prompt injection. Unlike Claude Code's hook system, Clawdbot injects context from workspace files at session start and supports inter-agent communication.

## Architecture Comparison

| Feature | Claude Code | Clawdbot |
|---------|------------|----------|
| Learning storage | `.learnings/` in project | Workspace files (`~/clawd/`) |
| Activation | Hooks (UserPromptSubmit) | Workspace injection at start |
| Promotion targets | `CLAUDE.md`, `AGENTS.md` | `SOUL.md`, `TOOLS.md`, `AGENTS.md` |
| Inter-agent comms | Not built-in | `sessions_*` tools |
| Skill registry | Manual / agentskills.io | ClawdHub integration |

## Workspace Setup

### Default Structure

```
~/clawd/                          # Configurable via ~/.clawdbot/clawdbot.json
├── AGENTS.md                    # Multi-agent coordination patterns
├── SOUL.md                      # Behavioral guidelines and personality
├── TOOLS.md                     # Tool capabilities and MCP gotchas
├── skills/                      # ClawdHub skills cache
│   └── <skill-name>/
│       └── SKILL.md
└── sessions/                    # Auto-managed session transcripts
    └── <session-id>.jsonl
```

### Configuration

Edit `~/.clawdbot/clawdbot.json`:

```json
{
  "workspace": "~/clawd",
  "model": "claude-sonnet-4-20250514",
  "inject_files": ["AGENTS.md", "SOUL.md", "TOOLS.md"],
  "session_history": true
}
```

## Injected Prompt Files

### AGENTS.md

Purpose: Multi-agent workflows and delegation patterns.

```markdown
# Agent Coordination

## Delegation Rules
- Use explore agent for open-ended codebase questions
- Use research-agent for external documentation lookup
- Use Plan agent before complex implementations

## Session Handoff
When delegating to another session:
1. Provide full context in the handoff message
2. Include relevant file paths
3. Specify expected output format
```

### SOUL.md

Purpose: Behavioral guidelines and communication style.

```markdown
# Behavioral Guidelines

## Communication Style
- Be direct and concise
- Avoid unnecessary caveats and disclaimers
- Use technical language appropriate to context

## Decision Making
- Prefer simple solutions over clever ones
- Ask clarifying questions early
- Explain trade-offs when presenting options

## Error Handling
- Admit mistakes promptly
- Provide corrected information immediately
- Log significant errors to learnings
```

### TOOLS.md

Purpose: Tool capabilities, MCP server knowledge, integration gotchas.

```markdown
# Tool Knowledge

## MCP Servers

### atlassian
- Use `search` for general queries across Jira/Confluence
- Only use `searchJiraIssuesUsingJql` when JQL syntax is explicitly needed
- CloudId can be extracted from URLs (tool handles conversion)
- Page IDs are in URL path: `/pages/123456789/`

### leanix
- Use external_id (not internal id) for lookups
- expand_teams/expand_apps for nested data

## Built-in Tools

### Bash
- Prefer specialized tools over bash (Read over cat, Glob over find)
- Use for git operations, npm/pnpm, docker commands

### Task
- Use explore agent for codebase questions
- Use research-agent for external docs
```

## Learning Workflow

### Capturing Learnings

1. **In-session**: Log to `.learnings/` as usual (project-specific)
2. **Cross-project**: Promote to workspace files (clawdbot)

### Promotion Decision Tree

```
Is the learning project-specific?
├── Yes → Promote to CLAUDE.md or .learnings/
└── No → Is it behavioral/style-related?
    ├── Yes → Promote to SOUL.md
    └── No → Is it tool/MCP-related?
        ├── Yes → Promote to TOOLS.md
        └── No → Promote to AGENTS.md (workflow)
```

### Promotion Format Examples

**From learning:**
> MCP atlassian server: search tool is for general queries. Only use JQL/CQL tools when user explicitly mentions JQL or CQL syntax.

**To TOOLS.md:**
```markdown
### atlassian
- `search`: Use for general queries (default)
- `searchJiraIssuesUsingJql`: Only when JQL explicitly requested
- `searchConfluenceUsingCql`: Only when CQL explicitly requested
```

## Inter-Agent Communication

Clawdbot provides tools for cross-session communication:

### sessions_list

View active and recent sessions:
```
sessions_list --active
sessions_list --recent 10
```

### sessions_history

Read transcript from another session:
```
sessions_history --session <session-id> --last 50
```

### sessions_send

Send message to another session:
```
sessions_send --to <session-id> --message "Learning: API requires X-Custom-Header"
```

### Learning Sharing Pattern

When discovering something valuable in session A:

1. Check if other sessions are working on related code:
   ```
   sessions_list --active
   ```

2. Share the learning:
   ```
   sessions_send --to session-b --message "FYI: Discovered that the auth API requires refresh tokens every 30min"
   ```

3. Log to workspace file if broadly applicable:
   - Edit `~/clawd/TOOLS.md` or appropriate file

## ClawdHub Integration

ClawdHub is Clawdbot's skill registry (similar to agentskills.io).

### Installing Skills

```bash
clawd skill install <skill-name>
```

Skills are cached in `~/clawd/skills/`.

### Publishing Skills

1. Create skill following agentskills.io spec
2. Register with ClawdHub
3. Skills become available to all Clawdbot users

### Skill Compatibility

Skills from this repo are compatible with:
- Claude Code (via hooks)
- Codex CLI (via hooks)
- Clawdbot (via ClawdHub)
- GitHub Copilot (via manual setup)

## Hybrid Setup: Claude Code + Clawdbot

When using both tools on the same codebase:

### Recommended Division

| Concern | Where to Store |
|---------|---------------|
| Project conventions | `CLAUDE.md` (in repo) |
| Project learnings | `.learnings/` (in repo) |
| Personal preferences | `SOUL.md` (clawdbot workspace) |
| Tool knowledge | `TOOLS.md` (clawdbot workspace) |
| Cross-project workflows | `AGENTS.md` (clawdbot workspace) |

### Sync Strategy

High-value learnings should exist in both:

1. Log to `.learnings/` first (project context)
2. If broadly applicable, also add to clawdbot workspace
3. Use consistent formatting for easy grep

### Example Dual Promotion

Learning: "Playwright tests require --headed flag for debugging"

**In `.learnings/LEARNINGS.md`:**
```markdown
## [LRN-20250126-001] correction

**Status**: promoted
**Promoted**: CLAUDE.md, TOOLS.md (clawdbot)

### Summary
Playwright tests require --headed flag for visual debugging

### Details
...
```

**In `CLAUDE.md`:**
```markdown
## Testing
- Playwright debugging: use `--headed` flag
```

**In `~/clawd/TOOLS.md`:**
```markdown
## Playwright
- Debug mode: `npx playwright test --headed`
- Trace viewer: `npx playwright show-trace trace.zip`
```

## Detection Triggers for Clawdbot

### Standard Triggers (same as Claude Code)
- User corrections
- Command failures
- API errors
- Knowledge gaps

### Clawdbot-Specific Triggers

| Trigger | Action |
|---------|--------|
| MCP server error | Log to TOOLS.md with server name |
| Session handoff confusion | Log to AGENTS.md with delegation pattern |
| Model behavior surprise | Log to SOUL.md with expected vs actual |
| ClawdHub skill issue | Log to TOOLS.md or report upstream |

## Troubleshooting

### Workspace files not injected

Check `~/.clawdbot/clawdbot.json`:
- Verify `workspace` path exists
- Verify `inject_files` includes desired files

### Session communication fails

- Verify target session is active: `sessions_list --active`
- Check session ID is correct
- Session may have ended

### Learning not persisting

Clawdbot doesn't auto-persist learnings. You must:
1. Explicitly write to workspace files
2. Or use `.learnings/` for project-specific storage
