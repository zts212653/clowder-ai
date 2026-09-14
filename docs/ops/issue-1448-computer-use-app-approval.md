---
feature_ids: [F306]
topics: [codex, computer-use, runtime-interaction, authorization]
doc_kind: implementation-note
created: 2026-09-14
tips_exempt: "Repairs the existing runtime-interaction card; does not introduce a new capability or configuration path."
---

# Computer Use app approval persistence (#1448)

## Intent and boundary

[Issue #1448](https://github.com/zts212653/clowder-ai/issues/1448) records a loss of
native Computer Use app approval persistence at the MCP elicitation adapter.
The provider offers `session` and/or `always`; the host previously exposed only
one-time `accept`, `decline`, and `cancel`, and omitted response `_meta.persist`.

This patch transports an explicit user decision. It does **not** auto-approve
tools, persist a second permission store, change `approvalsReviewer`, or claim
to fix Chrome extension **Allow for all sites** behavior. App permissions and
browser website permissions are different scopes.

## Contract

Only form elicitation from `cua_repl` with the recognized metadata shape is
eligible: `codex_approval_kind: mcp_tool_call`, `connector_id: computer-use`,
a nonblank `tool_name`, `tool_params.app`, and a `persist` array containing only
`session` / `always`. Unknown or malformed metadata leaves ordinary form behavior
intact, with no persistence choices. URL elicitation remains unchanged.

| User choice | Offered scope required | Provider response |
|---|---|---|
| Submit | none | `action: accept`, supplied form content; no `_meta.persist` |
| Allow this app for this session | `session` | `action: accept`, `_meta.persist: session` |
| Always allow this app | `always` | `action: accept`, `_meta.persist: always` |
| Decline / Cancel | none | `action: decline/cancel`; no content or persistence |

Duplicate offered scopes produce one button each. A forged or unoffered
persistence decision fails closed. Existing canonical-card, authenticated owner,
active waiter, host epoch, and single-settlement checks remain authoritative.
The provider, not this adapter, owns the duration, storage, and reuse of permission.

## Architecture and consumer census

- Architecture cell: `identity-session`, existing runtime-interaction identity boundary.
- Map delta: none.
- Why: preserves a provider-specific field through the existing port and canonical
  card; adds no lifecycle writer, authority source, or parallel approval surface.
- Canonical source: `CodexRuntimeInteractionSchema` validates the metadata;
  `CodexRuntimeInteractionAdapter` binds offered choices and maps the response.
- Consumers: `CodexAgentService` calls the adapter; `RuntimeInteractionService`
  validates and settles the owner/card-bound response; `RuntimeInteractionCard`
  and `RuntimeInteractionElicitationForm` render decisions by `outcome` and submit
  the selected ID; `runtime-interaction-routes` authenticates that submission.
- Shared schema and store layout are unchanged. The permission metadata is not
  copied wholesale into the user response or used as authorization by itself.

## Regression evidence and reproduction

Before the production fix, the offered-choice regression fails: the card contains
`accept/decline/cancel` but lacks `acceptForSession/acceptAlways`.

Run from a development checkout after installing the frozen lockfile and building
the shared package:

```sh
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api test:runtime-interaction
NODE_ENV=test pnpm --filter @cat-cafe/web exec vitest run src/components/rich/__tests__/RuntimeInteractionElicitationForm.test.tsx
```

| Claim | Regression | Red condition |
|---|---|---|
| Choice survives round-trip | `codex-computer-use-approval.test.ts` | Missing button or missing/wrong `_meta.persist` |
| No scope invention / automatic approval | Same suite | Unoffered scope accepted, malformed metadata classified, or response settles before user input |
| Canonical authorization remains enforced | Same suite, HTTP route + real service + in-memory store | Wrong owner/card, unoffered response, or replay is accepted |
| Existing UI submits persistent choices | `RuntimeInteractionElicitationForm.test.tsx` | Render triggers mutation, or click loses selected ID / `{}` content |

These tests use provider request fixtures, an isolated in-memory interaction store,
and UI HTTP mocks. They prove adapter/service/UI contracts, **not** real provider
permission reuse or production activation.

On public base `c0cf29f`, the API suite passes 45/45 and this UI suite passes 7/7.
The standard web test wrapper fails before starting Vitest because its
`browser-test-resource-lease.mjs` imports an unexported
`scripts/lib/process-resource-lease.mjs`. The direct command above runs only the
same unit tests (no browser processes); it is not a claim that the wrapper or
full gate passed. This patch does not alter the unrelated resource-admission code.

### Full-gate attempt (2026-09-14)

Candidate `60c5d4029` on public base `c0cf29f` was tested with
`pnpm gate --no-rebase --risk security`. Recursive build and all-package
`tsc --noEmit` passed. The public test stage exited 1: 23,359 tests reported,
22,560 passed, 650 failed, 29 cancelled, 120 skipped. Later lint/check stages
were not reached; this is **not** a green gate.

The first install used `--ignore-scripts`, leaving the local `better-sqlite3`
native binding unbuilt; the gate's subsequent frozen install did not repair it.
That is a local preparation error, not evidence of a SQLite implementation defect.
`pnpm --filter @cat-cafe/api rebuild better-sqlite3` subsequently succeeded, as
did an in-memory SQL probe. A bounded rerun of `world/world-store`,
`callback-hold-ball-wakewhen`, and `collective-connector-routes` reported 55/56
passing. The remaining Collective route test returns `ROUTE_THREAD_UNAVAILABLE`:
its unchanged fixture defaults `createdBy` to `owner_1`, while the imported
request headers default to `owner-user` when no owner environment override exists.
Those fixture/route files are identical to the public base and are not changed here.

The original failed gate is retained; the 55/56 diagnosis is not a full rerun or
a replacement verdict. Together with the missing web-wrapper dependency and
native acceptance below, this keeps the contribution a **Draft**, not merge-ready.

## Native acceptance still required

In a separately authorized isolated native Computer Use host, record the exact
request metadata, choose an offered scope, and confirm the response metadata at
the provider boundary. Repeat access to the same app within the promised scope;
verify an unapproved app still prompts and decline/cancel do not create grants.
Session reuse and cross-session `always` reuse must be reported separately.

Do not modify the running user's permission configuration to manufacture this
evidence. The PR is an adapter repair candidate until independent review and
native acceptance establish the remaining behavior; browser-extension repeats
need their own captured request evidence.
