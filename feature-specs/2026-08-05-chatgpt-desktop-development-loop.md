# F289 ChatGPT Desktop Development Loop — Implementation Plan

> **For ChatGPT Desktop/Codex:** implement this plan in `/Volumes/WorkSSD/cat-cafe-chatgpt-desktop-dev-loop` using `$worktree`, `$tdd`, `$quality-gate`, `$request-review` and `$merge-gate`. Do not develop from `/Volumes/WorkSSD/cat-cafe-runtime`. Do not modify runtime config or secrets.

**Goal:** connect Cat Café's design/multi-cat Review plane to ChatGPT Desktop's development plane with durable, resumable managed work, then dogfood the loop on Traqen.

**Architecture:** reuse F275 `workId/attemptId` as the only work root. Add a desktop execution adapter, F211 runtime-session binding, exact-HEAD ReviewRound coordinator and repository-policy publication adapter. Expose a strict, lifecycle-oriented MCP profile; Desktop performs all repository mutation with its native local tools.

**Primary spec:** `docs/features/F289-chatgpt-desktop-development-loop.md`<br>
**Design Gate:** `docs/design/F289-chatgpt-desktop-development-loop.md`<br>
**Dogfood target:** `/Volumes/WorkSSD/projects/Traqen`, isolated worktree/branch only.

## Prerequisites and gates

1. **Blocking:** F275 owner freezes and approves a named-consumer port for existing work/attempt reads, idempotent next-attempt creation, typed evidence and F275-owned terminal transitions. No runtime implementation or automated claim begins without it; F289 has no fallback work/attempt/terminal ledger.
2. Non-author architecture review signs off F275 ownership, F211 session reuse, F286 MCP lifecycle and Traqen publication policy.
3. Refresh branch from current `origin/main`; re-audit any related feature delta before coding.
4. All Redis integration tests use isolated Redis on port 6398 via repository test harness. Never use production data stores.
5. Human-only activation (external principal, GitHub plugin token, agent key and ChatGPT Desktop config) occurs after code/skill gates pass.
6. No push, PR, merge or Traqen publication is part of Tasks 1–10 unless the operator explicitly activates the corresponding ProjectBinding flag.

## Stateful object census

| Object | Write owner | Mutation API | Persisted events / transitions | Consumer |
|---|---|---|---|---|
| `ProjectBinding` | authenticated operator/admin | register/update policy; no secret input | `project.registered`, `project.policy_updated` | adapter, review coordinator, publisher |
| F275 `WorkAdmission` / `WorkAttempt` | managed-work domain | existing admission + new named-consumer attempt port | F275 canonical admission/attempt events | all F289 services |
| `DesktopExecutionAttempt` | desktop adapter | claim/heartbeat/report/release | claimed, lease renewed/expired, evidence reported, implementation ready | Desktop MCP, Cat Café projection |
| `RuntimeSessionBinding` | identity-session domain | register/rebind/read | bound, superseded, orphaned/recovered | lease guard, Resume Packet |
| `ReviewRound` | review coordinator | start/private finish/cross-review/verdict | started, reviewer finished, barrier opened, consensus, stale | cats, Desktop MCP, merge gate |
| `PublicationRecord` | repository adapter | publish receipt only | requested, published, retry-reused, failed | ReviewRound, Desktop findings |

## Event invariants

- State transitions use compare-and-set on resource version plus idempotency key.
- Lease holder and binding epoch are checked in the same write boundary as attempt mutation.
- ReviewRound full SHA cannot mutate after creation.
- Barrier opening is atomic with the final required private completion.
- Consensus/publication never exposes a draft before barrier closure.
- Publication fingerprint is stable across retry and binds project + round + finding.
- F275 remains the only owner of whole-work terminal transitions.

## Task 1 — Freeze shared contracts and ownership map

**Files:**

- Create: `packages/shared/src/types/desktop-development-loop.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `docs/architecture/ownership/cells/desktop-development-loop.md`
- Modify: `docs/architecture/ownership/cells/managed-work.md`
- Modify: `docs/architecture/ownership/cells/identity-session.md`
- Generate: `docs/architecture/ownership/README.md`
- Modify: `docs/features/F275-managed-work-admission-identity.md`
- Test: `packages/shared/test/desktop-development-loop-contract.test.ts`

**Red:** add contract tests covering discriminated states/events, full-SHA validation, non-reviewable Desktop principal, ProjectBinding policy and Resume Packet secret/private-draft denylist.

**Green:** define branded/opaque IDs and schemas for ProjectBinding references, Desktop attempt projection, ReviewRound, publication receipts and legal-action responses. Reference F275 IDs; do not define another `jobId`.

Before Green implementation, record the F275 owner-approved named-consumer interface in `managed-work.md` and F275 feature truth. Required operations are: read existing work/attempt, create-next-attempt idempotently, attach typed evidence, and apply/reject F275-owned terminal transitions. If the owner does not approve this interface, stop after docs/contracts; do not add a Redis fallback in F289.

**Refactor/check:** add the named-consumer boundary to ownership cells and F275 related-feature text. Run:

```bash
pnpm --filter @cat-cafe/shared test
node docs/architecture/ownership/generate-readme.mjs
pnpm check
```

If the shared package lacks a test script on refreshed main, place the contract test in the nearest existing shared-contract test harness and record the actual command in the commit.

## Task 2 — Add ProjectBinding store and policy validation

**Files:**

- Create: `packages/api/src/domains/desktop-development-loop/ProjectBinding.ts`
- Create: `packages/api/src/domains/desktop-development-loop/ProjectBindingStore.ts`
- Create: `packages/api/src/domains/desktop-development-loop/RedisProjectBindingStore.ts`
- Create: `packages/api/src/domains/desktop-development-loop/project-binding-policy.ts`
- Create: `packages/api/test/desktop-development-project-binding.test.js`

**Red fixtures:** register/idempotent replay; repository identity conflict; missing/unknown publication policy; review roster containing Desktop author; local path absent from public projection; automation flags default false; persistence after service reconstruction; authenticated rebind after local path/data-root migration; unauthenticated or inferred-folder recovery denied.

**Green:** persist TTL=0 binding keyed by owner/project ID. Store local path only in private runtime projection. Normal process restart reloads it; clean install, replacement Mac, changed checkout path or data-store loss requires authenticated operator re-registration/rebind. Provide a typed adapter lookup that fails closed and never infers a binding from folder/remote/chat history.

**Verify:** build API and run the focused test with isolated test home/Redis.

## Task 3 — Reuse F275 attempts and implement lease/idempotency

**Files:**

- Create: `packages/api/src/domains/desktop-development-loop/DesktopExecutionAttempt.ts`
- Create: `packages/api/src/domains/desktop-development-loop/DesktopExecutionAttemptStore.ts`
- Create: `packages/api/src/domains/desktop-development-loop/RedisDesktopExecutionAttemptStore.ts`
- Modify: the F275 attempt port selected after refreshing `packages/api/src/domains/cats/services/stores/redis/managed-work-attempt-binding.ts`
- Create: `packages/api/test/desktop-development-attempt-lifecycle.test.js`

**Red fixtures:** nonexistent F275 IDs; two simultaneous claims; duplicate claim/report; heartbeat after lease expiry; stale expected version; release/reclaim; server reconstruction; two admitted works in one thread; no `DevelopmentJob` key/schema.

**Green:** add a named-consumer port over F275 attempt IDs and atomic lease/version/idempotency writes. Keep execution phase as an adapter projection; whole-work terminal state is out of scope.

**Crash/concurrency check:** kill the service between claim and evidence in the isolated harness, rebuild service and reclaim after expiry without duplicating the F275 attempt.

## Task 4 — Generalize external runtime session binding

**Files:**

- Modify: `packages/api/src/domains/cats/services/runtime-session/RuntimeSessionMetadata.ts`
- Modify: `packages/api/src/domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.ts`
- Modify: `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts`
- Modify: `packages/api/src/routes/external-runtime-sessions.ts`
- Modify: `packages/mcp-server/src/tools/external-runtime-session-tools.ts`
- Extend tests: `packages/api/test/external-runtime-session-registration.test.js`, `packages/api/test/external-runtime-sessions-route.test.js`, `packages/mcp-server/test/external-runtime-session-tools.test.js`
- Create: `packages/api/test/chatgpt-desktop-session-binding.test.js`

**Red fixtures:** register/list/read `chatgpt-desktop`; rebind increments epoch; old epoch write rejection; cross-user/session theft denial; orphan/recovery; all existing `antigravity-desktop` fixtures remain green.

**Green:** generalize runtime enum/validation and add binding epoch. Do not copy the Antigravity provider execution bridge; F289 only needs external session identity and recovery metadata.

## Task 5 — Build Resume Packet and work lifecycle service

**Files:**

- Create: `packages/api/src/domains/desktop-development-loop/DesktopDevelopmentService.ts`
- Create: `packages/api/src/domains/desktop-development-loop/ResumePacket.ts`
- Create: `packages/api/test/desktop-development-resume-packet.test.js`

**Red fixtures:** cold chat without history; active lease; superseding chat; expired lease; missing worktree path; fix-required packet; secret/private draft redaction; deterministic legal next actions.

**Green:** compose ProjectBinding + F275 attempt + Desktop projection + session binding + public ReviewRound view. Never serialize agent key, auth provenance or private review drafts.

## Task 6 — Implement exact-HEAD ReviewRound coordinator

**Files:**

- Create: `packages/api/src/domains/desktop-development-loop/ReviewRound.ts`
- Create: `packages/api/src/domains/desktop-development-loop/ReviewRoundStore.ts`
- Create: `packages/api/src/domains/desktop-development-loop/RedisReviewRoundStore.ts`
- Create: `packages/api/src/domains/desktop-development-loop/ReviewCoordinator.ts`
- Create: `packages/api/test/desktop-development-review-round.test.js`
- Create: `packages/api/test/desktop-development-review-barrier-race.test.js`

**Red fixtures:** fewer than two reviewers; author selected; draft read before barrier; concurrent final completions; SHA mutation/staleness; consensus with one supporter; open finding routed to new attempt; historical finding still open; zero-finding approval; retry after reconstruction.

**Green:** store reviewer drafts in private records; expose only self-draft before the atomic barrier. Preserve immutable rounds and link every replacement round to the same work root plus new exact HEAD.

## Task 7 — Add repository policy publication adapters

**Files:**

- Create: `packages/api/src/domains/desktop-development-loop/publication/ReviewPublicationAdapter.ts`
- Create: `packages/api/src/domains/desktop-development-loop/publication/TraqenGitHubIssuePublisher.ts`
- Reuse/modify as needed: `packages/api/src/domains/community/github/GitHubIssuePublisher.ts`
- Reuse: `packages/api/src/domains/plugin/plugin-config-store.ts` and the existing GitHub plugin `GITHUB_TOKEN` resolver
- Create: `packages/api/test/traqen-review-publication.test.js`

**Red fixtures:** bilingual EN/ZH equivalence fields required; consensus support <2 denied; wrong repository/allowlist denied; missing/insufficient/rotated token behavior; Desktop-supplied token rejected; token absent from logs/errors/MCP/Resume Packet; Git ledger sink denied; identical retry reuses issue; changed finding fingerprint conflicts; partial GitHub failure resumes safely; external URL receipt belongs to expected repo/issue.

**Green:** Cat Café server translates consensus objects into an issue body with exact SHA, severity, evidence, English and Chinese sections, then calls the existing typed `GitHubIssuePublisher`. Resolve `GITHUB_TOKEN` lazily from the authenticated local GitHub plugin configuration; prefer a fine-grained token restricted to `qianfengXY/Traqen` with repository Issues read/write. Bind the ProjectBinding repository to an exact server-side allowlist. Persist a publication fingerprint/receipt before the ReviewRound becomes actionable to Desktop; return only sanitized status and Issue URL.

Do not use shell-string concatenation for `gh`; use the existing typed publisher/client boundary and explicit repository identity. Never fall back to Desktop's `gh` credential or place the publisher token in ProjectBinding.

## Task 8 — Expose API and strict MCP lifecycle surface

**Files:**

- Create: `packages/api/src/routes/desktop-development-loop.ts`
- Modify: API route composition at the current central route registry
- Create: `packages/mcp-server/src/tools/desktop-development-loop-tools.ts`
- Modify: `packages/mcp-server/src/server-toolsets.ts`
- Modify: MCP tool registration entry point
- Create: `packages/api/test/desktop-development-loop-routes.test.js`
- Create: `packages/mcp-server/test/desktop-development-loop-tools.test.js`
- Extend: existing toolset/governance tests for F286

**Red fixtures:** unauthenticated/client-supplied actor denial; read/write role separation; stale version/epoch conflict; missing idempotency key; Desktop attempting reviewer action; cat attempting execution action; no shell/file/config/merge/deploy tool in profile; accurate annotations and profile snapshot.

**Green:** expose four lifecycle tools from the spec, with discriminated actions rather than one top-level tool per transition. The strict profile may include only the minimum existing feature-context/message/session tools. Return server-derived `nextLegalActions`.

## Task 9 — Wire Review dispatch and Cat Café projection

**Files:**

- Create: `packages/api/src/domains/desktop-development-loop/ReviewDispatchService.ts`
- Modify: the existing invocation/dispatch adapter chosen by architecture review
- Modify: existing TaskItem/work projection adapter, without adding raw work IDs to public DTOs
- Create: `packages/api/test/desktop-development-review-dispatch.test.js`
- Create: `packages/api/test/desktop-development-projection.test.js`

**Red fixtures:** default CodeX/Kimi dispatch; author excluded; private payload isolation; one reviewer failure/retry; both reviewers pin same SHA; public thread sees phase/evidence but not drafts/raw IDs; duplicate dispatch does not spawn duplicate review work.

**Green:** orchestrate reviewer invocations through existing Cat Café dispatch semantics. Use `TaskItem(kind='work')` only as a user-visible projection; never as lifecycle identity.

## Task 10 — Create the Desktop executor skill

**Files:**

- Create: `cat-cafe-skills/catcafe-desktop-executor/SKILL.md`
- Modify: `cat-cafe-skills/manifest.yaml`
- Modify: `cat-cafe-skills/refs/capability-wakeup-index.md`
- Create: `scripts/check-chatgpt-desktop-development-loop.mjs`
- Create: `scripts/check-chatgpt-desktop-development-loop.test.mjs`
- Modify: root `package.json` to register the guard

**Skill contract:**

1. read current work/Resume Packet;
2. claim only a returned legal action;
3. create/reuse the work's dedicated worktree;
4. implement and test locally;
5. commit/push/PR only when ProjectBinding permits;
6. report exact SHA/check evidence;
7. wait for Review verdict;
8. fix all published open findings and create a complete new round;
9. merge only on exact approved HEAD and policy permission;
10. stop at `acceptance_pending`.

The skill must explicitly forbid Cat Café source/test mutation, secret disclosure, author self-review, stale-HEAD continuation and inference from chat history when Resume Packet exists.

**Verify:** run skill manifest/guard tests and focused MCP/API tests.

## Task 11 — End-to-end recovery and bypass suite

**Files:**

- Create: `packages/api/test/integration/chatgpt-desktop-development-loop.test.js`
- Create: `packages/api/test/integration/chatgpt-desktop-development-loop-recovery.test.js`
- Create: `packages/api/test/integration/chatgpt-desktop-development-loop-bypass.test.js`

**Scenarios:**

1. design admission -> duplicate polls -> single claim -> implementation evidence -> two-private-reviewer barrier -> consensus issue -> new attempt/SHA -> zero findings -> acceptance pending;
2. app/service restart at every persisted transition;
3. new chat supersedes old chat during active lease;
4. stale SHA, stale epoch, wrong role, wrong project, policy mismatch and deploy attempt all fail closed;
5. publication timeout after external side effect reuses receipt/issue on retry;
6. two works in one Cat Café thread never exchange attempt/review evidence.

Run the focused suite repeatedly against isolated Redis before the full repository gate.

## Task 12 — Human activation on Mac mini

This task is intentionally not performed by an agent modifying config.

1. co-creator configures/rotates the existing GitHub plugin `GITHUB_TOKEN` through Cat Café's authenticated local plugin UI/API. Prefer a fine-grained token limited to `qianfengXY/Traqen` with Issues read/write; verify the stored secret is excluded from Git and never paste it into chat.
2. co-creator registers/rebinds the Traqen ProjectBinding, including the private local path, and verifies the exact repository allowlist. Repeat this step after a clean install, data-root loss, replacement Mac or checkout-path change; normal process restart should not require it.
3. co-creator creates/provisions the dedicated `chatgpt-desktop-dev` external principal and stores its agent key outside Git.
4. In ChatGPT Desktop MCP settings/config, add the locally reachable Cat Café MCP endpoint with toolset `desktop-dev-loop` and the principal credential. Do not expose it through cpolar unless a later security design explicitly requires remote MCP.
5. Restart ChatGPT Desktop and confirm the four lifecycle tools plus scoped context/session tools are visible; confirm arbitrary Cat Café source mutation tools and GitHub publisher credentials are absent.
6. Open the existing Traqen ChatGPT Project, create/choose the feature chat, invoke `$catcafe-desktop-executor`, and create a one-minute Scheduled Task in that same chat.
7. Keep the Mac awake while automated work is expected. Use ChatGPT Remote on mobile to observe/steer the actual Desktop chat.

Record screenshots/tool inventory with credentials redacted. Config values and secrets are not committed.

## Task 13 — Traqen dogfood

1. Register Traqen ProjectBinding with all automation flags false and `github_issues_bilingual` policy.
2. Admit a pilot work for existing `codex/frontend-restoration` HEAD `773a6de28c6942f2743831150644594e9c0335a9` without touching the Traqen root worktree/untracked files.
3. Let Desktop claim and run Traqen's repository commands:

```bash
npm test
npm run test:web
npm run web:build
npm run quality-gate
```

4. Run CodeX + Kimi independent Review on the same SHA, then cross-review. Publish only consensus findings as bilingual Issues.
5. Exercise a real or injected fix-required round, close all findings, approve exact HEAD and—with operator authorization—let Desktop perform push/PR/merge.
6. Replace the Desktop chat mid-work and prove Resume Packet/epoch recovery. Verify mobile Remote and Cat Café both show coherent progress.
7. Stop at `acceptance_pending`; co-creator performs the final product acceptance.

## Task 14 — Quality gate and staged rollout

Run at minimum:

```bash
pnpm check:features
node docs/architecture/ownership/generate-readme.mjs
pnpm check:skills
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/mcp-server test
pnpm --filter @cat-cafe/api test
pnpm gate
git diff --check origin/main...HEAD
```

Then run a non-author security/architecture review over the exact HEAD. Only after two clean Traqen works may co-creator change ProjectBinding flags in stages:

1. enable auto-push;
2. enable auto-PR;
3. optionally enable auto-merge while still requiring operator acceptance;
4. keep deploy disabled until a separate production-boundary design exists.

## Done evidence

- Feature AC table updated with exact test/commit/evidence refs.
- Ownership cells show F275 as work root and F289 as consumer/adapter.
- Strict MCP profile inventory is captured and contains no repository mutation primitive.
- Recovery/bypass suite is green on isolated Redis.
- Traqen dogfood links design commit, Desktop attempt, exact SHAs, checks, review rounds, bilingual issues, merge and operator acceptance.
- No user files in Traqen root worktree changed; no runtime config or secret entered Git.
