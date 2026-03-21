# F127 Phase B/C/D Runtime Cat Catalog CRUD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish F127 by making the runtime cat catalog editable at runtime, reconciling live registries after edits, and wiring Hub overview/add/edit flows to the new APIs.

**Architecture:** Keep `.cat-cafe/cat-catalog.json` as the only runtime truth source for member definitions and treat `cat-template.json` as bootstrap-only. Add a catalog store that edits the validated `CatCafeConfig` document, expose focused `/api/cats` CRUD endpoints that reconcile `catRegistry` and `AgentRegistry` immediately, then connect Hub overview/add/edit UI to those endpoints with dynamic alias refresh.

**Tech Stack:** TypeScript, Fastify, React, Next.js, Vitest, Node test runner, Zod

---

### Task 1: Runtime catalog store + live registry reconcile

**Files:**
- Modify: `packages/api/src/config/cat-catalog-store.ts`
- Modify: `packages/api/src/config/cat-config-loader.ts`
- Modify: `packages/api/src/domains/cats/services/agents/registry/AgentRegistry.ts`
- Modify: `packages/shared/src/registry/CatRegistry.ts`
- Create: `packages/api/src/config/runtime-cat-catalog.ts`
- Test: `packages/api/test/cat-catalog-store.test.js`

**Step 1: Write the failing test**

Add store tests that prove:
- a new runtime member can be created into `.cat-cafe/cat-catalog.json`
- an existing member can update identity/provider/mention fields without corrupting roster/reviewPolicy/owner
- deleting a non-owner runtime member removes it from the catalog
- cache invalidation hooks can be called after a write

**Step 2: Run test to verify it fails**

Run: `HOME=/tmp pnpm --filter @cat-cafe/api exec node --test test/cat-catalog-store.test.js`
Expected: FAIL because the store only bootstraps and cannot mutate the catalog

**Step 3: Write minimal implementation**

Implement:
- read/write helpers for the validated runtime catalog document
- member-level lookup/update/delete helpers keyed by `catId`
- deterministic new-breed creation for newly added runtime members
- `reset()/replaceAll()` style reconcile support on `CatRegistry` and `AgentRegistry`
- loader cache invalidation exports for runtime writes

**Step 4: Run test to verify it passes**

Run: `HOME=/tmp pnpm --filter @cat-cafe/api exec node --test test/cat-catalog-store.test.js`
Expected: PASS

### Task 2: `/api/cats` CRUD contract + runtime reconcile

**Files:**
- Modify: `packages/api/src/routes/cats.ts`
- Modify: `packages/api/src/index.ts`
- Create: `packages/api/test/cats-routes-runtime-crud.test.js`
- Modify: `packages/api/test/cats-routes-runtime-catalog.test.js`

**Step 1: Write the failing test**

Add route tests that prove:
- `POST /api/cats` creates a normal member with `client + provider + model + mentionPatterns`
- `POST /api/cats` creates an Antigravity member with `commandArgs + defaultModel` and no provider
- `PATCH /api/cats/:id` updates runtime members and immediately changes subsequent `GET /api/cats`
- `DELETE /api/cats/:id` removes runtime members but rejects protected seed members
- A2A routing sees updated mention aliases after the mutate route returns

**Step 2: Run test to verify it fails**

Run: `HOME=/tmp pnpm --filter @cat-cafe/api exec node --test test/cats-routes-runtime-catalog.test.js test/cats-routes-runtime-crud.test.js`
Expected: FAIL because `/api/cats` only supports read/status and registries are startup-only

**Step 3: Write minimal implementation**

Implement:
- create/update/delete request schemas for normal members and Antigravity members
- route-level validation for provider/model compatibility and protected seed deletion
- registry reconcile hook injected from `index.ts`
- response payloads rich enough for Hub edit forms

**Step 4: Run test to verify it passes**

Run: `HOME=/tmp pnpm --filter @cat-cafe/api exec node --test test/cats-routes-runtime-catalog.test.js test/cats-routes-runtime-crud.test.js`
Expected: PASS

### Task 3: Hub overview add/edit flows

**Files:**
- Modify: `packages/web/src/hooks/useCatData.ts`
- Modify: `packages/web/src/components/config-viewer-tabs.tsx`
- Modify: `packages/web/src/components/CatCafeHub.tsx`
- Create: `packages/web/src/components/HubCatEditor.tsx`
- Create: `packages/web/src/components/HubAddCatCard.tsx`
- Create: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`
- Modify: `packages/web/src/components/__tests__/cat-config-viewer.test.ts`

**Step 1: Write the failing test**

Add UI tests that prove:
- overview shows an “添加成员” CTA and edit actions per member card
- normal-member editor renders `Client / Provider / Model / Aliases`
- Antigravity editor renders `CLI Command / Model` and hides provider
- successful save invalidates cached cat data and re-renders the updated aliases/name

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-config-viewer.test.ts src/components/__tests__/hub-cat-editor.test.tsx`
Expected: FAIL because the Hub overview is read-only and `useCatData` has no refresh path

**Step 3: Write minimal implementation**

Implement:
- a refreshable `useCatData` API
- overview cards with add/edit affordances
- modal editor form that loads provider options from `/api/provider-profiles`
- save/delete flows wired to the new `/api/cats` CRUD endpoints

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-config-viewer.test.ts src/components/__tests__/hub-cat-editor.test.tsx`
Expected: PASS

### Task 4: Alias/autocomplete runtime refresh

**Files:**
- Modify: `packages/web/src/components/chat-input-options.ts`
- Modify: `packages/web/src/components/__tests__/chat-input-options-labels.test.ts`
- Modify: `packages/web/src/lib/mention-highlight.ts` (only if needed)
- Modify: `packages/web/src/utils/transcription-corrector.ts` (only if needed)

**Step 1: Write the failing test**

Add a test that proves after runtime cat data refresh:
- only the first alias is used for front-end autocomplete insert text
- secondary aliases still remain in the runtime alias set for highlighting/transcription refresh helpers

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-options-labels.test.ts`
Expected: FAIL if refresh path does not preserve the runtime alias behavior

**Step 3: Write minimal implementation**

Only if red:
- update mention helper caches so refreshed runtime cats keep first-alias autocomplete and full-alias parsing/highlighting

**Step 4: Run test to verify it passes**

Run the same Vitest command and confirm PASS.

### Task 5: Focused end-to-end verification

**Files:**
- Verify only

**Step 1: Run focused API verification**

Run:
- `HOME=/tmp pnpm --filter @cat-cafe/api exec node --test test/cat-catalog-store.test.js test/cat-config-loader.test.js test/cats-routes-runtime-catalog.test.js test/cats-routes-runtime-crud.test.js test/mock-agent-integration.test.js`

**Step 2: Run focused web verification**

Run:
- `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-config-viewer.test.ts src/components/__tests__/hub-cat-editor.test.tsx src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/chat-input-options-labels.test.ts`

**Step 3: Run build verification**

Run:
- `pnpm --filter @cat-cafe/web build`
- `pnpm --filter @cat-cafe/api build`

**Step 4: Review spec alignment**

Check against: `docs/features/F127-cat-instance-management.md`

Confirm:
- runtime catalog is the live truth source for member CRUD
- protected seed members cannot be deleted
- Antigravity uses CLI command + model, not provider profiles
- Hub overview supports add/edit actions and refreshed aliases
