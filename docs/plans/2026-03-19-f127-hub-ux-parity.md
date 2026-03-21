# F127 Hub UX Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring Cat Café Hub screens 2-7 in line with `docs/designs/F127/F127-hub-ux-wireframe.pen`, including layout, copy, and behavior.

**Architecture:** Keep the existing Hub modal architecture and F127 component split, but tighten the navigation copy, card structure, member edit/add flows, quota grouping, account profile presentation, and env/files editability to match the wireframe. Drive the work by updating focused component tests first, then making minimal component/API changes until browser output matches the design.

**Tech Stack:** Next.js 14, React, Tailwind utility classes, Vitest, Fastify API routes/config registry.

---

### Task 1: Lock F127 acceptance criteria into tests

**Files:**
- Modify: `packages/web/src/components/__tests__/cat-config-viewer.test.ts`
- Modify: `packages/web/src/components/__tests__/hub-add-member-wizard.test.tsx`
- Modify: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`
- Modify: `packages/web/src/components/__tests__/hub-env-files-tab.test.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-quota-tab.test.ts`

**Step 1: Write failing assertions for wireframe-aligned copy and behavior**

- Update overview assertions to expect owner helper copy, card ordering, and F127 wording.
- Update add-member/editor assertions to expect editable Codex runtime fields and the screen-3 copy.
- Update env/files assertions to expect editable `API_SERVER_PORT` / `PREVIEW_GATEWAY_PORT` / `REDIS_URL` instead of read-only placeholders.
- Update quota assertions to expect account-based group titles and the F127 explanatory copy.

**Step 2: Run targeted tests to verify RED**

Run:

```bash
pnpm --filter web test -- --run packages/web/src/components/__tests__/cat-config-viewer.test.ts packages/web/src/components/__tests__/hub-add-member-wizard.test.tsx packages/web/src/components/__tests__/hub-cat-editor.test.tsx packages/web/src/components/__tests__/hub-env-files-tab.test.tsx packages/web/src/components/__tests__/cat-cafe-hub-quota-tab.test.ts
```

Expected:
- Multiple failures showing current copy/readonly/grouping mismatches.

### Task 2: Align screen 2 overview and hub navigation copy/layout

**Files:**
- Modify: `packages/web/src/components/CatCafeHub.tsx`
- Modify: `packages/web/src/components/cat-cafe-hub.navigation.tsx`
- Modify: `packages/web/src/components/config-viewer-tabs.tsx`
- Modify: `packages/web/src/components/HubMemberOverviewCard.tsx`

**Step 1: Adjust modal shell and accordion previews**

- Increase layout fidelity to the wireframe: warmer background, softer borders, more generous inner spacing, and group preview copy that matches screen 1.

**Step 2: Refine overview cards**

- Bring owner/member cards closer to screen 2: copy, badges, alias text, action placement, and summary lines.
- Preserve current behavior hooks (`onEdit`, availability toggle) while matching the design structure.

**Step 3: Run focused overview test**

Run:

```bash
pnpm --filter web test -- --run packages/web/src/components/__tests__/cat-config-viewer.test.ts
```

Expected:
- Pass.

### Task 3: Align screen 3 member editor and screen 4 add-member flow

**Files:**
- Modify: `packages/web/src/components/HubCatEditor.tsx`
- Modify: `packages/web/src/components/hub-cat-editor.sections.tsx`
- Modify: `packages/web/src/components/hub-cat-editor-advanced.tsx`
- Modify: `packages/web/src/components/HubAddMemberWizard.tsx`
- Modify: `packages/web/src/components/hub-cat-editor.client.ts`

**Step 1: Make editor layout and copy match screen 3**

- Widen/tall modal presentation where needed, tune section spacing, and update copy to match the wireframe.
- Ensure Codex runtime fields are surfaced as editable F127 inputs instead of display-only fields.

**Step 2: Wire editable Codex runtime settings through save flow**

- Persist Codex runtime changes through the existing config PATCH path along with cat/session changes.

**Step 3: Tighten add-member wizard copy/layout to screen 4**

- Match button labels, section copy, provider helper text, and completion CTA.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter web test -- --run packages/web/src/components/__tests__/hub-add-member-wizard.test.tsx packages/web/src/components/__tests__/hub-cat-editor.test.tsx
```

Expected:
- Pass.

### Task 4: Align screen 5 quota board with account-based grouping

**Files:**
- Modify: `packages/web/src/components/HubQuotaBoardTab.tsx`
- Modify: `packages/web/src/components/hub-quota-pools.ts`
- Modify: `packages/web/src/components/quota-cards.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-quota-tab.test.ts`
- Modify: `packages/web/src/components/__tests__/hub-quota-board-v2.test.ts`

**Step 1: Rework pool grouping and copy**

- Represent OAuth and API key accounts as account cards, not provider buckets.
- Show reverse-linked member tags per account and F127 note copy.

**Step 2: Preserve refresh/risk behavior**

- Keep existing fetch/notification logic while changing presentation and grouping.

**Step 3: Run focused quota tests**

Run:

```bash
pnpm --filter web test -- --run packages/web/src/components/__tests__/cat-cafe-hub-quota-tab.test.ts packages/web/src/components/__tests__/hub-quota-board-v2.test.ts
```

Expected:
- Pass.

### Task 5: Align screen 6 account config and screen 7 env/files

**Files:**
- Modify: `packages/web/src/components/HubProviderProfilesTab.tsx`
- Modify: `packages/web/src/components/hub-provider-profiles.sections.tsx`
- Modify: `packages/web/src/components/HubProviderProfileItem.tsx`
- Modify: `packages/web/src/components/HubEnvFilesTab.tsx`
- Modify: `packages/api/src/config/env-registry.ts`
- Modify: `packages/web/src/components/__tests__/hub-env-files-tab.test.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`

**Step 1: Bring account-config card structure/copy to wireframe**

- Reorder sections, badge copy, model-edit affordances, and API-key creation card tone/layout.

**Step 2: Expand env/files editability per F127**

- Make the wireframe-targeted env vars editable, keep sensitive masking, and preserve `.env` writeback.
- Keep config files/data dirs sections aligned with screen 7.

**Step 3: Run focused settings tests**

Run:

```bash
pnpm --filter web test -- --run packages/web/src/components/__tests__/hub-env-files-tab.test.tsx packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts
```

Expected:
- Pass.

### Task 6: Full regression + browser verification

**Files:**
- Verify only

**Step 1: Run the relevant web test suite**

Run:

```bash
pnpm --filter web test -- --run packages/web/src/components/__tests__/cat-config-viewer.test.ts packages/web/src/components/__tests__/hub-add-member-wizard.test.tsx packages/web/src/components/__tests__/hub-cat-editor.test.tsx packages/web/src/components/__tests__/hub-env-files-tab.test.tsx packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts packages/web/src/components/__tests__/cat-cafe-hub-quota-tab.test.ts packages/web/src/components/__tests__/hub-quota-board-v2.test.ts
```

**Step 2: Run frontend build smoke**

Run:

```bash
pnpm --filter web build
```

**Step 3: Verify in browser against the wireframe**

- Re-open `http://localhost:3013`.
- Compare overview, edit member, add member, quota board, account config, and env/files against the `.pen` screens.
- Capture fresh screenshots as evidence.

### Task 7: Review handoff

**Files:**
- Create or update as needed: `review-notes/` note if required by workflow

**Step 1: Summarize what changed and verification evidence**

- Include tests run and browser parity notes.

**Step 2: Request inspection from `@opencode`**

- Ask specifically for F127 Hub UX parity review after implementation is verified.
