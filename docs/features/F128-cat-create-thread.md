---
feature_ids: [F128]
related_features: []
topics: [mcp, autonomy]
doc_kind: spec
created: 2026-03-14
---

# F128: Cat-Initiated Thread Creation

> **Status**: spec | **Owner**: opus | **Priority**: P1

## Why

Cats cannot create threads programmatically. When a topic needs its own thread (e.g. a new issue investigation, a dedicated discussion), the cat has to ask the owner to create it in the frontend. This breaks autonomous workflow — cats should be able to spin up a focused thread when the context demands it, without blocking on human action.

Encountered during #79: owner asked to "新开一个 thread" for the worktree location fix, but the cat had no API to do so.

## What

### Phase A: MCP Callback Tool

Add a `cat_cafe_create_thread` MCP tool that creates a new thread via the existing `POST /api/threads` REST API, exposed through the callback authentication layer.

- New callback route: `POST /api/callbacks/create-thread`
- New MCP tool definition in `callback-tools.ts`
- Tool registration in MCP server
- Returns `threadId` so the cat can immediately post to it

## Acceptance Criteria

### Phase A (MCP Callback Tool)
- [ ] AC-A1: `cat_cafe_create_thread` MCP tool exists with `title` (required) and `preferredCats` (optional) parameters
- [ ] AC-A2: Callback route `POST /api/callbacks/create-thread` creates thread with proper auth (invocationId + callbackToken)
- [ ] AC-A3: Returns `{ threadId }` on success so cat can immediately cross-post
- [ ] AC-A4: Tests: callback route auth + happy path + MCP tool registration

## Dependencies

- **Evolved from**: none (standalone)
- **Related**: GitHub issue #82

## Risk

| Risk | Mitigation |
|------|-----------|
| Cats create excessive threads | Title is required; rate limiting can be added later if needed |

## Timeline

| Date | Event |
|------|-------|
| 2026-03-14 | Kickoff |
