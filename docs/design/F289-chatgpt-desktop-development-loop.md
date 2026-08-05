# F289 Design Gate — Cat Café × ChatGPT Desktop Development Loop

Date: 2026-08-05<br>
Status: proposed; awaiting non-author architecture review<br>
Feature truth: `docs/features/F289-chatgpt-desktop-development-loop.md`

## Operator journey truth

The design converged from the following operator requirements in the Cat Café thread:

- `0001785893909985-000192-8d0eb68c`: cats retain dialogue, requirements, design and code Review; all development and Bug fixes go to ChatGPT Desktop.
- `0001785916078772-000242-6553d1dc`: cats may commit design/review artifacts and validate code logic, but do not develop tasks or tests.
- `0001785917643838-000256-d05deb9b`: a default Review recorder was discussed; the later scope correction makes Cat Café ReviewRound the default truth and keeps repository publication project-local. One endless chat is not required.
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
        +-- open findings --> Cat Café ReviewRound consensus
        |                       --> Desktop new attempt/new HEAD via MCP
        |
        +-- zero findings --> Desktop merge --> operator acceptance
```

This is one logical work viewed from two products, not UI automation between two chat windows. Durable state is in Cat Café; repository truth is in Git; each chat is a replaceable execution/view binding.

## Boundary decisions

### Why not share one writable checkout?

Reviewers may run existing commands that create caches or build output, while Desktop may edit/index/commit concurrently. A single writable checkout risks index locks, accidental staging and evidence drift. Both systems use the same repository but different worktrees pinned to the same SHA during Review.

### Where do findings live?

F289 needs one generic handoff truth, so barrier-safe consensus findings live in Cat Café ReviewRound and Desktop reads them through MCP. Git ledgers, GitHub Issues, PR comments and language requirements are project-local presentation choices outside the MVP. Traqen's current policy may change without changing F289.

### Why polling rather than controlling the Desktop UI?

ChatGPT Desktop Scheduled Tasks provide a supported way for the intended Project/chat to wake regularly, and ChatGPT Remote exposes the same desktop execution to mobile. Cat Café only exposes a lifecycle queue. It does not need Accessibility/browser automation, does not steal user input and can recover from UI replacement.

### Why not create `DevelopmentJob`?

F275 already owns admitted whole-work identity and attempt continuity. F289 adds an adapter/projection and ReviewRound references. A second job root would create irreconcilable terminal and recovery states.

### F275 owner contract is a blocking dependency

F275 Phase C is deferred, so F289 cannot infer that `fix_required -> next attempt` or `merge -> accepted/rejected` already exists. Before runtime implementation, the F275 owner must approve one named-consumer port covering existing work/attempt reads, idempotent next-attempt creation, typed evidence attachment and F275-owned terminal transitions. F289 has no bounded private fallback: if the port cannot be supplied, runtime claims stay off and the feature remains at contract/design scope.

This keeps the boundary honest: F289 owns Desktop leases, session binding and ReviewRound; F275 owns ordered attempts and whole-work terminal truth.

## State authority matrix

| Question | Truth source | Forbidden substitute |
|---|---|---|
| What work is this? | F275 `WorkAdmission.workId` | thread ID, chat title, branch name |
| Which execution try? | F275 `attemptId` + Desktop attempt projection | latest message or most recent lease |
| Which Desktop chat may write? | session binding epoch + active lease | a remembered conversation ID alone |
| What code was reviewed? | immutable full Git SHA in ReviewRound | branch tip or PR URL alone |
| Did reviewers finish independently? | private reviewer completion records + atomic barrier | public chat messages |
| What findings are actionable? | barrier-safe ReviewRound consensus | one reviewer's draft or an optional external artifact |
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
| Cat Café data store or Mac is replaced | claims stay disabled until authenticated operator re-registers ProjectBinding and revalidates local path/repository policy |
| Reviewer finishes twice | idempotent private completion; barrier count unchanged |
| One reviewer tries to read another draft early | authorization denial; no draft data in error/projection |
| Branch moves after Review starts | full SHA mismatch marks round stale; complete new round required |
| Desktop polls the same consensus twice | stable round/version returns the same findings without duplicating work |
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
- Wrong repo, stale SHA and stale epoch all fail closed.

## Design Gate checklist

- [ ] **Blocking:** F275 owner approves the named-consumer port for existing attempt reads, idempotent next-attempt creation, typed evidence and whole-work terminal transitions; missing support leaves F289 claims disabled and creates no fallback ledger.
- [ ] F211 owner confirms generic runtime-session extension rather than ChatGPT-specific forked storage.
- [ ] F286 governance review confirms lifecycle surface and annotations.
- [ ] Non-author reviewer validates role segregation, session-race and Review barrier tests.
- [ ] ReviewRound/MCP contract proves Desktop sees only barrier-safe consensus and does not require any repository Issue/ledger/comment artifact.
- [ ] ProjectBinding bootstrap/rebind test proves process restart recovery and authenticated manual recovery after data-root/path migration.
- [ ] co-creator performs runtime principal/key/config activation after implementation; no agent edits runtime config.
