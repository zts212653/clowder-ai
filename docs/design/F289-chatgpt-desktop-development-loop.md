# F289 Design Gate — Cat Café × ChatGPT Desktop Development Loop

Date: 2026-08-05<br>
Status: proposed; awaiting non-author architecture review<br>
Feature truth: `docs/features/F289-chatgpt-desktop-development-loop.md`

## Operator journey truth

The design converged from the following operator requirements in the Cat Café thread:

- `0001785893909985-000192-8d0eb68c`: cats retain dialogue, requirements, design and code Review; all development and Bug fixes go to ChatGPT Desktop.
- `0001785916078772-000242-6553d1dc`: cats may commit design/review artifacts and validate code logic, but do not develop tasks or tests.
- `0001785917643838-000256-d05deb9b`: a default Review publisher/recorder is desirable; one endless chat is not required.
- `0001785917973085-000260-3f3c3ba2`: unfinished Feature work must survive either side closing or replacing a conversation.
- `0001785918577244-000262-62c238f2`: use the already mounted Traqen repository on the local Mac mini as the implementation pilot.

## One straight path

```text
Cat Café feature thread
  design + managed-work admission
        |
        v
F275 workId / attemptId  <---->  ChatGPT Desktop Project + feature Chat
        |                              |
        | strict MCP claim/evidence    | local code/test/commit tools
        v                              v
exact code HEAD ----------------> dedicated Traqen worktree
        |
        v
CodeX private review + Kimi private review
        |
   independent barrier
        v
cross-review consensus
        |
        +-- open findings --> bilingual Traqen GitHub Issues
        |                       --> Desktop new attempt/new HEAD
        |
        +-- zero findings --> Desktop merge --> operator acceptance
```

This is one logical work viewed from two products, not UI automation between two chat windows. Durable state is in Cat Café; repository truth is in Git; each chat is a replaceable execution/view binding.

## Boundary decisions

### Why not share one writable checkout?

Reviewers may run existing commands that create caches or build output, while Desktop may edit/index/commit concurrently. A single writable checkout risks index locks, accidental staging and evidence drift. Both systems use the same repository but different worktrees pinned to the same SHA during Review.

### Why not use the previous Git Review ledger?

Traqen's repository policy explicitly forbids committing Review ledgers and allows confirmed findings only as bilingual GitHub Issues. The generic term is therefore `reviewPublisher`, not recorder. The ProjectBinding selects `github_issues_bilingual`; policy mismatch fails closed.

### Why polling rather than controlling the Desktop UI?

ChatGPT Desktop Scheduled Tasks provide a supported way for the intended Project/chat to wake regularly, and ChatGPT Remote exposes the same desktop execution to mobile. Cat Café only exposes a lifecycle queue. It does not need Accessibility/browser automation, does not steal user input and can recover from UI replacement.

### Why not create `DevelopmentJob`?

F275 already owns admitted whole-work identity and attempt continuity. F289 adds an adapter/projection and ReviewRound references. A second job root would create irreconcilable terminal and recovery states.

## State authority matrix

| Question | Truth source | Forbidden substitute |
|---|---|---|
| What work is this? | F275 `WorkAdmission.workId` | thread ID, chat title, branch name |
| Which execution try? | F275 `attemptId` + Desktop attempt projection | latest message or most recent lease |
| Which Desktop chat may write? | session binding epoch + active lease | a remembered conversation ID alone |
| What code was reviewed? | immutable full Git SHA in ReviewRound | branch tip or PR URL alone |
| Did reviewers finish independently? | private reviewer completion records + atomic barrier | public chat messages |
| What findings are actionable? | consensus records + repository publication receipts | one reviewer's draft |
| May it merge? | latest approved exact HEAD + zero open history + project policy | tests green alone |
| Is the work complete? | F275 terminal transition backed by operator acceptance | merge event alone |

## Resume Packet

Every replacement Desktop chat receives a bounded packet generated from durable truth:

```yaml
workId: internal opaque id
attemptId: internal opaque id
projectId: traqen
repository: qianfengXY/Traqen
featureDoc: repository-relative path and commit
branch: feature branch
worktree: local runtime path
phase: implementing | fix_required | approved_for_merge | ...
codeHead: full SHA or null
latestChecks:
  - command: npm test
    result: passed | failed
    evidenceRef: opaque pointer
review:
  roundId: opaque id
  openFindingIssueUrls: []
nextLegalActions: []
bindingEpoch: integer
leaseExpiresAt: timestamp
```

It excludes secrets, raw agent keys and private reviewer drafts. The server returns legal next actions so the skill need not infer lifecycle transitions.

## Failure-mode review

| Failure | Required behavior |
|---|---|
| Scheduled poll is delivered twice | same idempotency key returns same claim/evidence result |
| Old and replacement chats race | higher binding epoch owns write; stale chat gets a typed conflict |
| Desktop exits mid-command | lease expires; attempt remains resumable; no fake failure/finish |
| Cat Café restarts | TTL=0 objects reconstruct work, lease and ReviewRound |
| Reviewer finishes twice | idempotent private completion; barrier count unchanged |
| One reviewer tries to read another draft early | authorization denial; no draft data in error/projection |
| Branch moves after Review starts | full SHA mismatch marks round stale; complete new round required |
| GitHub Issue publish retries | idempotency/fingerprint reuses the same issue |
| Publisher attempts Git ledger in Traqen | repository policy adapter rejects it |
| Repository mapping is missing/wrong | no external write; work enters explicit blocked state |
| Mac sleeps | no execution while asleep; durable attempt resumes after wake |
| Operator rejects merged result | F275 records typed rejection and opens a new attempt; not silently accepted |

## Security Design Gate

- A dedicated non-reviewable external principal is provisioned for ChatGPT Desktop.
- The agent key is stored only in local secret/config facilities; it is never committed or pasted into messages.
- MCP is local to the Mac where possible; cpolar is for Cat Café UI access, not a reason to expose development MCP publicly.
- Strict MCP toolset has no arbitrary shell, file write, config mutation, merge or deploy primitive.
- Per-project policy gates push/PR/merge; initial Traqen values are false.
- Review private drafts, raw work IDs and authentication provenance are excluded from user/public projections.
- Wrong repo, unknown policy, stale SHA, stale epoch and missing publisher authority all fail closed.

## Design Gate checklist

- [ ] F275 owner confirms no canonical identity or terminal ownership duplication.
- [ ] F211 owner confirms generic runtime-session extension rather than ChatGPT-specific forked storage.
- [ ] F286 governance review confirms lifecycle surface and annotations.
- [ ] Non-author reviewer validates role segregation, session-race and Review barrier tests.
- [ ] Traqen policy adapter test proves bilingual Issue-only publication and no Git ledger.
- [ ] co-creator performs runtime principal/key/config activation after implementation; no agent edits runtime config.
