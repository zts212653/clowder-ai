---
name: custody-recognition
tips_exempt: "普通话语在原 Feature 现场自然触发责任核验；这份内部 owner 政策不要求用户学新命令，原现场实样验收前不发布使用提示。"
description: "Use when 托付、获准开发或 Phase 续做。Not for 随口提及、未接受计划或注意力判断。Output: offer、Task 接责/续接或 abstain。"
triggers:
  - "帮我接住"
  - "帮我跟踪"
  - "之后要做"
  - "别忘了"
  - "custody offer"
  - "needs_clarification"
  - "接受立项并开工"
  - "继续 Phase"
---

# Custody Recognition

This skill is the soft recognition policy at the ordinary conversation entry. It never owns work,
attention, or scheduling truth. The exact source Message owns the offer/disposition; Task alone owns
durable custody.

## Read the exact source first

Use the current source message id. Read any source-bound custodyOfferV1 already supplied in context
before choosing a branch:

- pending: do not create another offer or Task. Let the original rich choice stand.
- accepted + admitted/resumed: custody already exists. Do not prompt again; use the returned owner ref
  when continuing the work.
- accepted + needs_clarification: ask only the missing decision-changing question in this same
  conversation. After the answer, use cat_cafe_retry_custody_admission with the exact source revision,
  offer id, and complete Task contract. The server reuses the stored idempotency key.
- declined/dismissed: do not re-offer or admit. Continue conversationally unless the human later makes
  a new explicit entrustment.

## Choose one branch

### Accepted development or Phase continuation

“开始开发这个 Feature”, “继续 Phase C”, and “接着把这个阶段做完” can entrust work without a deadline.
Read the human source and accepted scope; the words alone do not authorize a future Phase. A Feature
mention, an unaccepted idea, opening a document, and a cat handoff remain evidence to interpret, not a
new human admission. A delegated execution thread does not acquire the original Task's read/write rights.

For authorized development in its original owner thread, use `cat_cafe_development_work`:

- `cat_cafe_resolve_development_work`: exact human source/revision and `scope { featureRef: "feature:F310", phaseKey: "B",
  acceptedRevision: "<40-character Git SHA>" }`. Owner resolves the stable Phase ref. Use explicit
  `workUnitRef` for an accepted existing `task:work:<id>` or `file:feature-specs/<file>.md#<anchor>`, or the
  exact `feature-phase:<id>:<key>` to choose the Phase itself. Keys preserve the declared spelling,
  including `1`, `1.5`, `1b`, `A+`, and `C/D`; never split or rename a compound declared key.
  Automatic selection reuses your own same-thread open sub-work;
  another cat’s child does not replace your Phase responsibility. Never bind by title or message ID.
- Follow the returned owner disposition: `resume` with exact Task/revision; `adopt` a generic Task with
  its owner snapshot; `bind` the missing scope of existing entrusted work with its current revision.
  If no existing responsibility was resolved, `admit` the accepted scope with outcome/closure.
- Preserve the first admission, owner/thread and Task id. Each new source supplies an action retry key.
  A terminal predecessor needs a newly authorized outcome; an open parent remains a parent, not a
  completed predecessor. `scope_unavailable_here` carries no details and permits no duplicate creation.
- `scope_unverifiable` means the accepted source could not be read reliably: retry that exact revision
  after the reported condition is resolved; do not reinterpret it as absent work or create a generic Task.
  `scope_invalid` requires checking the declared Phase/anchor; `scope_ambiguous` requires choosing an
  already accepted exact unit. `forbidden`/`scope_closed` require the current owner/authorization boundary.
- Read the typed result, give a compact acknowledgement and actually continue the work. Publish real
  materials through the Artifact owner, attach their refs through `update_entrusted_work`, and use the
  existing owner read for current state and exact return. A Task receipt, report or Git link is not delivery.

After the receipt, follow the development path the work actually needs (`worktree`, `tdd`, review and
merge gate when their risk triggers apply). At each resumed invocation, reread the same Task and current
authority, then perform the next authorized action; another status message is not continuation. “尽快”
requires naming the next inspectable material and an evidenced estimate or the fact still missing for one.
If progress slows, tell the human what changed while continuing to handle it. Do not invent a deadline or
turn that update into a Needs Me decision without a genuine human choice.

This replaces generic `create_task` on accepted development. Media/research and work with no declared
Feature Phase continue through the generic explicit-entrustment branch below; do not invent a Feature
or Phase to fit this tool. Time, genuine human judgment, and scope changes retain their own owners.

When this work has an approved final-only execution child, the original Task owner uses
`cat_cafe_development_return(action: "register")` before waiting: bind its exact Task/revision, approved
execution thread, its human `sourceActionRef` backed by admission or a typed continuation receipt,
`expectedSignal: "terminal_report"`, and an explicit
bounded `slaUntil`. This internal return budget is not a business deadline. The child uses `cat_cafe_read_development_return` to find
only its reporting coordinates; it does not read, move or duplicate the original Task. At actual terminal
delivery, persist one final message with real artifact/validation refs, then `report` that message through
the registration. The registered connection delivers the result to the original owner; do not add a
second courtesy cross-post for the same result. An ordinary cross-post without a registration is not B3.
After a return or timeout wake, the original owner rereads the Task/current facts and performs the next
authorized action or registers a justified successor. A timeout that only restates status is not continuation.
One owner/Task has one active return. For another justified wait, pass its latest eligible terminal
`predecessorRegistrationId`; a predecessor cannot fork multiple successors. A newly authorized human
source and approved execution may replace the old source/child on that successor, while the owner/Task
stays the same. Do not omit the predecessor or fabricate a Task mutation to obtain another registration ID.
`read_development_return` without an ID also lets the original owner recover its registrations after context loss.
Normal Task updates/resume preserve the return. The wake records registration and delivery-claim revisions;
the owner still reads current facts before acting. `retired` means that registration cannot continue:
preserve the material and read its disposition; never revive it or treat it as delivery. Invalidated authority
leaves a readable notice in the original accessible thread without starting revoked work. A failed delivery
may use the exact predecessor only after the original owner verifies authority and a justified new wait.
`retirement_pending` means that invalidation notice is still being persisted; it is not permission for a successor.

### Explicit entrustment

Examples: “帮我接住”, “这件事你来跟”, or a direct request to own and finish an outcome.

Call cat_cafe_admit_entrusted_work immediately with:

- basis: explicit_entrustment;
- the exact source message ref;
- a stable idempotency key derived from that source ref;
- the intended outcome;
- a closure condition and expected signal;
- only source-backed time and Artifact refs.

When the source states an unambiguous deadline or review time, resolve it against the authenticated
invocation date/time and pass it in the top-level canonical `time.businessDeadline` or `time.reviewBy`
field with `sourceRef: message:<sourceMessageId>`. `admission.timeHints` may preserve the verbatim
wording, but it never becomes Task time and never makes the item appear in Schedule. If the time cannot
be resolved without changing the commitment, return `needs_clarification` instead of silently dropping
the time.

Do not show an offer after explicit entrustment. Return the compact typed receipt or the exact
needs_clarification reason.

### Registered authorized source

Call cat_cafe_admit_entrusted_work with basis: authorized_source only when the supplied grant
coordinates are registered, current, and cover this exact source scope. A readable connector or calendar
is not authorization. Unknown, stale, revoked, or mismatched grants downgrade to the implicit branch or
safe abstention.

### Implicit future obligation

Offer only when the source plausibly names a future deliverable, follow-up commitment, or time-bound
obligation and the human has not explicitly delegated it. Call cat_cafe_offer_custody once with the
exact source message id and the narrowest matching reason code. Its result is the source truth:

- pending means the original message now owns one accept/decline choice;
- any terminal disposition means do not prompt again;
- conflict or stale-source means reread; never mint a second candidate.

A pending offer is not held work. Do not call it a Task, show it in Schedule, or imply that Needs Me owns
it.

### Venting, brainstorming, or casual mention

Make no custody tool call and write no durable candidate state. Respond to the conversation itself.
Silence here is safe abstention, not a hidden evaluation label.

## Clarification discipline

Ask only when the answer changes outcome, authority, cost, irreversibility, or the closure signal.
Known facts should be looked up; reversible details get a proposed default. Keep clarification on the
same source conversation. Never create a separate reminder, candidate store, or global attention item.

## Completion check

Before claiming custody, verify that the typed result is admitted or resumed and carries the canonical
Task owner ref/revision/receipt. pending and needs_clarification are explicitly not custody.
