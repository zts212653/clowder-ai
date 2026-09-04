---
name: custody-recognition
tips_exempt: "F310 Phase B soft-entry 仍在 pre-merge review；待本次自然语言触发合入并完成 source-linked Alpha dogfood 后，再从已验证的稳定用户入口贡献 capability tip。"
description: "Use when a source may entrust work. Not for casual mentions, terminal offers, generic planning, or Schedule/Needs Me. Output: abstain, admit, offer, or retry."
triggers:
  - "帮我接住"
  - "帮我跟踪"
  - "之后要做"
  - "别忘了"
  - "custody offer"
  - "needs_clarification"
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
