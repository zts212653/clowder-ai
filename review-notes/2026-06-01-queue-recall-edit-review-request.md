# Review Request: Queue Recall-To-Edit

Review-Target-ID: fix-706-recall-edit
Branch: fix/706-recall-edit
Source Worktree: `/Users/lang/workspace/github/cat-cafe-706-recall-edit`

## What

Implemented the narrow queued-message "撤回编辑" path:

- User-sourced queue rows now expose a `撤回编辑` action.
- The action removes the queued entry through the existing queue DELETE endpoint.
- On success, the entry text is inserted back into the current thread composer via existing `pendingChatInsert`.
- Existing plain "撤回" behavior is unchanged.
- Added focused QueuePanel and ChatInput regression coverage.

Changed files:

- `packages/web/src/components/QueueEntryRow.tsx`
- `packages/web/src/components/QueuePanel.tsx`
- `packages/web/src/components/__tests__/queue-panel-withdraw.test.ts`
- `packages/web/src/components/__tests__/chat-input-draft-persistence.test.ts`

## Why

This implements GitHub #706方案 A only. CVO explicitly scoped out方案 B / inline queue editing for this batch.

## Original Requirements

> 队列中等待处理的消息应该支持直接编辑或"撤回到输入框重新编辑"，而不是只能取消后手动复制粘贴重发。
> 方案 A：撤回到输入框（Recall to Edit）— 推荐先做
> "队列内直接编辑"不做；这个不重要；先只需要支持前一个就好了的

- Source: https://github.com/zts212653/clowder-ai/issues/706
- Source: current dispatch thread message `0001780303789188-000105-b9c1a910`
- Please verify the implementation against方案 A while treating inline edit as out of scope.

## Tradeoff

This patch deliberately reuses the existing queue DELETE semantics instead of adding backend mutation APIs or an inline-edit mode.

Known limitation: this pass recalls text only. Issue #706 also mentions preserving attachments; current `ChatInput` draft image state is `File[]`, while queue records expose image URLs through message `contentBlocks`, so full attachment restoration needs a separate design for URL-to-draft conversion or a richer pending insert contract.

## Architecture Ownership

Architecture cell: message-delivery-lifecycle / web queue UI
Map delta: none
Why: This is a UI-level action over existing queue deletion and existing composer insertion primitives; it does not introduce a new Store / Queue / Router / Adapter / Dispatcher / Binding.

Please check:

- diff matches `Map delta: none`
- no parallel queue or composer state path was introduced
- rollback behavior remains correct when DELETE fails
- text-only scope is acceptable for this batch, or should be called out as P1/P2 due #706 attachment language

## Open Questions

### 技术 OQ

- Is it acceptable for `QueuePanel` to call `setPendingChatInsert` after successful DELETE, or should this action live closer to ChatInput/composer orchestration?
- Should `撤回编辑` be hidden for non-user entries only as implemented, or additionally gated on `entry.status === 'queued'` even though visible queue entries are already filtered to queued entries?
- Please explicitly classify the attachment gap.

### 价值 OQ

None for inline edit; CVO already decided not to do it in this batch.

## Next Action

Please review the source worktree and return P1/P2/P3 findings. If clear, approve for merge-gate.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-706-recall-edit/opus47`
- Start Command: `pnpm review:start`
- Ports: reviewer `pnpm review:start` auto-picks from `web=3201`, `api=3202`
- Source worktree for this uncommitted review: `/Users/lang/workspace/github/cat-cafe-706-recall-edit`

## 自检证据

### Spec 合规

- `撤回编辑` button exists only for `source === 'user'`.
- Success path removes queue entry optimistically, confirms via DELETE, then inserts original text into composer.
- Failure path rolls back queue and shows `撤回失败`.
- Existing plain withdraw remains unchanged.
- Inline queue editing not implemented by CVO decision.

### Tests

Passed:

```bash
env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/queue-panel-withdraw.test.ts
# 3 passed

env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/queue-panel-withdraw.test.ts src/components/__tests__/chat-input-draft-persistence.test.ts
# 14 passed

env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/queue-panel-agent-entries.test.ts src/components/__tests__/queue-panel-images.test.ts src/components/__tests__/queue-panel-reorder.test.ts src/components/__tests__/queue-panel-processing.test.ts src/components/__tests__/queue-panel-steer.test.ts src/components/__tests__/queue-panel-withdraw.test.ts
# 27 passed

env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm --filter @cat-cafe/web exec tsc --noEmit --pretty false
# passed

env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm exec biome check --diagnostic-level=error packages/web/src/components/QueuePanel.tsx packages/web/src/components/QueueEntryRow.tsx packages/web/src/components/__tests__/queue-panel-withdraw.test.ts packages/web/src/components/__tests__/chat-input-draft-persistence.test.ts
# passed

git diff --check
# passed
```

Full web test status:

```bash
env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm --filter @cat-cafe/web test
# failed: 9 files, 53 assertions
```

Observed failures are in existing unrelated areas: connector bubble theme, Hub cat/co-creator editor, Hub skills/plugins content, global CSS/F190 visual contract. Queue-related target suites above are green.

### Browser Evidence

Playwright against temporary browser QA harness at `http://127.0.0.1:3221/`:

- Before click: `queueLength=1`, button list includes `{ text: "编辑", aria: "撤回编辑" }`.
- Clicked role button `撤回编辑`.
- After click: `queueLength=0`, toast title `已撤回编辑`, composer text becomes `draft before recall\nbrowser recalled queued text`.
- API calls included `DELETE /api/threads/thread-browser/queue/q-browser-1`.
- Console/page errors: none.
- Screenshot artifact: `queue-recall-edit-browser-qa.png` in Playwright MCP artifact output.

### Root Artifact Gate

```bash
git status --short | rg '^.. [^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$' || true
# no output

git diff --name-only origin/main...HEAD | rg '^[^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$' || true
# no output
```

### Worktree State

```bash
git status --short --branch
# ## fix/706-recall-edit...origin/main
#  M packages/web/src/components/QueueEntryRow.tsx
#  M packages/web/src/components/QueuePanel.tsx
#  M packages/web/src/components/__tests__/chat-input-draft-persistence.test.ts
#  M packages/web/src/components/__tests__/queue-panel-withdraw.test.ts
# ?? review-notes/2026-06-01-queue-recall-edit-review-request.md
```
