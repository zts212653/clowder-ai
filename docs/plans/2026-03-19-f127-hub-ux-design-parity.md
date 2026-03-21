# F127 Hub UX Design Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Re-align F127 Hub screens 2-7 with `docs/designs/F127/F127-hub-ux-wireframe.pen`, remove broken/unsupported actions, and keep the member/account flows working.

**Architecture:** Keep the current Hub information architecture, but tighten the shared visual tokens and simplify each tab so the rendered UI matches the wireframe's hierarchy. Fix behavior by changing the smallest possible component boundaries: overview cards, add-member wizard, provider profile cards, quota tab composition, and env/files ordering.

**Tech Stack:** Next.js 14, React 18, Tailwind utility classes, Vitest, Playwright, Pencil MCP.

---

### Task 1: Lock the regressions with focused tests

**Files:**
- Modify: `packages/web/src/components/__tests__/hub-add-member-wizard.test.tsx`
- Modify: `packages/web/src/components/__tests__/hub-provider-profile-item.test.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`
- Modify: `packages/web/src/components/__tests__/hub-env-files-tab.test.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-quota-tab.test.ts`

**Step 1: Write the failing tests**
- Assert the add-member wizard shows the Step 2 constraint note after choosing a normal client.
- Assert unsupported provider cards no longer expose the broken `测试` action.
- Assert the API Key creation form is inline and does not render the `协议建议` row.
- Assert quota tab no longer includes the extra routing-policy panel.
- Assert env/files sections render in the wireframe order: env → files → data dirs.

**Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/hub-add-member-wizard.test.tsx src/components/__tests__/hub-provider-profile-item.test.tsx src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-env-files-tab.test.tsx src/components/__tests__/cat-cafe-hub-quota-tab.test.ts
```

Expected:
- Failing assertions for missing Step 2 note, extra `测试` buttons, collapsed API Key form, wrong env section order, and extra routing-policy panel.

### Task 2: Rework account-config and add-member flows

**Files:**
- Modify: `packages/web/src/components/HubAddMemberWizard.tsx`
- Modify: `packages/web/src/components/hub-add-member-wizard.parts.tsx`
- Modify: `packages/web/src/components/HubProviderProfilesTab.tsx`
- Modify: `packages/web/src/components/HubProviderProfileItem.tsx`
- Modify: `packages/web/src/components/hub-provider-profiles.sections.tsx`

**Step 1: Implement the minimal code**
- Add the Step 2 constraint copy back into the add-member wizard.
- Render the API Key creation form inline instead of behind a toggle.
- Remove the `协议建议` row.
- Hide `测试` for non-`api_key` provider cards so the UI stops offering unsupported actions.
- Keep API Key cards editable/testable.

**Step 2: Run focused tests**

Run:
```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/hub-add-member-wizard.test.tsx src/components/__tests__/hub-provider-profile-item.test.tsx src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts
```

Expected:
- All green.

### Task 3: Simplify quota and env/files tabs to match the wireframe

**Files:**
- Modify: `packages/web/src/components/HubRoutingPolicyTab.tsx`
- Modify: `packages/web/src/components/HubQuotaBoardTab.tsx`
- Modify: `packages/web/src/components/HubEnvFilesTab.tsx`

**Step 1: Implement the minimal code**
- Make the quota tab render only the quota board.
- Re-style quota sections toward the warm card layout from Screen 5.
- Reorder env/files sections and trim the top-level presentation to the wireframe structure.

**Step 2: Run focused tests**

Run:
```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/hub-env-files-tab.test.tsx src/components/__tests__/cat-cafe-hub-quota-tab.test.ts src/components/__tests__/hub-quota-board-v2.test.ts
```

Expected:
- All green.

### Task 4: Tighten overview/editor visual hierarchy and verify in browser

**Files:**
- Modify: `packages/web/src/components/CatCafeHub.tsx`
- Modify: `packages/web/src/components/HubMemberOverviewCard.tsx`
- Modify: `packages/web/src/components/HubCatEditor.tsx`
- Modify: `packages/web/src/components/hub-cat-editor.fields.tsx`
- Modify: `packages/web/src/components/hub-cat-editor.sections.tsx`
- Modify: `packages/web/src/components/hub-cat-editor-advanced.tsx`

**Step 1: Implement the minimal code**
- Reduce oversize typography and vertical padding.
- Tighten overview/member cards to better match Screen 2.
- Simplify member-editor header and field density to better match Screen 3.

**Step 2: Browser verification**

Run:
```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/hub-add-member-wizard.test.tsx src/components/__tests__/hub-provider-profile-item.test.tsx src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-env-files-tab.test.tsx src/components/__tests__/cat-cafe-hub-quota-tab.test.ts src/components/__tests__/hub-quota-board-v2.test.ts
```

Then verify with Playwright against `http://127.0.0.1:3013/?cb=4`:
- Overview
- Add member
- Member edit
- Quota board
- Account config
- Env & files

### Task 5: Update the wireframe where product intent changed

**Files:**
- Modify: `docs/designs/F127/F127-hub-ux-wireframe.pen`

**Step 1: Pencil update**
- Update Screen 6 so the `+ 新建 API Key 账号` area reflects the inline form presentation.
- Remove the redundant `协议建议` row from the design.

**Step 2: Verify**
- Capture a fresh Pencil screenshot for Screen 6 and compare to the browser implementation.

