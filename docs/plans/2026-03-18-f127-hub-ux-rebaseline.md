# F127 Hub UX Rebaseline Implementation Plan

**Feature:** F127 — [docs/features/F127-cat-instance-management.md](../features/F127-cat-instance-management.md)
**Goal:** Re-align Hub UX strictly to the F127 spec and `.pen` wireframe, ignoring the deleted PNG exports and carrying forward only the work that still matches the true source of truth.
**Acceptance Criteria:**
- Screen 1 keeps the existing three accordion groups (`成员协作 / 系统配置 / 监控与治理`) and only changes naming/entry placement that are actually described in the spec.
- Screen 2 turns the overview into summary cards with Owner pinned first, member cards centered on identity + provider/bridge + model + aliases, and a clear “添加成员” CTA.
- Screen 3 keeps member editing as a sectioned config form, not a three-step tab flow; provider/model binding follows the concrete-provider model from the spec; Antigravity stays a special path.
- Screen 4 adds a three-step **add-member** flow only for creation (`Client -> Provider -> Model`, with Antigravity special handling).
- Screen 5 shows quota by account pool (OAuth/API Key/Antigravity bridge) with reverse-linked member chips.
- Screen 6 keeps provider profile management focused on built-in OAuth + API Key providers and excludes Antigravity.
- Screen 7 keeps env/files separate from credentials and surfaces `cat-template.json` vs `.cat-cafe/cat-catalog.json`.
**Architecture:** Reuse the already-valid Phase 1 data contract (`source` + `roster`) and the corrected three-group Hub baseline as the foundation. Replace the PNG-derived assumptions with spec-driven UI work: card-first overview, sectioned member editor, and a separate add-member wizard. Treat `HubProviderProfilesTab`, `HubQuotaBoardTab`, and `HubEnvFilesTab` as alignment/polish tasks, not as redesigns unless a concrete spec gap is found.
**Tech Stack:** React 18, Next.js 14, TypeScript, Vitest, existing Fastify API endpoints
**前端验证:** Yes — reviewer must open the Hub and compare against Screen 2/3/4/5/6/7 behavior, not just read code.

---

## Straight-Line Guard

**Finish line:** The Hub matches the `.md + .pen` model: three accordion groups stay, overview becomes card-first, edit/create flows match Screen 3/4, and account/env/quota tabs reflect the spec instead of the deleted PNG exports.

**What we are NOT building:**
- No four-group Hub information architecture
- No PNG-only stats tiles / filter chips / “实例列表” rewrite assumptions
- No three-step tab editor for existing members
- No additional IA experiments beyond the spec and the explicit rescue relocation already requested by the owner

## Task 1: Lock the corrected baseline in tests

**Files:**
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-navigation.test.ts`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`

**Step 1: Write/adjust the failing tests**

Add assertions that prove:
- the Hub still uses three accordion groups (`cats`, `settings`, `monitor`)
- `capabilities` and `leaderboard` stay under `cats`
- `provider-profiles`, `voice`, `notify` stay under `settings`
- `commands` stays under `monitor`
- `rescue` exists outside provider profiles and is reachable from the monitor group

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/cat-cafe-hub-navigation.test.ts \
  src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts
```

Expected: FAIL while any four-group/PING-derived routing remains.

**Step 3: Write the minimal implementation**

Re-baseline `CatCafeHub` so the three-group layout is the only navigation truth, while keeping rescue out of `HubProviderProfilesTab`.

**Step 4: Run the same tests to verify they pass**

Expected: PASS.

## Task 2: Rebuild Screen 2 overview as summary cards

**Files:**
- Create: `packages/web/src/components/HubMemberOverviewCard.tsx`
- Modify: `packages/web/src/components/config-viewer-tabs.tsx`
- Modify: `packages/web/src/components/CatCafeHub.tsx`
- Modify: `packages/web/src/components/__tests__/cat-config-viewer.test.ts`

**Step 1: Write the failing test**

Add tests that prove the overview:
- renders Owner/ME first with a locked visual state
- renders each member as a summary card, not a dense key/value wall
- emphasizes name/client/provider-or-bridge/model/aliases/status
- no longer exposes budget/runtime internals in overview cards
- keeps the “添加成员” CTA

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-config-viewer.test.ts
```

Expected: FAIL because the current overview is still too implementation-heavy.

**Step 3: Write minimal implementation**

Implement `HubMemberOverviewCard.tsx` and rewire `CatOverviewTab` to use the card-first Screen 2 structure. Use `cat.source` + `cat.roster` to render Owner/locked/lead states instead of ad hoc heuristics.

**Step 4: Run the focused test to verify it passes**

Expected: PASS.

## Task 3: Align Screen 3 member editing to the spec

**Files:**
- Modify: `packages/web/src/components/HubCatEditor.tsx`
- Modify: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`

**Step 1: Write the failing test**

Add tests that prove editing an existing member shows:
- identity sections from Screen 3 (Name/Nickname/Description/Avatar/Background Color/Team Strengths/Personality/Caution/Strengths)
- concrete provider/model binding for normal clients
- Antigravity-specific `CLI Command + Model`
- a collapsed/secondary Voice Config area
- advanced runtime parameters as sectioned fields, not a PNG-derived three-step tab flow

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/hub-cat-editor.test.tsx
```

Expected: FAIL because the current form still reflects the earlier assumptions and field coverage gaps.

**Step 3: Write minimal implementation**

Refactor the existing editor into spec-aligned sections. Keep edit mode as a single form with clear sections; do **not** introduce a step-based tab UI for existing members.

**Step 4: Run the same test to verify it passes**

Expected: PASS.

## Task 4: Add Screen 4 create-member wizard

**Files:**
- Create: `packages/web/src/components/HubAddMemberWizard.tsx`
- Modify: `packages/web/src/components/CatCafeHub.tsx`
- Modify: `packages/web/src/components/config-viewer-tabs.tsx`
- Create: `packages/web/src/components/__tests__/hub-add-member-wizard.test.tsx`

**Step 1: Write the failing test**

Add tests that prove creation uses a three-step flow:
- normal member: `Client -> Provider -> Model`
- Antigravity: `Client=Antigravity -> CLI Command -> Model`
- completing the wizard lands in the member config/editor flow for further adjustment

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/hub-add-member-wizard.test.tsx
```

Expected: FAIL because creation currently jumps straight into the generic editor.

**Step 3: Write minimal implementation**

Create `HubAddMemberWizard.tsx`, launch it from the overview CTA, and bridge its output into the existing save/edit path.

**Step 4: Run the same test to verify it passes**

Expected: PASS.

## Task 5: Align quota/account/env tabs and run end-to-end verification

**Files:**
- Modify: `packages/web/src/components/HubQuotaBoardTab.tsx`
- Modify: `packages/web/src/components/HubRoutingPolicyTab.tsx`
- Modify: `packages/web/src/components/HubProviderProfilesTab.tsx` (only if Screen 6 gaps remain)
- Modify: `packages/web/src/components/HubEnvFilesTab.tsx` (only if Screen 7 gaps remain)
- Modify: `packages/web/src/components/__tests__/hub-quota-board-v2.test.ts`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`

**Step 1: Write the failing tests**

Cover any remaining Screen 5/6/7 gaps:
- quota board groups by account pool and links back to member chips
- provider profiles stay account-only and exclude Antigravity
- env/files keep credentials out and surface template/runtime file boundaries clearly

**Step 2: Run focused tests to verify they fail**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/hub-quota-board-v2.test.ts \
  src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts
```

Expected: FAIL only where the current UI still diverges from Screen 5/6/7.

**Step 3: Write minimal implementation**

Patch only the gaps that the tests expose. Do not redesign already-aligned sections.

**Step 4: Run focused verification**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/cat-cafe-hub-navigation.test.ts \
  src/components/__tests__/cat-config-viewer.test.ts \
  src/components/__tests__/hub-cat-editor.test.tsx \
  src/components/__tests__/hub-add-member-wizard.test.tsx \
  src/components/__tests__/hub-quota-board-v2.test.ts \
  src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts
pnpm --filter @cat-cafe/web build
```

Expected: all green, with only pre-existing lint warnings from unrelated files.

## Reviewer checkpoints

- After Task 1: confirm the corrected three-group baseline
- After Task 2: compare overview cards against Screen 2
- After Task 3/4: compare edit vs create flows against Screen 3/4
- After Task 5: verify Screen 5/6/7 polish in browser
