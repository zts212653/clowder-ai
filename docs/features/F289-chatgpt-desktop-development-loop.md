---
description: "Cat Café 负责需求、方案与多猫 Review，ChatGPT Desktop 负责实现、测试、修复与合入；以 durable managed work 串起两边会话与 Traqen 试点。"
related_features: [F065, F211, F247, F253, F261, F275, F286]
topics: [chatgpt-desktop, managed-work, mcp, multi-agent-review, traqen]
---

# F289: ChatGPT Desktop Development Loop

> Status: spec / Architecture Design Gate<br>
> Owner: CodeX (@cat-idwxwjba, GPT-5)<br>
> Priority: P1<br>
> Architecture cell: proposed `desktop-development-loop` (primary), consuming `managed-work`; extending `identity-session` and `mcp-surface-governance`<br>
> Map delta: new cell required — 新 cell 只拥有 Desktop adapter、ProjectBinding 与 ReviewRound；F275 继续独占 canonical work identity

## Why

co-creator 已在同一台 Mac mini 上部署 Cat Café 与 ChatGPT Desktop，并让两边都能访问个人仓库 Traqen。目标不是让两边都写代码，而是形成一条可恢复、尽量自动化、两边都可见的交付闭环：

1. Cat Café 多猫讨论需求与方案，提交冻结后的 Feature Doc / ADR。
2. ChatGPT Desktop 独占产品代码、测试代码、Bug 修复、commit、push、PR 与 merge。
3. 至少两只非作者猫在同一 exact code HEAD 上先独立检视，再交叉检视形成共识。
4. Cat Café 只运行既有验证命令，不写产品代码或测试；共识 finding 持久化在 ReviewRound，供 Desktop 读取。
5. ChatGPT Desktop 读取 finding，修复并提交新 HEAD；每个新 HEAD 重新走完整 Review round，直到零 open finding。
6. 合入后等待 co-creator 亲自验收。

两边的聊天窗口都不是过程真相源。任意一边切换或关闭会话后，系统必须能根据 durable work、attempt、review round 与 session binding 恢复，而不是要求用户重新讲一遍上下文。

## Current State / 2026-08-05 Baseline

### Traqen

- 本地仓库：`/Volumes/WorkSSD/projects/Traqen`；远端：`qianfengXY/Traqen`；默认分支：`main`。
- `.cat-cafe/capabilities.json` 与 `.codex/skills` 已让两边看到 Cat Café skills，但 `.cat-cafe/mcp-resolved.json` 为空。
- ChatGPT/Codex 全局配置当前未注册 Cat Café MCP，因此 Desktop 尚不能 claim/heartbeat/report Cat Café managed work。
- Traqen 当前有自己的 Review/publication policy，但它是可变的项目局部约束，不属于 F289 链路契约。F289 dogfood 只验证独立 Review、exact SHA 与 Cat Café 内部 finding delivery，不复制 Traqen 的 GitHub Issue、语言或 ledger 规则。
- Traqen 根 worktree 当前有用户未跟踪文件，F289 不触碰。首个 dogfood 候选使用现有独立 worktree/分支 `codex/frontend-restoration` 的本地 HEAD `773a6de28c6942f2743831150644594e9c0335a9`，对应 Issues #27/#28 的修复候选；是否 push 仍由 Desktop execution policy 决定。

### Cat Café

- F275 已提供 canonical `WorkAdmission` / `workId` / `attemptId`，但 Phase C 多 attempt 与 whole-work terminal 语义尚未完成。F289 必须作为 F275 的 named consumer/adapter，不得另建平行 `DevelopmentJob` 身份。
- F211 external runtime session 当前只接受 `antigravity-desktop`，尚不能登记 ChatGPT Desktop session/chat。
- F247 的 Desktop/Cloud Pro strict phase-0 profile 只有十个 message/memory 工具，不包含 pending cursor/ack、managed work lifecycle 或 review lifecycle。
- F286 要求 MCP 以有类型的资源生命周期组织，并明确 authority、side effect 与 drill-down；F289 不增加一堆临时 CRUD 工具。
- PR #1289 中的 ChatGPT review-round 文档可作 independent-first / repeat-until-zero 的语义参考，但其 Git ledger 只是某一种项目呈现方式，不进入 F289 core。

## Product Contract

### Role boundary

| Actor | Can do | Must not do |
|---|---|---|
| Cat Café cats | 需求讨论、方案设计、Feature Doc/ADR、只读代码检视、运行既有 test/lint/build/typecheck/static checks、独立 findings、交叉共识、按仓库政策发布 finding | 实现产品任务、修 Bug、编写或修改测试、在独立 Review 阶段写 Git |
| ChatGPT Desktop developer | 创建独立 worktree、实现、写/改测试、运行验证、commit/push/PR、修复 findings、满足 gate 后 merge | 作为自己代码的 reviewer、改写猫猫私有独立 finding、绕过 Review barrier |
| co-creator | 冻结宏观方案、修改授权/密钥/运行时配置、最终验收、必要时覆盖 reviewer roster 或自动化策略 | 被迫在每个普通 SOP 步骤中手工路由消息 |

ChatGPT Desktop developer 必须使用独立、不可参与 Review 的 external principal，例如 `chatgpt-desktop-dev`；不能复用 Maine Coon reviewer cat identity。

### Durable objects and ownership

| Object | Canonical owner | Identity / purpose | Persistence |
|---|---|---|---|
| `ProjectBinding` | F289 desktop adapter | repo identity、default branch、local path reference、default reviewers、automation policy | TTL=0; local path stays local runtime data, never committed |
| `WorkAdmission` | F275 `managed-work` | whole-work canonical root | TTL=0 |
| `WorkAttempt` | F275 `managed-work` | ordered attempt identity and whole-work attempt continuity | TTL=0 |
| `DesktopExecutionAttempt` | F289 desktop adapter | projection over one F275 `attemptId`: claim/lease/session/evidence/execution phase | TTL=0 |
| `RuntimeSessionBinding` | F211 `identity-session` | active ChatGPT Desktop Project/chat/session binding and epoch | TTL=0 |
| `ReviewRound` | F289 review coordinator | exact reviewed code HEAD, reviewer barrier, private drafts, consensus and open findings | TTL=0 |
| `TaskItem(kind='work')` | existing task projection | optional user-visible status card only | follows existing task policy; never identity root |

### Lifecycle

Whole-work terminal truth remains owned by F275. F289 supplies typed attempt/review events:

```text
design_ready
  -> ready_for_desktop
  -> claimed -> implementing -> implementation_ready
  -> independent_review -> cross_review
  -> fix_required -> ready_for_desktop (new attempt / new exact HEAD)
  -> approved_for_merge -> merging -> acceptance_pending
  -> accepted | rejected
```

`accepted/rejected` are F275 whole-work transitions backed by typed evidence; the Desktop adapter may propose evidence but may not create a competing terminal ledger.

### F275 dependency gate

F289 cannot currently assume that the full lifecycle above is executable: F275 Phase C multi-attempt and whole-work terminal semantics are deferred. Before any F289 runtime implementation starts, the F275 owner must freeze and approve a named-consumer port that provides, at minimum:

1. read/validate an existing `{workId, attemptId}` without exposing raw identity publicly;
2. idempotently create the next ordered attempt for the same work after `fix_required`;
3. attach typed implementation/review/merge/acceptance evidence to that work/attempt;
4. apply or reject `accepted/rejected` whole-work transitions under F275-owned rules.

There is no F289-local fallback work root, attempt sequence or terminal ledger. If the F275 port is unavailable or insufficient, automated claims remain disabled and only contract/design work may proceed. This is a blocking Design Gate, not an implementation detail to improvise inside the adapter.

### Core invariants

1. One `DesktopExecutionAttempt` has at most one active lease and one current session binding epoch.
2. Claim, heartbeat, transition and evidence writes require agent-key principal, optimistic version and idempotency key.
3. A resumed/new Desktop chat increments binding epoch; the old session immediately loses write authority.
4. Every ReviewRound pins one full commit SHA. Any code/test/config change makes the round stale and requires a complete new round.
5. Review requires at least two configured, non-author reviewers. Draft findings remain private until every reviewer finishes independently.
6. Cross-review can start only after the independent barrier closes; consensus requires support/evidence from at least two reviewers.
7. `openFindings > 0` implies `fix_required`; merge eligibility requires all historical consensus findings closed and the latest exact HEAD approved.
8. Cats may execute existing repository validation but cannot mutate source or tests. The Desktop author cannot review its own attempt.
9. ReviewRound consensus is the F289 delivery truth. Desktop reads it through MCP; repository Issues, comments, ledgers or languages are not required for round completion.
10. No automatic deployment or production data mutation. Initial dogfood keeps auto-merge disabled and requires operator acceptance after merge.

## User Journey

### Primary: one feature from design to acceptance

1. co-creator and cats converge in a Cat Café feature thread; the frozen design is committed to the personal repository.
2. Cat Café admits the feature as managed work and exposes a `ready_for_desktop` attempt.
3. A one-minute Scheduled Task in the matching ChatGPT Desktop Traqen Project/chat reads the strict MCP surface, claims the attempt and develops in a dedicated worktree.
4. ChatGPT Desktop posts status, commit SHA and test evidence to Cat Café. The same work is visible in the Desktop chat/Remote and in Cat Café thread/task projection.
5. Cat Café starts CodeX + Kimi independent Review on the exact SHA. Neither sees the other draft before the barrier.
6. After cross-review, Cat Café freezes agreed findings in the ReviewRound; ChatGPT Desktop reads the typed consensus directly through MCP.
7. ChatGPT Desktop receives `fix_required`, fixes all open issues, commits a new SHA and starts a new full round.
8. Zero findings on the latest SHA produces `approved_for_merge`. Desktop merges according to ProjectBinding policy and reports merge evidence.
9. Work enters `acceptance_pending`; only co-creator's personal acceptance closes it as `accepted`.

### Recovery after either chat closes

1. Scheduled execution or a replacement chat reads the active work by `workId` rather than conversation history.
2. It obtains a new session binding epoch and lease, then receives a Resume Packet containing project, branch/worktree, current attempt, exact HEAD, checks, open findings, next legal action and provenance links.
3. Old sessions may remain readable but cannot write after their lease/binding is superseded.
4. If the Mac is asleep or ChatGPT Desktop is stopped, the attempt remains durable and becomes resumable after restart; it is not marked failed solely because the UI disappeared.

## MCP Surface

Add a strict `desktop-dev-loop` toolset. ChatGPT Desktop already has local repository tools, so Cat Café MCP must not expose shell or file-write capabilities.

The initial surface is resource-oriented and authority-separated:

- `cat_cafe_development_work_read`: list/read/resume-packet read actions.
- `cat_cafe_development_work_action`: claim, heartbeat, report evidence, request review, release; no cancel/merge/deploy.
- `cat_cafe_review_round_read`: current barrier/verdict/open consensus findings.
- `cat_cafe_review_round_action`: reviewer-only draft/finish/cross-review/consensus actions.
- existing scoped context/message tools needed to read the feature thread and post status.
- external runtime session register/list/read extended with `chatgpt-desktop`.

Each write action declares side-effect annotations, validates principal role, scope, expected version and idempotency key, and returns the updated resource plus next legal actions.

## Traqen ProjectBinding Pilot

```yaml
projectId: traqen
repository: qianfengXY/Traqen
defaultBranch: main
developmentActor: chatgpt-desktop-dev
defaultReviewers: [codex, kimi]
findingDelivery: catcafe_mcp
allowAutoPush: false
allowAutoPr: false
allowAutoMerge: false
requireOperatorAcceptance: true
allowDeploy: false
```

The local path `/Volumes/WorkSSD/projects/Traqen` is runtime-local ProjectBinding data, not committed configuration. After the first two successful dogfood works, co-creator may explicitly enable auto-push/PR and later auto-merge for this personal repository; upstream/fork policy remains unrelated and unchanged.

### ProjectBinding bootstrap and recovery

- Normal Cat Café process restart reconstructs the TTL=0 ProjectBinding from the persistent store.
- A clean installation, replacement Mac, changed local checkout path or loss of the Cat Café data store requires an authenticated operator to re-register/rebind ProjectBinding before claims resume. F289 does not infer a binding from a matching folder, Git remote or chat history.
- Re-registration uses repository identity plus an expected binding version, never imports credentials, and fails closed until the local path and repository identity are revalidated.
- The Traqen dogfood runbook must exercise this manual bootstrap/rebind path once; it is a recovery prerequisite, not an automatic-discovery dependency.

## Phases

### Phase A — Contract and safe registration

- Obtain F275 owner approval of the named-consumer multi-attempt/evidence/terminal port; until then runtime claims stay disabled.
- Freeze ProjectBinding, principal, state/events, Resume Packet and strict MCP contract.
- Extend runtime-session type with `chatgpt-desktop` without weakening `antigravity-desktop` invariants.
- Add local ProjectBinding registration/rebind and fail-closed repository identity validation.

### Phase B — Managed execution and recovery

- Make F289 a named F275 consumer; add attempt lease, cursor/ack, idempotency and session binding epoch.
- Support resume after ChatGPT chat replacement, app restart and lease expiry.
- Project progress into existing Cat Café thread/task surfaces.

### Phase C — Multi-cat Review coordinator

- Pin exact HEAD; enforce two-reviewer independent barrier; store drafts privately.
- Support cross-review, consensus, stale round and repeat-until-zero.
- Expose only barrier-safe consensus findings to Desktop through MCP; external publication is out of scope.

### Phase D — Desktop executor and observability

- Add `$catcafe-desktop-executor` skill with legal-action loop and recovery rules.
- Human configures the strict Cat Café MCP server and a one-minute Scheduled Task in the matching Desktop chat.
- Desktop/Remote and Cat Café both show the same work identity, phase, evidence and next action.

### Phase E — Traqen dogfood

- Run the first loop on `codex/frontend-restoration` / `773a6de...` without touching Traqen root worktree.
- Verify existing Issues #27/#28, new ReviewRound behavior, session switch recovery, zero-finding merge gate and operator acceptance.
- Enable more automation only after evidence from two clean pilot works.

## Requirements Checklist

| ID | Requirement | AC | Verification | Status |
|---|---|---|---|---|
| R1 | Cats retain A2A design and Review; Desktop owns all implementation/tests/fixes | AC-A1, AC-C5 | role authorization tests + dogfood diff audit | [ ] |
| R2 | Both surfaces show one logical work and current progress | AC-B5, AC-D3 | paired Cat Café/Desktop observation fixture | [ ] |
| R3 | Session change does not lose or duplicate unfinished work | AC-B2, AC-B3 | crash/rebind/old-session rejection tests | [ ] |
| R4 | Review is two-cat, independent-first, exact-HEAD and repeat-until-zero | AC-C1..C4 | state-machine/concurrency/stale-head tests | [ ] |
| R5 | Consensus findings reach Desktop without importing project-specific publication rules | AC-C6 | ReviewRound/MCP delivery contract tests | [ ] |
| R6 | Normal polling is automatic and mobile-visible | AC-D1, AC-D2 | Scheduled Task + Remote dogfood evidence | [ ] |
| R7 | No automatic deploy; merge still ends at operator acceptance | AC-D4, AC-E4 | policy denial + acceptance transition tests | [ ] |

## Acceptance Criteria

### Phase A

- [ ] AC-A1: role matrix is enforced at API/MCP boundaries; `chatgpt-desktop-dev` is never review-eligible and cats cannot obtain source/test mutation actions from this MCP profile.
- [ ] AC-A2: ProjectBinding validates repository identity, local-only path, reviewer roster and automation policy; no project-specific review publication rule is required.
- [ ] AC-A3: MCP `desktop-dev-loop` exposes only the documented lifecycle/context/session tools with accurate read/write annotations and agent-key auth.
- [ ] AC-A4: F211 can register/read/list `chatgpt-desktop` sessions without regressing existing `antigravity-desktop` fixtures.
- [ ] AC-A5: the F275 owner approves a named-consumer port for next-attempt creation, typed evidence and whole-work terminal transitions; absence disables runtime claims, and no F289 fallback identity/state machine exists.

### Phase B

- [ ] AC-B1: every desktop attempt references an existing F275 `{workId, attemptId}`; no second work identity/state owner exists.
- [ ] AC-B2: claim/heartbeat/report are idempotent and optimistic-versioned; duplicate delivery cannot duplicate attempts/evidence.
- [ ] AC-B3: only one lease/session epoch can write; crash, lease expiry, app restart and new-chat rebind recover the same work while rejecting stale writers.
- [ ] AC-B4: Resume Packet is sufficient to continue without prior chat history and includes no secret or private reviewer draft.
- [ ] AC-B5: existing Cat Café thread/task projection and ChatGPT Desktop chat report the same work phase, exact HEAD and next action.

### Phase C

- [ ] AC-C1: ReviewRound is immutable to one full SHA and becomes stale on any code/test/config delta.
- [ ] AC-C2: at least two non-author reviewers complete independently before any draft becomes cross-visible; concurrent finishes cannot open the barrier early.
- [ ] AC-C3: consensus requires evidence/support from at least two reviewers; `openFindings > 0` always routes to a new Desktop attempt/full round.
- [ ] AC-C4: approval requires the latest exact HEAD plus zero current and historical open consensus findings.
- [ ] AC-C5: review command audit proves cats changed no source/test files and the Desktop author cast no review vote.
- [ ] AC-C6: Desktop can idempotently read only barrier-safe consensus findings from the latest ReviewRound; draft findings remain private and no external Issue/ledger artifact is required.

### Phase D/E

- [ ] AC-D1: executor skill follows only server-returned legal actions and survives empty polls, transient MCP failure and resume.
- [ ] AC-D2: one-minute Scheduled Task operates in the intended Desktop Project/chat and progress is visible from ChatGPT Remote while the Mac is awake.
- [ ] AC-D3: Cat Café surfaces attempt/review/finding/merge evidence without copying hidden independent drafts into the public thread.
- [ ] AC-D4: push/PR/merge follow per-project flags; deploy is denied; merge produces `acceptance_pending`, not `accepted`.
- [ ] AC-E1: Traqen pilot runs in a dedicated worktree and leaves root untracked files untouched.
- [ ] AC-E2: pilot includes at least one `fix_required -> new SHA -> full new ReviewRound` cycle or an injected equivalent fixture.
- [ ] AC-E3: closing/replacing one ChatGPT chat during the pilot resumes the same work with no duplicate commit, issue or attempt.
- [ ] AC-E4: only co-creator acceptance closes the work; rejection reopens it with typed evidence.

## State and Event Contract

| State | Entered by | Legal outgoing event | Recovery rule |
|---|---|---|---|
| `ready_for_desktop` | Cat Café design/admission | `attempt.claimed` | remains visible until claimed; no destructive timeout |
| `claimed` / `implementing` | Desktop principal | heartbeat, evidence, release, `implementation.ready` | expired lease is resumable; not terminal |
| `implementation_ready` | Desktop principal with code/test evidence | `review.started` | exact HEAD is frozen before reviewer dispatch |
| `independent_review` | coordinator | reviewer private finish | barrier opens atomically only after all required reviewers finish |
| `cross_review` | coordinator/reviewers | consensus verdict | no source mutation authority |
| `fix_required` | consensus | new F275 attempt / Desktop claim | old round remains immutable; new SHA requires new round |
| `approved_for_merge` | consensus gate | Desktop merge evidence | head/continuity is rechecked immediately before merge |
| `acceptance_pending` | F275 from merge evidence | operator accept/reject | no automatic acceptance |

## Eval / Tracking Contract

- **Primary users**: co-creator, Cat Café reviewers, ChatGPT Desktop developer.
- **Activation signal**: a ProjectBinding admits a work and reaches `ready_for_desktop`.
- **Success metric**: a work reaches `acceptance_pending` with reconstructable design, attempt, exact-HEAD review, issue and test evidence; user performed no routine copy/paste routing.
- **Friction metric**: manual interventions per work excluding macro decision/acceptance; duplicate execution/finding delivery count; stale-session write rejections; mean unowned-ready duration.
- **Regression fixtures**: same-thread two works; duplicate scheduled poll; lease expiry mid-command; new session racing old session; reviewer barrier race; SHA change during review; duplicate consensus read.
- **Sunset/suspend signal**: any duplicate code attempt, leaked private draft, unauthorized role mutation or cross-work finding delivery immediately disables automated claims for the affected ProjectBinding.

## Non-Goals

- 不让 Cat Café 远程操控 ChatGPT Desktop UI；联动通过 durable work + strict MCP。
- 不把 ChatGPT Desktop 变成 Cat Café 内的一只 reviewer 猫。
- 不让 Cat Café MCP 提供仓库 shell/file mutation；Desktop 使用自己的本地开发工具。
- 不承诺电脑休眠或 Desktop 未运行时仍执行；恢复语义负责“不丢”，不是云端代跑。
- 不在首个 pilot 自动 deploy，也不把个人仓库授权扩展为 Cat Café fork 上游授权。
- 不把 Traqen 或任何试点仓库当前的 Issue、语言、ledger、PR comment 规则提升为链路产品契约；需要外部同步时由项目另行选择适配器。
- 不用一个永不结束的大 Chat 承载所有项目任务；每个 feature/job 有独立 chat，但 durable work 跨 chat 延续。

## Dependencies and Review Gate

- **Depends on / extends**: F275 (`managed-work`), F211/F065 (`identity-session`/continuity), F286 (MCP lifecycle governance), F247 (Desktop connector baseline), F261 (durable execution recovery), F253 (QC semantics).
- **Design Gate**: F275 owner must approve the named-consumer attempt/evidence/terminal port and verify ownership; non-author reviewer must verify security, session recovery, internal finding-delivery and state-machine contracts. Until both are recorded, Phase A runtime implementation and automated claims are blocked.
- **Runtime activation gate**: co-creator manually provisions the external principal/agent key and edits ChatGPT Desktop MCP config. Secrets never enter Git or chat.
- **Automation rollout gate**: first pilot manual push/PR/merge; two clean works before enabling broader per-project automation.

## Key Decisions

| # | Decision | Why | Date |
|---|---|---|---|
| KD-1 | Cat Café is design/Review plane; ChatGPT Desktop is implementation plane | preserves multi-cat judgment while avoiding two writers competing on source | 2026-08-05 |
| KD-2 | Same repo, separate writable worktrees | both sides see one truth without concurrent index/worktree mutation | 2026-08-05 |
| KD-3 | Reuse F275 work/attempt identity | session and thread are views; parallel job identity would split recovery truth | 2026-08-05 |
| KD-4 | Desktop developer is a non-reviewable external principal | prevents self-review and cat identity confusion | 2026-08-05 |
| KD-5 | ReviewRound consensus is the core finding-delivery truth | project-local Issue/ledger/language rules must not constrain the generic loop | 2026-08-05 |
| KD-6 | Default Traqen reviewers are CodeX + Kimi | deterministic pilot automation while operator retains override | 2026-08-05 |
| KD-7 | Scheduled Task polling first; custom App Server push is later | uses supported Desktop execution/Remote visibility with bounded one-minute latency | 2026-08-05 |
| KD-8 | Session replacement uses epoch + lease + Resume Packet | closing a chat must revoke stale writers without losing work | 2026-08-05 |
| KD-9 | No Cat Café source/test development authority | cats may validate findings but all implementation and test edits return to Desktop | 2026-08-05 |
| KD-10 | Initial Traqen automation is fail-closed and staged | personal repo removes upstream ambiguity, but duplicate execution remains material | 2026-08-05 |
| KD-11 | No F289 fallback for missing F275 attempt/terminal semantics | a temporary parallel ledger would become a second work truth and break recovery | 2026-08-05 |
| KD-12 | Traqen policy is dogfood-local, not F289 core | a pilot may validate the chain but cannot dictate the product contract | 2026-08-05 |
