---
cell_id: self-sensing-management
title: Self-Sensing / Self-Management
doc_kind: architecture
created: 2026-08-25
summary: F300-owned provider-neutral member/environment projections, member-private and team-shared visibility, evidence-bounded friction hypotheses, and authority-bounded capability-construction / interaction-adaptation policy over existing domain owners.
canonical_features: [F300]
code_anchors: []
doc_anchors:
  - docs/features/F300-self-sensing-home-state-awareness.md
static_scan_hints: [SelfStateProjection, MemberSelfView, MemberPublicProjection, TeamSharedView, EnvironmentStateView, HomeStateDeltaV1, affects_current_obligation, affects_next_side_effect, InteractionEpisode, FrictionHypothesis, GroundedProposal]
cited_by:
  - {feature: F300, date: 2026-08-25, delta: "provider-neutral self/team/environment sensing contract before runtime implementation; all source facts and mutations stay with adjacent owners"}
  - {feature: F300, date: 2026-08-26, delta: "full product loop restored: bounded friction hypothesis, rejectable proposal, capability construction, cross-medium interaction adaptation, immediate use and feedback; Plugin completion gates the first runtime slice without absorbing F300 ownership"}
---

# Self-Sensing / Self-Management

Architecture cell: self-sensing-management

## Canonical Owner

F300 owns the semantics through which an Agent forms a grounded working model of:

- itself: identity, capability and limits, activity and responsibility,
  availability, memory/context, authority and health;
- team-shareable member state: who can collaborate, who is working, what
  obligation or public result is current, and which limitations are safe to
  disclose;
- the shared environment: threads, artifacts, knowledge surfaces, capability
  providers, runtime resources and other team-usable objects.

F300 defines two visibility planes:

1. MemberSelfView, available only to the exact member under the source owners'
   authority rules;
2. TeamSharedView, composed of MemberPublicProjection and EnvironmentStateView.

It also owns the policy that compares those projections with a current
obligation, chooses an authority-bounded management intent, calls the canonical
owner, verifies its receipt/terminal, and then refreshes the projections.

For user-visible growth, F300 owns the coordination semantics that combine a
scoped, explainable friction hypothesis with capability/availability truth,
form a rejectable proposal, carry the user's decision into owner commands, and
verify immediate real use plus feedback. This Interaction Episode is the
product acceptance unit for a user-visible improvement; it is not a replacement
for Member/Environment State, raw interaction history, plugin lifecycle, or a
surface-local state machine.

This cell currently registers architecture truth only. F300 has no runtime code
anchors at origin/main@dd86a802. The absence of code is not permission to
infer state from model introspection, chat summaries, UI visibility, plugin
manifests, or stale success.

## What F300 Unifies

F300 unifies the **projection vocabulary and management loop**, not the domain
stores or mutation APIs. A projection identifies:

- a subject (member, capability, obligation, thread, memory, context, resource);
- a facet (identity, capability, activity, availability, memory_context,
  authority, health);
- visibility (member_private or team_shared);
- canonical source refs, revision, observation time, expiry/invalidators and
  known, unknown, stale, conflicted or unavailable.

The projection may reference an owner-held value. It does not copy raw messages,
memory/context bodies, plugin ledgers, thread records, credentials or runtime
state into an F300 shadow store.

F300 also unifies the product coordination vocabulary:

- friction evidence → bounded hypothesis;
- capability/availability match → grounded, rejectable proposal;
- user decision / existing authority → canonical owner intent;
- owner receipt + interaction projection → immediate real use;
- outcome/friction feedback → retain, edit, dismiss or revert.

It does not own the raw evidence, plugin/runtime mutation, system permission,
surface implementation, or durable user preference stores behind those stages.

## Adjacent Ownership Boundaries

- identity-session, membership and thread owners retain member identity,
  membership, session and collaboration-space lifecycle. F300 creates scoped
  views over those facts; it does not create/delete members or threads.
- Agent Client, TurnExecution/InvocationRecord and execution owners retain exact
  run, Stop, terminal, liveness and recovery truth. F300 may project that a
  member no longer runs an obligation; it never invents a generic cat_stopped
  terminal.
- F233 and structured protocol owners retain custody, obligation, generation,
  predecessor and responsibility disposition. F300 does not infer holder or
  responsibility completion from History presentation.
- memory and context/session owners retain content, access, coverage, retention,
  compaction, retrieval and budget truth. F296 retains presentation, epoch,
  dedupe and provider-minted visibility receipt. F300 exposes only an
  authority-filtered access/coverage/freshness/limit projection.
- plugin owns plugin/package discovery, installation, configuration, grants,
  Host Broker/runtime readiness, audit, mutation commands and receipts. A plugin
  is one capability provider; F300 does not make non-plugin capabilities pass
  through Plugin Manager.
- F223 / hub-action-surface retains capability-surface and verification
  registration. F300 associates those entries with provider-neutral capability
  identities; a rendered surface or registered tool is not readiness truth.
- routing-context, F293, F153 and runtime/quota owners retain route, health,
  availability and resource truth. F300 consumes freshness-aware reads at
  judgment points.
- message/history/delivery owners retain public result and dispatch projections.
  F300 decides whether a state projection is relevant; it does not create a
  second delivery channel or equate persistence with model visibility.
- message/history/surface and task owners retain raw user expressions and
  interaction events. F300 may form a current-collaboration friction hypothesis
  with provenance and uncertainty; it must not rewrite the evidence, monitor
  without scope, or create a cross-context user profile.
- Dynamic Interaction and other surfaces consume F300 projections and episode
  semantics. They own medium-specific UI/CLI/voice/background expression, not
  capability, authority, owner receipts, episode truth or long-term preference
  decisions. An Interaction Episode is not the canonical self-state object, but
  it is the required experience acceptance unit when F300 claims a user-visible
  improvement.
- All authority owners retain installation, configuration, permission, thread,
  memory, runtime and external-side-effect mutations. F300 routes intents and
  consumes receipts; it gains no universal write authority.

## Durable Invariants

1. Every projection names a canonical source, subject, facet, visibility,
   revision, observation time, freshness/invalidator and scope. Unknown, stale,
   conflicted and unavailable remain first-class.
2. member_private facts never enter team_shared merely because they are useful.
   Sharing requires an owner-approved public projection and receiver authority.
3. team_shared means queryable/subscribable within team scope, not broadcast
   into every Agent prompt. Relevance and context budget still apply.
4. An action request, its canonical receipt/terminal and a derived state
   projection are distinct. F300 cannot manufacture the latter to compensate
   for a missing owner result.
5. A Stop/cancel projection is scoped to the exact run or obligation. It cannot
   mark a member permanently unavailable or contaminate a newer run.
6. Capability identity is provider-neutral. Builtin/member-native,
   memory/context, thread/workspace, plugin, limb/tool, remote and composite
   providers are peers; plugin lifecycle is not capability truth for all of
   them.
7. Provisioning, configuration, authority, readiness, applicability,
   effectiveness and visibility stay separate. No enabled boolean, UI,
   manifest, registration or prior success may collapse them.
8. Routine recovery, rerouting, degradation or safe stop may proceed without a
   new confirmation only inside an existing policy/scope/budget envelope. New
   authority, wider data/effect scope, irreversible action, durable preference
   or value choice requires explicit user decision.
9. No mutation-dependent projection advances without the canonical owner's
   receipt/terminal. F300 caches references and policy state only; it does not
   become a second writer.
10. Memory/context awareness never authorizes storage of chain-of-thought,
    credentials, unbounded raw context or another owner's private contents.
11. A friction hypothesis is limited to explainable evidence from the current
    authorized collaboration. It never implies health, personality or durable
    intent, and never grants permission to change capability or interaction.
12. A user-visible improvement is not effective at proposal, install, ready or
    render time. It requires an immediate real action plus outcome/friction
    feedback, with retain/edit/disable/revert paths.
13. Capability construction and interaction stabilization are separate user
    decisions. A one-time trial cannot silently become a default medium,
    persistent entrance, notification policy or other durable habit.

## Use This When

- Adding or changing SelfStateProjection, MemberSelfView,
  MemberPublicProjection, TeamSharedView or EnvironmentStateView.
- Making an Agent answer “what can I do, what am I doing, what did I do, what
  do I remember, what is missing, and what does the team environment offer?”
- Projecting a member's public activity/availability after exact execution,
  Stop, terminal, restart or responsibility changes.
- Reflecting thread creation, capability activation, plugin removal,
  memory/context degradation or shared-resource changes into Agent judgment.
- Deciding whether the Agent may manage a state within existing authority or
  must form a rejectable proposal.
- Turning current-collaboration friction evidence into a grounded capability
  proposal, coordinating an approved change across canonical owners, or judging
  whether immediate real use proved the improvement.
- Adding interaction birth-certificate, attention, recall, trial, retention or
  rollback semantics that must stay consistent across UI, CLI, voice and
  background capabilities.

## Extend By

- Add typed read adapters over canonical owner APIs. Do not enumerate UI or parse
  prompt prose to discover household state.
- Keep member-private and team-shared schemas explicit; test every new facet for
  disclosure and authority boundaries.
- Carry source refs, revision, freshness, uncertainty and invalidators through
  projection delivery and cache invalidation.
- Validate the abstraction with heterogeneous slices: exact Agent Stop, thread
  lifecycle, plugin/provider change and memory/context change.
- After the Plugin kickoff contract is complete, start with one plugin-backed
  end-to-end episode that reaches immediate real use and feedback; extract
  generalized projections and cross-medium policy from that evidence instead
  of building a universal runtime first.
- Use owner command + receipt for management, then re-read the actual state
  rather than treating command acceptance as completion.
- Update code_anchors, consumer evidence and claim guards in the same change
  that lands each runtime phase.

## Do NOT Unify With

- Do not turn F300 into a household state database, second Plugin Manager,
  second memory/context store, thread registry, route store, delivery ledger,
  permission center, runtime supervisor, telemetry platform or universal
  mutation controller.
- Do not expose member-private memory/context bodies, credentials, internal
  reasoning, unpublished drafts or unrelated user data through team state.
- Do not model shared state as all-member prompt broadcast.
- Do not infer readiness from installation, availability from a previous call,
  responsibility completion from a public bubble, or capability from catalog
  presence.
- Do not auto-install, auto-authorize, widen scope or perform irreversible or
  external effects because an Agent formed a high-confidence hypothesis.
- Do not infer user health, personality or long-term intent from interaction
  traces, or persist a friction hypothesis as an unbounded user profile.
- Do not require Dynamic UI; conversation, CLI, voice, background and future
  surfaces must consume the same state, authority and episode truth. Conversely,
  do not call a user-visible improvement complete without an Interaction Episode
  that reaches immediate real use and feedback.

## Static Scan Hints

Watch for SelfStateProjection, MemberSelfView, MemberPublicProjection,
TeamSharedView, EnvironmentStateView, HomeStateDeltaV1,
affects_current_obligation, affects_next_side_effect, InteractionEpisode,
FrictionHypothesis, GroundedProposal, or any new store that combines identity,
execution, custody, memory/context, plugin, thread, delivery, authority,
interaction evidence, episode or surface truth. New runtime anchors require an
ownership-map update and a claim guard proving that adjacent canonical owners
were read rather than copied.
