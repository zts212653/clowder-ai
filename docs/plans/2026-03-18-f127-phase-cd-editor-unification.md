# F127 Phase C/D Editor Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the main Phase C/D gap by moving member-level runtime controls into the Hub member editor while keeping alias routing dynamic from the runtime catalog.

**Architecture:** Reuse the existing `/api/cats` runtime catalog CRUD for persistent member data and extend it to carry `contextBudget`. Reuse the existing `/api/config/session-strategy/:catId` runtime API for effective strategy edits inside `HubCatEditor`, then remove the standalone Hub `Session 策略` tab so member-level runtime controls live behind member editing instead of a separate panel.

**Tech Stack:** Fastify, TypeScript, React, Vitest, Node test runner

---

### Task 1: Lock the expected Hub UX in tests

**Files:**
- Modify: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-navigation.test.ts`

**Step 1: Write the failing tests**

- Add a failing editor test for an existing member that expects:
  - context budget inputs to render
  - session strategy controls to load for existing cats
  - save to call both `/api/cats/:id` and `/api/config/session-strategy/:catId` when strategy changes
- Add a failing navigation test asserting the standalone `Session 策略` tab is removed from Hub navigation.

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/hub-cat-editor.test.tsx \
  src/components/__tests__/cat-cafe-hub-navigation.test.ts
```

Expected:
- editor test fails because advanced controls do not exist yet
- navigation test fails because `strategy` tab still exists

### Task 2: Persist per-member context budgets in runtime catalog

**Files:**
- Modify: `packages/api/src/config/runtime-cat-catalog.ts`
- Modify: `packages/api/src/routes/cats.ts`
- Modify: `packages/api/test/cats-routes-runtime-crud.test.js`

**Step 1: Write the failing test**

- Extend runtime CRUD test to PATCH an existing runtime member with `contextBudget`
- Assert subsequent `GET /api/cats` reflects the saved budget payload

**Step 2: Run the focused API test to verify it fails**

Run:

```bash
HOME=/tmp pnpm --filter @cat-cafe/api exec node --test test/cats-routes-runtime-crud.test.js
```

Expected:
- fail because `/api/cats` schema/runtime catalog writer ignores `contextBudget`

**Step 3: Write minimal implementation**

- Extend runtime input/update shapes with `contextBudget`
- Persist the budget on the variant in `.cat-cafe/cat-catalog.json`
- Serialize it back out from `/api/cats`

**Step 4: Run the API test to verify it passes**

Run the same command and expect green.

### Task 3: Move member-level runtime controls into `HubCatEditor`

**Files:**
- Modify: `packages/web/src/components/HubCatEditor.tsx`
- Modify: `packages/web/src/components/CatCafeHub.tsx`
- Modify: `packages/web/src/hooks/useCatData.ts`
- Modify: `packages/web/src/components/config-viewer-tabs.tsx`

**Step 1: Implement the editor**

- Add budget inputs to `HubCatEditor`
- For existing cats, fetch effective session strategy and show strategy controls inline
- On save:
  - persist identity/provider/budget via `/api/cats` POST/PATCH
  - persist strategy override via `/api/config/session-strategy/:catId` when editing an existing member
- Keep Antigravity branch behavior intact

**Step 2: Remove the standalone Hub strategy tab**

- Drop `strategy` from `HUB_GROUPS`
- Remove `HubStrategyTab` rendering from `CatCafeHub`
- Keep member edits accessible from overview cards

**Step 3: Run the focused web tests**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/hub-cat-editor.test.tsx \
  src/components/__tests__/cat-cafe-hub-navigation.test.ts \
  src/components/__tests__/cat-config-viewer.test.ts \
  src/components/__tests__/chat-input-options-labels.test.ts
```

Expected:
- all pass

### Task 4: Regression verification

**Files:**
- Verify only

**Step 1: Run web regression**

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/cat-config-viewer.test.ts \
  src/components/__tests__/hub-cat-editor.test.tsx \
  src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts \
  src/components/__tests__/chat-input-options-labels.test.ts \
  src/components/__tests__/cat-cafe-hub-quota-tab.test.ts \
  src/components/__tests__/cat-cafe-hub-navigation.test.ts
pnpm --filter @cat-cafe/web build
```

**Step 2: Run API regression**

```bash
HOME=/tmp pnpm --filter @cat-cafe/api exec node --test \
  test/cats-routes-runtime-catalog.test.js \
  test/cats-routes-runtime-crud.test.js \
  test/mock-agent-integration.test.js
```

**Step 3: Record residual debt**

- Note that per-cat Codex sandbox/approval/auth settings are still global and remain a follow-up slice after this unification pass.
