# F127 Phase A Provider Profiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generalize provider profiles from Anthropic-only storage/UI into a reusable provider configuration system that supports builtin OAuth providers and custom API key providers.

**Architecture:** Keep the existing `.cat-cafe/provider-profiles*.json` storage boundary, but replace the Anthropic-only schema with a provider map keyed by provider id. Preserve Anthropic runtime resolution as a compatibility layer for current runtime consumers, while broadening CRUD/list APIs and Hub UI to operate on generic providers. Land the change in small TDD slices so route/store/UI stay in sync.

**Tech Stack:** TypeScript, Fastify, Zod, React, Vitest, Node test runner

---

### Task 1: Generalize API storage types and CRUD

**Files:**
- Modify: `packages/api/src/config/provider-profiles.types.ts`
- Modify: `packages/api/src/config/provider-profiles.ts`
- Test: `packages/api/test/provider-profiles-store.test.js`

**Step 1: Write the failing test**

Add store tests that prove:
- `readProviderProfiles()` returns builtin provider entries for `claude`, `codex`, and `gemini`
- `createProviderProfile()` can create a custom API key provider under a non-Anthropic provider id
- secrets stay in `.cat-cafe/provider-profiles.secrets.local.json`

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @cat-cafe/api exec node --test test/provider-profiles-store.test.js`
Expected: FAIL because the store still only exposes `anthropic`

**Step 3: Write minimal implementation**

Implement:
- generic provider id/auth type/builtin/model list types
- normalized provider map bootstrap with builtin OAuth providers
- generic create/update/delete/read helpers keyed by provider id
- preserve `resolveAnthropicRuntimeProfile()` on top of the new schema

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @cat-cafe/api exec node --test test/provider-profiles-store.test.js`
Expected: PASS

### Task 2: Generalize route contract and server-side validation

**Files:**
- Modify: `packages/api/src/routes/provider-profiles.ts`
- Test: `packages/api/test/provider-profiles-route.test.js`

**Step 1: Write the failing test**

Add route tests that prove:
- `GET /api/provider-profiles` returns builtin OAuth providers plus custom API key providers
- `POST /api/provider-profiles` accepts generic provider ids for API key providers
- `POST /api/provider-profiles/:id/test` remains restricted to supported probe-capable providers for now

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @cat-cafe/api exec node --test test/provider-profiles-route.test.js`
Expected: FAIL because route schema still hardcodes `anthropic`

**Step 3: Write minimal implementation**

Implement:
- broader Zod schemas for provider ids and auth types
- list/create/update/delete payloads based on generic provider records
- probe/test guardrails that keep Anthropic probing working and reject unsupported providers explicitly

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @cat-cafe/api exec node --test test/provider-profiles-route.test.js`
Expected: PASS

### Task 3: Update Hub provider profile UI

**Files:**
- Modify: `packages/web/src/components/hub-provider-profiles.types.ts`
- Modify: `packages/web/src/components/HubProviderProfilesTab.tsx`
- Modify: `packages/web/src/components/HubProviderProfileItem.tsx`
- Test: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`

**Step 1: Write the failing test**

Add UI tests that prove:
- the tab renders builtin OAuth providers and API key providers from the generic response shape
- create form lets the user choose auth type/provider kind instead of assuming Anthropic
- provider-specific testing controls only render where supported

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`
Expected: FAIL because the component still expects `data.anthropic`

**Step 3: Write minimal implementation**

Implement:
- generic response/item types
- grouped provider rendering
- create/edit form fields aligned with Phase A spec

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`
Expected: PASS

### Task 4: Mention autocomplete contract lock

**Files:**
- Modify: `packages/web/src/components/__tests__/chat-input-options-labels.test.ts`
- Modify: `packages/web/src/components/chat-input-options.ts` (only if test exposes a gap)

**Step 1: Write the failing test**

Add/assert a test that a cat with multiple `mentionPatterns` only contributes the first alias to front-end autocomplete insert text.

**Step 2: Run test to verify it fails or confirm existing behavior**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-input-options-labels.test.ts`
Expected: Either FAIL (needs code change) or PASS immediately (behavior already exists, then no implementation needed)

**Step 3: Write minimal implementation**

Only if red:
- constrain autocomplete option generation to the first mention pattern

**Step 4: Run test to verify it passes**

Run the same Vitest command and confirm PASS.

### Task 5: End-to-end verification for Phase A slice

**Files:**
- Verify only

**Step 1: Run focused API verification**

Run: `pnpm --filter @cat-cafe/api exec node --test test/provider-profiles-store.test.js test/provider-profiles-route.test.js`

**Step 2: Run focused web verification**

Run: `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/chat-input-options-labels.test.ts`

**Step 3: Run type/build verification**

Run:
- `pnpm --filter @cat-cafe/api build`
- `pnpm --filter @cat-cafe/web build`

**Step 4: Review spec alignment**

Check against: `docs/features/F127-cat-instance-management.md`

Confirm:
- provider binding replaces authType in member-facing flows
- builtin OAuth + API key provider split is reflected in API/UI
- Antigravity remains excluded from provider-profile CRUD
