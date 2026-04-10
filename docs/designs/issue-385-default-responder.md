# Issue #385: Configurable Default Responder for New Threads

Parent: F127 (Member Overview Refactor)

## Problem

The "global default responder" for new threads (no history, no @mention, no preferredCats) is currently derived from `breeds[0].defaultVariantId`, hardcoded to resolve to `opus`. This couples the default to breed order rather than an explicit runtime-configurable choice.

## Design

### Member Overview Card (Proposed)

- Default responder cat gets a `star + "默认回复"` orange badge next to its name
- Default cat card border: 2px `#D49266` (vs 1px `#F1E7DF` for non-default)
- Non-default cats: unchanged appearance

### Member Detail Panel (New Toggle)

- **Label**: "全局默认回复猫"
- **Description**: "仅影响新会话无历史时第一条消息，不影响已有 thread 的续接逻辑"
- **Toggle**: standard on/off
- **Info box** (when toggle is off and another cat is default): "当前默认: {name}（{catId}）。设为此成员后，{name}的默认状态将自动取消。若此成员不可用（available=false），将退回 breed 默认。"

### Visual reference

Pencil mockup: `/pencil-new.pen` (3 frames: Current State, Proposed State, Member Detail Panel)

## Technical Plan

### Storage

- Add `defaultResponderCatId?: CatId` at the **catalog top level** (CatCafeConfig)
- NOT a boolean on each RosterEntry (avoids mutual exclusion complexity)
- Single atomic write: set B = clear A implicitly

### New Resolver

- Create `getDefaultResponderCatId()` — dedicated to "new thread no-history" semantics
- Keep existing `getDefaultCatId()` unchanged — reviewer fallback etc. stay as-is
- Fallback chain: `defaultResponderCatId` (roster) -> `breeds[0].defaultVariantId` (breed) -> `'opus'` (hardcoded)

### Affected Call Sites

| Location | Current | Change |
|----------|---------|--------|
| `AgentRouter.ts` final fallback | `getDefaultCatId()` | `getDefaultResponderCatId()` |
| `ConnectorRouter.ts:277,373` | frozen `'opus'` | dynamic `getDefaultResponderCatId()` |
| `index.ts:1973` | `defaultCatId: 'opus'` | dynamic read |
| `ChatContainer.tsx:486` | `targetCats[0] \|\| 'opus'` | fetch from config |
| `reviewer-matcher.ts:72` | `getDefaultCatId()` | **NO CHANGE** (stays as-is) |

### API

- `PATCH /api/config` with `{ key: 'defaultResponderCatId', value: catId }` — reuses existing config patch endpoint
- Uniqueness enforced: single value, not per-member boolean

### Verification Checklist

- [x] Hub member overview: switch default -> refresh -> still shows correct member
- [x] New thread / no history / no @mention -> routes to configured default
- [x] Connector new external thread -> uses configured default, not frozen 'opus'
- [x] Default member unavailable (available=false) -> falls back to breed default
- [x] Reviewer fallback semantics NOT changed

## Scope Exclusions

- preferredCats semantics: unchanged
- Last-replier logic for existing threads: unchanged
- routingPolicy: unchanged
- Reviewer fallback: unchanged (stays on `getDefaultCatId()`)
