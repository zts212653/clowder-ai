---
feature_ids: [F202]
doc_kind: plan
topics: [plugin-framework, owner-authority, source-cas]
architecture-cell: plugin
tips_exempt: "Internal Host/SDK pairing under C1. No new user-facing workflow or MCP command; package installation and its existing UI journey remain a separate acceptance step."
---

# F202 C1 neutral deployment and frustration source ports

This implements the existing operator043 / resume002 C1 migration scope and accepted neutral334
pairing, not a new business service. Original scope: `docs/plans/2026-09-21-f202-c1-contract.md`.
Detailed bilateral contract: `/Users/lang/workspace/github-lab/f202-handoff/w3-github/host-neutral-ports-798a7caf.md`.
Public contract beta.35 / SDK beta.19 were independently approved at plugin source b47b0b773c2b79fc4c45c0b29141de7c02158c17.

Architecture cell: plugin + cats/stores. Map delta: extend the existing module Host surface and
FrustrationIssueStore port; no second source store, business draft reader, publication handler or
lease authority. Why: the moved package needs deployment policy and owner-held source navigation,
which thread membership and an unconditional source setter cannot supply safely.

## Contract and authority

- `deployment.getCatalog` requires deployment.read. It returns only roster family/available/lead,
  defaultCatId and four ReviewPolicy booleans. Live background reads are allowed, with exact module
  activation, package, grant and lifecycle checks before/after projection.
- `frustration.getSource` requires frustration.read and a genuine Host owner HTTP or native context.
  Projection exposes only the beta.35 whitelist and message count, never bodies/logs/evaluation.
  Missing service throws unavailable; only a truly absent record returns null.
- `frustration.linkDraft` requires read and link grants. Host verifies source owner and thread owner;
  native calls additionally match the invocation thread. Inputs cannot supply principal/time or
  replacement authority. Owner GET cannot write. Different-link replacement requires an exact
  expected link and a current owner HTTP write request; native callers cannot replace one.
- Revision hashes material public fields, excluding navigation and visibility. Store CAS separately
  compares the full internal material snapshot, including private history, without exporting it.
  Same-link replay still checks identity, confirmed status and revision. Existing source history and
  persistent TTL are preserved. Memory and Redis CAS expose linked/already_linked/missing/
  not_confirmed/stale_source/conflict; no blind HSET fallback.
- The inventory serial write guard encloses permission checks and the store CAS. A separate Host-only
  callback rechecks invocation/request lifetime after store IO and immediately before atomic write.
  Once a Redis command has been submitted, loss of the HTTP reply does not roll it back; the package
  retries the same durable draft/link. This is not a distributed transaction between plugin and Host.
- Owner HTTP authority is private ALS, bound to the exact activation and request lifetime. Timeout,
  disconnect and completion expire it; native and private verifier dispatch clear owner authority.

## Evidence and remaining acceptance

The source CAS, HTTP context and actual module ports each have preserved missing-behavior RED logs.
Latest source-equivalent managed run:
`/Users/lang/workspace/github-lab/f202-acceptance/neutral-host-6b7f82dd/green-r2/`.
Shared/API build and diff passed; neutral/owner/HTTP 45, custody 30, native 13, memory source 27,
isolated Redis 17: 132 passed, zero failed/skipped. Includes real module → authenticated forwarding →
Redis source link/replay and independent-client content/link races. Isolated Redis port 6479 exited;
lease registry empty. Exit-listener warnings remain recorded in neutral/custody logs.

Previous green attempt had one fixture failure: missing feature grants removed the fixture's MCP
transport token before its port assertion. The negative probe now has its own zero-capability feature;
production grants remain denied and the real Host refusal is asserted. The two cancellation cases
failed on old compiled stores before the first build, then passed on the new implementation.

This is a reviewable Host infrastructure checkpoint. It does not claim the actual alpha.16 archive
installed, browser acceptance, positive publisher association, fork soak or complete C1. The existing
custody pairing requires honest insufficient when publisher association is unavailable. The original
Host owner retains isolated package installation and whole migration acceptance.
