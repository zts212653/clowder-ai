---
feature_ids: []
related_issues: ["zts212653/clowder-ai#961"]
related_prs: ["zts212653/clowder-ai#1149"]
topics: [accounts, credentials, runtime-worktree, persistent-state, migration]
doc_kind: implementation-plan
created: 2026-08-06
---

# Account Store Root Consistency Implementation Plan

**Feature:** Upstream bug — PR #1149 account-store regression (dedicated issue pending)
**Goal:** Make account creation, cat binding validation, invocation, and deletion use one durable account store without losing either legacy runtime-only data or new workspace-only data.
**Acceptance Criteria:**
- AC-1: In split runtime/workspace mode, an account created through `POST /api/accounts` can immediately be bound through `PATCH /api/cats/:id` and resolved during invocation.
- AC-2: First fixed startup preserves the union of runtime-only and workspace-only account metadata and credentials.
- AC-3: Metadata or credential conflicts fail closed before the legacy source is retired; credential values never appear in logs or errors.
- AC-4: Cat catalog ownership remains on the runtime catalog coordinate while account metadata and credentials use the durable account-store coordinate.
- AC-5: Migration is retry-safe across crash windows and rollback/re-upgrade; startup no longer recreates stale runtime account snapshots.
- AC-6: Explicit `CAT_CAFE_GLOBAL_CONFIG_ROOT`, external project stores, in-place deployment, and runtime/workspace same-root behavior remain compatible.
**Architecture cell:** `identity-session`
**Map delta:** none
**Map delta why:** This fixes coordinate resolution inside the existing account-binding ownership cell; no owner, store type, or routing boundary changes.
**Architecture:** Introduce one synchronous account-store root resolver shared by account metadata and credentials. Keep the cat catalog root independent, and run a startup migration that merges legacy runtime files into the resolved durable store before account consumers initialize.
**Tech Stack:** TypeScript, Fastify, Node.js filesystem APIs, Node test runner, Bash startup harness
**前端验证:** No — the defect is API/storage behavior; route-level integration coverage is the acceptance surface.

---

## Finish Line and Non-Goals

Finish line: under `CAT_CAFE_RUNTIME_ROOT != CAT_CAFE_WORKSPACE_ROOT`, one account ID has the same meaning to the accounts API, cats API, agent invocation, and deletion reference audit, across restart and migration.

Not building:

- The broader state/cache/log relocation proposed in upstream issue #961.
- Cat catalog relocation out of the runtime worktree.
- A permanent dual-read, dual-write, or fallback account architecture.
- New UI or account-scoping semantics for external projects.
- Automatic deletion of legacy user data without a recoverable backup.

## Terminal Schema

```ts
export interface AccountStoreRootOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}

// Precedence: explicit GLOBAL_CONFIG_ROOT > runtime-to-workspace mapping
// > explicit projectRoot > homedir.
export function resolveAccountStoreRoot(options: AccountStoreRootOptions): string;

export interface AccountStoreMigrationReport {
  sourceRoot: string;
  targetRoot: string;
  accountsMerged: string[];
  accountsAlreadyPresent: string[];
  credentialsMerged: string[];
  backupsCreated: string[];
  migrated: boolean;
}
```

`catalog-accounts.ts` and `credentials.ts` must import the same resolver. They must not retain duplicated private `resolveGlobalRoot` implementations.

The migration implementation may use recoverable rename/backups or a marker plus source fingerprint. Whichever representation is chosen becomes a lifecycle object and must satisfy the invariants and crash tests below.

## Stateful Object Census

| Object | Lifecycle owner | Created/updated by | Consumers | Forbidden bypass |
|---|---|---|---|---|
| Account metadata record | `catalog-accounts.ts` | Accounts API, installer, startup migration | binding validation, invocation, account UI | Direct route-specific root selection |
| Credential record | `credentials.ts` | Accounts API, installer, startup migration | invocation/provider factories | Logging or comparing secret values in errors |
| Legacy runtime account store | Startup account-store migrator | Historical releases / rollback | Migration only after fix | Normal runtime reads after successful migration |
| Migration completion evidence | Startup account-store migrator | Successful migration | Retry/rollback detection | Marking complete before both target files are durable |
| Cat-to-account binding | Runtime cat catalog owner | Cats API | deletion audit, invocation | Moving the cat catalog merely to follow account storage |

## State Transitions

| Source runtime store | Durable target store | Event | Required transition |
|---|---|---|---|
| absent | absent | first startup | No migration; consumers use empty target |
| absent | present | normal startup | Read target only |
| present | absent | fixed startup | Preflight, write target atomically, record recoverable source backup |
| present | present, disjoint/equivalent | fixed startup | Merge union, then retire source recoverably |
| present | present, metadata conflict | fixed startup | Fail before modifying or retiring source |
| present | present, credential conflict | fixed startup | Fail without printing secret and without retiring source |
| partially retired | target contains prior successful writes | crash retry | Complete remaining merge/backup idempotently |
| new legacy source after prior migration | target present | rollback then re-upgrade | Treat as a new migration input; merge or fail closed on conflict |

## Invariants

- **INV-1 — Single coordinate:** All normal reads and writes for accounts and credentials resolve through `resolveAccountStoreRoot`.
- **INV-2 — Explicit override:** `CAT_CAFE_GLOBAL_CONFIG_ROOT` always wins over inferred runtime/workspace mapping.
- **INV-3 — Catalog independence:** Runtime cat catalog reads and writes do not change coordinate as a side effect of the account fix.
- **INV-4 — No user-state loss:** A non-conflicting account or credential present in either legacy runtime or durable target remains present after migration.
- **INV-5 — Conflict fail-closed:** Different metadata or credentials under the same ID never silently overwrite either side.
- **INV-6 — Secret hygiene:** Errors and logs may name the account ID and source paths but never credential values.
- **INV-7 — Completion ordering:** Legacy source retirement happens only after all target writes succeed.
- **INV-8 — Retry safety:** Re-running migration after any crash window produces the same target state without duplicate or destructive effects.
- **INV-9 — No stale reseed:** `seed_runtime_config_from_project` no longer copies `accounts.json` or `credentials.json` into runtime.
- **INV-10 — External compatibility:** A project root outside `CAT_CAFE_RUNTIME_ROOT` remains project-scoped unless the explicit global override is set.
- **INV-11 — Accurate error:** An unresolved account binding reports `account "<id>" not found`, not `provider ... not found`.

## Adversarial Matrix

| Scenario | Expected evidence |
|---|---|
| Crash after target accounts write, before credentials write | Retry completes credentials and does not lose accounts |
| Crash after target writes, before source backup/marker | Retry recognizes equivalent target and completes retirement |
| Runtime and workspace contain same ID with different model/base URL | Startup fails with ID/path-only diagnostic; both sources remain recoverable |
| Both sides contain different credentials for same ID | Startup fails without credential content in output |
| Roll back, create/update legacy runtime state, then upgrade again | New source change is detected and merged or conflicts explicitly |
| Delete an account bound in runtime cat catalog | API returns 409 and names bound cat IDs |
| Explicit external project path | Account store remains under that external project when no global override exists |
| `RUNTIME_ROOT == WORKSPACE_ROOT` | Resolver is a no-op; migration does not run |

### Task 1: Add the Split-Root Red Tests

**Files:**
- Modify: `packages/api/test/accounts-route.test.js`
- Modify: `packages/api/test/cats-routes-runtime-crud.test.js`
- Modify: `packages/api/test/invoke-single-cat.test.js`
- Modify or create: `packages/api/test/account-store-root.test.js`

**Steps:**

1. Create isolated runtime and workspace roots and set only `CAT_CAFE_RUNTIME_ROOT` plus `CAT_CAFE_WORKSPACE_ROOT`; leave `CAT_CAFE_GLOBAL_CONFIG_ROOT` unset.
2. Add a route integration test: create a custom account through `/api/accounts`, bind a runtime cat through `/api/cats/:id`, and assert the current code fails with `provider "<id>" not found`.
3. Add an invocation regression showing the same workspace-only account fails runtime account resolution.
4. Run the targeted tests and preserve the red output in the handoff.

Run:

```bash
pnpm --filter @cat-cafe/api build
cd packages/api
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash scripts/with-test-home.sh \
  node --import test/helpers/setup-cat-registry.js --test --test-timeout=60000 \
  test/accounts-route.test.js test/cats-routes-runtime-crud.test.js \
  test/invoke-single-cat.test.js test/account-store-root.test.js
```

Expected: the new split-root assertions fail for missing account resolution; baseline assertions remain green.

### Task 2: Establish the Single Account-Store Resolver

**Files:**
- Create: `packages/api/src/config/account-store-root.ts`
- Modify: `packages/api/src/config/catalog-accounts.ts`
- Modify: `packages/api/src/config/credentials.ts`
- Test: `packages/api/test/account-store-root.test.js`

**Steps:**

1. Add resolver unit tests for explicit override, split-root mapping, same-root deployment, external project, missing workspace env, and path containment.
2. Implement `resolveAccountStoreRoot` with no filesystem writes and no dependency on cat catalog loading.
3. Replace both duplicated `resolveGlobalRoot` functions with the shared resolver.
4. Run resolver, catalog account, and credential suites.
5. Commit the resolver independently with a Why-bearing body.

### Task 3: Migrate Legacy Runtime Accounts Without Loss

**Files:**
- Create: `packages/api/src/config/account-store-migration.ts`
- Modify: `packages/api/src/config/account-startup.ts`
- Modify: `packages/api/src/config/catalog-accounts.ts` only for reusable canonical comparison/atomic helpers when necessary
- Modify: `packages/api/src/config/credentials.ts` only for reusable safe read/write helpers when necessary
- Test: `packages/api/test/account-startup.test.js`
- Test: `packages/api/test/catalog-accounts.test.js`

**Steps:**

1. Add red tests for runtime-only, workspace-only, disjoint union, equivalent duplicate, metadata conflict, credential conflict, and secret-redacted diagnostics.
2. Add crash-window tests around target account write, target credential write, and completion evidence/source retirement.
3. Implement a preflight phase that parses both source files and detects every conflict before source retirement.
4. Write target files atomically; only then create recoverable backups or completion evidence.
5. Call migration before `accountStartupHook` exposes accounts to any consumer.
6. Prove retry and rollback/re-upgrade behavior.
7. Commit migration separately with a Why-bearing body.

### Task 4: Remove Stale Runtime Seeding

**Files:**
- Modify: `scripts/runtime-worktree.sh`
- Modify: `scripts/start-dev-profile-isolation.test.mjs` or add the closest runtime-worktree script test

**Steps:**

1. Add a red script test proving startup does not seed `accounts.json` or `credentials.json` into runtime while existing `cat-catalog.json` behavior remains unchanged.
2. Restrict `seed_runtime_config_from_project` to the still-owned runtime seed files.
3. Run the script test and commit with a Why-bearing body.

### Task 5: Preserve Catalog-Root Semantics in Account Routes

**Files:**
- Modify: `packages/api/src/routes/accounts.ts`
- Test: `packages/api/test/accounts-route.test.js`

**Steps:**

1. Add a red deletion test where account metadata is durable-workspace state but the binding exists in the runtime cat catalog.
2. Separate the catalog/audit coordinate from the account-store coordinate. Do not remap all of `cats.ts`.
3. Preserve the externally visible `projectPath` response unless a compatibility test proves a deliberate change is required.
4. Verify non-force deletion still returns 409 for bound accounts.
5. Commit route semantics separately.

### Task 6: Complete Binding and Invocation Coverage

**Files:**
- Modify: `packages/api/src/routes/cats.ts`
- Modify only if required by the shared resolver: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Test: `packages/api/test/cats-routes-runtime-crud.test.js`
- Test: `packages/api/test/invoke-single-cat.test.js`

**Steps:**

1. Turn the Task 1 route and invocation regressions green through the shared resolver, not route-specific fallback logic.
2. Change unresolved-binding wording to `account "<id>" not found` and update exact tests.
3. Assert no permanent runtime fallback or dual read was introduced.
4. Run all targeted API suites.
5. Commit the behavioral fix.

### Task 7: Quality Gate and Review Handoff

**Files:**
- Review every file changed by Tasks 1–6.

**Steps:**

1. Run `git diff --check`.
2. Run `pnpm check`.
3. Run `pnpm --filter @cat-cafe/api test:public` or the full API test command required by the repository gate.
4. Run `pnpm gate` if the public suite and static checks are green.
5. Confirm no test touched production Redis 6399 or real user credentials; all migration tests use isolated temporary roots.
6. Send review handoff with What / Why / Tradeoff / Open Questions / Next Action, exact SHA, and red-to-green evidence.

## Open Questions

**Technical OQ — implementer resolves with tests:**

1. Recoverable source rename/backups versus marker plus fingerprint. Prefer the representation with the smaller lifecycle surface while satisfying rollback/re-upgrade and crash invariants.
2. Whether the existing account route `projectPath` response should expose the catalog root or account-store root. Preserve compatibility unless evidence requires otherwise.

**Value OQ:** none.

## Convergence Check

1. 否决理由 → ADR？没有；rejected alternatives are recorded in this plan and should be repeated in the upstream bug/PR.
2. 踩坑教训 → lessons-learned？有；the upstream issue/PR must record that persistent-path migrations require write/read-back/consumer coverage, not write-route coverage alone.
3. 操作规则 → 指引文件？没有；existing single-truth-source, persistent-user-state, and verifiable-completion rules already cover this bug.
