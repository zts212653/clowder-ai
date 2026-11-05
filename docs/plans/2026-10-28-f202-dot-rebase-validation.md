---
feature_ids: [F202]
doc_kind: evidence
created: 2026-10-28
topics: [dot, rebase, validation, acceptance]
---

# F202 Dot: rebased candidate validation

This evidence supplements the historical integration plan in
`2026-10-20-f202-dot-migration-c.md`. Its older package hashes and protocol
descriptions are not the current candidate contract.

## 2026-10-30 prepare-connection package correction

Operator message `0001793341504061-003855-bd82b388` reports
`Action failed: [` after choosing Prepare connection. The real installed-package
Host route reproduced precisely HTTP 502 with that body. The source-level
regression independently exposed the underlying Zod `unrecognized_keys` error
for `input` and `operationState`.

The generic Host operation contract sends an envelope containing configuration
input and the current operation cursor. Dot incorrectly parsed that envelope
as `{ reconnect?: boolean }`. The correction is in the plugin handler: prepare
ignores operation metadata and idempotently prepares/reuses the pairing. Only
the separately declared, owner-confirmed reconnect action rotates it. It does
not forward a caller-provided `reconnect` flag from either envelope shape.
The stale unit test that rotated through begin now uses the reconnect action.

Plugin source: `07b2add0cb3a0c572fd01d1a86405ad4fac67190` in
`/Users/lang/workspace/github/clowder-ai-plugins-dot-migration-b`.
Dot release: **0.2.0-alpha.3**. The canonical
`scripts/pack-publish-artifact.mjs` produced the complete archive, now frozen at
`packages/api/src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.3/package.tgz`.
Its SHA256 is
`16547d181d6f465166ccfe275998f9a4900751779610b6e6fd61eeb39c7afd3d`.
All **1,089 dependency files are byte-identical** to alpha.2. Changed archive
members are only Dot's entrypoint JavaScript/maps and the package/manifest
version metadata. Host production logic is unchanged; the Host delta selects
the new frozen package and updates its expected version/digest tests.

Plugin build/typecheck and the full **98-test** suite pass. The offline packed
consumer was rerun after adding the real Host envelope to both independently
materialized installations; it passes. This covers actual packaged prepare,
enable/disable/restart and retained pairing. The new source regression also
proves begin cannot be used to force a reconnect.

The Host package integration now exercises the actual authenticated HTTP
`/api/plugins/:pluginId/actions/connection/begin` route after migration/enable,
with pending configuration and then a persisted operation cursor. Both calls
must return 200, preserve the same pairing attempt and expose the Host-owned
endpoint/token. It reproduced the operator error with alpha.2 and passes with
alpha.3. Existing reinstall/old credential assertions remain in the same test.

Because the operator is using the feature API/Web artifacts, the Host checks
use a disposable package fixture under this worktree's ignored `.cat-cafe`.
It copies the same source/tests and necessary build inputs, transpiles the
unchanged manifest producer as ESM and generates bundled outputs only inside
the fixture. It asserts the real API build stamp/producer and Web build
identities remain byte-identical. This is not another Git checkout or an
acceptance server, and no operator connection is invoked. The fixture bootstrap
failures (missing template/exporter and CJS producer) are retained in their
individual fixture logs; they are not product regressions or green evidence.
The probe entry is `/tmp/f202-alpha3-host-fixture.mjs`.

Final fixture run: **35/35 passed**, no failures or skips (51 seconds), in
`.cat-cafe/f202-alpha3-host-fixture-yBBq0q/`; `result.json` and
`regression.log` retain the terminal. This covers the real packaged owner
operation/migration/reinstall journey, generic owner-operation confirmation,
source/dist frozen archive builds, output closure and installed icons. Live
API/Web artifact preservation assertions passed. Changed-file Biome/error
and whitespace checks also pass.

Independent package review, operator installation of alpha.3 and real-account
pairing/roundtrip remain required. No new full-gate, experience acceptance,
fork soak or merge is claimed.

## 2026-10-29 experience update

The canonical `pnpm gate` at `4215128fbdf8877d257d545f6cf4acca740f8318`
passed (exit 0, 4219 seconds), managed job
`managed-job-c04e8888e5b9f8b76ad33b41207ac6101f8a0b89`, terminal message
`0001793186836978-001444-7125165c`. Kimi's ninth incremental review approved
that exact candidate. The pending-gate and preview statements below describe
the earlier investigation, not the current experience environment.

The operator subsequently started this feature checkout with `pnpm start:direct`
using its ignored `.env.local`: Web 5182, API 3182, Redis 6382 and checkout-local
`.cat-cafe` data. The installed Dot manifest contains all five `connection`
operations, and the operator's screenshot (message
`0001793258501832-000195-60ef8779`) shows the plugin enabled but no pairing
buttons. This is an experience failure, not an acceptance confirmation.

Root cause: `ActionRenderer` treated an operation with no `next`/`rollback`
edges as a sequenced flow. Dot's leading `status` action rendered no button,
so `begin` and the remaining independent actions were unreachable. Also,
`ActionPanelBody` ignored `render: text` results, including the pairing
instructions returned by `begin`.

The correction displays independent button/status actions as explicit owner
buttons and renders their current text result as escaped text. It reuses the
existing request, confirmation, error and stale-response handling. Status
checks never run on mount. A new action replaces the preceding result;
configuration changes and unmounts discard pending results. No action output
is restored from persisted operation state. No Dot-specific Host branch,
package archive, plugin source, runtime configuration or operator process is
changed.

Red: two new UI regressions failed with missing status/prepare buttons while
the 30 existing renderer cases passed. Green: the operation/confirmation/rows/
refresh regression set passes **88/88** (eight files); web TypeScript
`--noEmit --incremental false`, changed production-file ESLint, Biome/error and
whitespace checks pass. The re-pair confirmation regression verifies cancel
sends nothing and every accepted invocation carries the existing confirmation
marker. The text regression verifies private pairing output is replaced and
late output after a draft change is discarded.

Kimi's tenth non-author review approved UI source commit
`619732c76ce01bc5c927d8342ebbc9c0e1f0bb18` in message
`0001793259061845-000229-6c9d97c1`, independently rerunning all 88 tests.

A headless Chromium probe then bundled the real configuration and confirmation
components at that commit, using the frozen Dot manifest and the existing Host
field-projection implementation. The probe verified all five buttons on mount
without requests, visible prepare/pairing output, reconnect cancellation with
no request, confirmed reconnect with the existing owner marker, replacement of
old pairing output and roundtrip action reachability. It also checked button
bounds at 390px. Pairing responses were synthetic fixture data; this was not a
real cloud-account roundtrip or whole-Host acceptance. Real Tailwind utilities
and the repository's generated vendor stylesheets were used, and both desktop
and mobile captures were inspected.

Probe: `/tmp/f202-dot-ui-browser-619732.mjs`, exit 0.
Evidence: `/var/folders/1z/8dpvll5d2fq7brlf2qk4kkw40000gn/T/f202-dot-ui-619732-2CbgcU/`
(`result.json`, `pairing-desktop.png`, `connection-mobile.png`). Both the live
production `.next/BUILD_ID` and `.next/.build-commit` were verified unchanged.
The probe's temporary HTTP server and browser were closed on completion.

The operator's live production build still predates the correction. Normal
`pnpm start:direct` selects `--prod-web` and, without `--quick`, runs the build
before starting the frontend. Handoff: in the feature instance's own startup
terminal, stop that instance and rerun `pnpm start:direct`, then reload Web 5182
and prepare the connection. Do not overwrite the live production build or
restart the operator's instance from an agent. Real-account pairing, roundtrip
acceptance and fork soak remain unfinished. The successful gate at 4215128f
is historical evidence for that revision, not a full-gate receipt for this UI
correction.

## Frozen runtime sources

- Host runtime source: `fc3740cef6a87715cf52ea0e8a9d7cea9d39d354`, containing
  upstream `b2c9952f27d31480191ff6fd120789405c97238c`.
- Plugin source: `836cec106400a2d827e4b76a060550e9316e2f75`.
- Independent review: Kimi approved the paired sources in thread
  `thread_mvgmbqy65mk8bnox`, message `0001793157891698-004943-1557e2b1`.
- Current contract: optional `call` declares alias/display name; Host delivery
  uses fixed `deliver`; external requests use fixed `handle`. The retained
  credential journey uses generic `/api/plugin-runtime/handle` with Bearer
  authentication. It does not use an `x-dot-credential` route.

## Fresh isolated regression

From the feature worktree's `packages/api` directory:

```sh
node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import tsx --import ./test/helpers/setup-cat-registry.js \
  --test --test-concurrency=1 --test-timeout=60000 \
  test/f202-dot-migration-package-integration.test.ts \
  test/f202-dot-migration-journey.test.ts \
  test/f202-dot-webhook-body-limit.test.ts \
  test/f202-dot-legacy-image-reader.test.ts
```

Result: exit 0; 12 passed, 0 failed, 0 skipped. This covers actual packaged
installation/update, dormant import, enable, old-credential `tools/list`,
disable/uninstall, reinstall into a new instance and another old-credential
`tools/list`. It also checks migration terminal/divergence decisions, retained
image visibility and webhook body limits. The sandbox uses a temporary home
and disables ambient Redis access; no operator data was imported or modified.

These automated fixtures do not establish real-account pairing, successful
browser interaction, operator acceptance or fork soak.

## Canonical gate and directory audit

The canonical managed job
`managed-job-e7cf0a9d0774d1392ff46e8500c308f9c24be0e7` ran `pnpm gate` on
the clean Host candidate. It exited 1 in `check:sources`, before install/build/
tests, because three directory exceptions expired on 2026-10-27. The frozen
origin baseline was `80f0678c`; the candidate also contains the newer upstream
baseline listed above. This failed job is not a full-green receipt.

All three directories and their exception entries have an empty diff between
upstream `b2c9952f27` and Host `fc3740cef6`. A direct-file audit using the same
TypeScript exclusions as the checker found:

| Directory | Files | Boundary retained |
| --- | ---: | --- |
| `packages/api/src/domains/concierge/live` | 26 | Live-call observations, transcripts and native work |
| `packages/api/src/domains/concierge/live/host` | 31 | Host call/return, recovery, history and page actions |
| `packages/api/src/domains/growing` | 33 | Task-owned human-terminal, execution and entrusted-work readers |

The candidate renews only these three exceptions through 2026-10-31, with
current counts and reasons. Owners and tickets remain unchanged. No directory
limit, checker, runtime logic or other exception changes. This preserves a
short reassessment deadline and avoids mixing unrelated authority-boundary
refactoring into paired Dot acceptance. `pnpm check:dir-size` then completed
successfully (255 directories; existing warning-level counts remain visible).
The policy delta requires independent review and a new canonical gate receipt.

The next canonical job,
`managed-job-8a35b6e4911dc465ebfd82e5b75102b8a19f770c`, ran the clean
policy/evidence commit `39f95801793d84c5a92935560a39407964e3fae7`. Source
checks passed. It exited 1 in the dependency checks, before build/tests, on
four Biome errors: comment indentation in `module-plugin-settings.ts`, import
ordering in `runtime-composition.ts`, callback indentation in `routes/cats.ts`,
and ternary formatting in `routes/messages.ts`.

Applying Biome's safe formatter/import-order fixes cleared those four errors.
A TypeScript syntax-tree comparison, ignoring trivia and import declaration
order while preserving the complete import set, confirmed equivalent parsed
syntax in all four files. In particular, the large `cats.ts` line diff is
indentation. No unsafe lint suggestions were applied. The resulting candidate
still requires a canonical full-green receipt and incremental independent review.

Canonical job `managed-job-486dcec5913a3387d727778bff12484a713c4717`
ran clean commit `0209e8c0250a53bc13ba54f19569d011510a30a7`. It reached
Public tests after source/dependency checks and build. The failing Public batch
reported 1033 tests: 1030 passed, 1 failed, 2 skipped. Its sole failure was
`agy-native-compaction.test.js`: the raced-conversation-lease test expected
`session_owner_unavailable` but received `agy_native_compaction_failed`.

The original test passed 9/9 in isolation. Its 100ms compaction deadline also
includes asynchronous preparation before conversation-lease admission. Under
delay, cancellation can win before the busy error is classified. A temporary
diagnostic copied just this existing test and injected 150ms of L0 compiler
latency: with the original 100ms budget it reproduced the exact gate failure;
changing only that budget to 5000ms made the same delayed diagnostic pass.

The checked-in test now uses the same 5000ms budget as its sibling compaction
tests. The held conversation lease, expected owner-unavailable error and
single-CLI-invocation assertion are unchanged; queueing until cancellation
would still fail. No native-service production code changes. Fresh validation:
the original compaction file passes 9/9, and the delayed diagnostic passes 1/1.
The combined compaction/profile-turn/profile-async/profile-event-loop slice
also passes 20/20 under the isolated test-home runner (concurrency 2).
Other native tests with short budgets intentionally test different conditions
and were not changed. The temporary diagnostic is not a new permanent test or
a substitute for rerunning the full gate.

## Fourth canonical gate: stale bundled-build fixtures

Kimi independently approved the three validation-only commits through
`0b195156106e9b4987af823f2abea0ae8cfdefec` (thread message
`0001793172238098-000660-bfe20dd9`) and hosted the next canonical `pnpm gate`.
It exited 1 after 638 seconds. Public tests advanced beyond the repaired
native-compaction chunk, then failed while assembling bundled-build fixtures:
the upstream helper still searched the producer for an inline description
literal and assumed version `0.1.2`. F202's producer instead imports the
`0.2.0-alpha.2` JSON manifest and uses the pinned prebuilt archive. The public
runner's fail-fast chunks explain why this was not visible in the prior run.

The original two selected-producer cases reproduced the literal assertion
failure before edits. The revised fixture copies the actual TS or compiled
producer and injects the temporary description into its JSON input. Its
temporary workspace preserves the native script's `packages/api` dependency
layout so the real Biome formatter resolves correctly.

Generic source-build cases remove exactly one prebuilt definition from the
temporary script copy and use a synthetic SVG; production scripts and archives
remain unchanged. Closure cases use the native `--source` route so source JSON
survives replacement of the generated dist namespace. They retain version
migration, read-only check failures, fresh/incremental byte equality, both
frozen-runtime export layouts and output-link/sibling protections.

Separate source and compiled cases run the unmodified prebuilt script with the
real archive. They verify its pinned SHA256, unchanged output bytes, SHA512,
archive YAML against the raw JSON input, and generated JSON against the Host's
validated projection (which drops retired capabilities). Corrupted input must
fail build and check without changing output; archive and ancestor links are
also rejected. No frozen archive is repacked.

The related F322 offline-icon test independently reproduced its stale `0.1.2`
version assertion. It now expects the frozen migration release; icon identity,
installation, digest rejection and legacy presentation assertions remain.

Fresh isolated validation from `packages/api`:

```sh
node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 \
  test/bundled-plugin-build.test.js test/bundled-plugin-closure.test.js \
  test/bundled-plugin-artifacts.test.js test/f322-bundled-plugin-icons.test.js
```

Result: exit 0; 33 passed, 0 failed, 0 skipped. Changed-file Biome and
`git diff --check` pass. Dot's checked-in SHA256 remains
`4c0de3e7b54dbadce0e96aebe6363ff5966ac392ebd9babec208fe7eec1c44a4`.
This is targeted evidence; a fresh independent review and canonical full gate
for the resulting commit remain required.

## Fifth canonical gate: writer-fixture authority and retired identity

The gate at `1fbffd6ace848fd11966b8a1dc1c5a3ca1907daa` exited 1 after 842
seconds. The bundled chunk passed; a later public chunk had 1733 passes and
eight failures (seven capabilities routes, one cat identity assertion).
Kimi's intermediate experiments and hypotheses are retained in
`2026-10-28-f202-gate-round6-kimi-diagnosis.md`; clone results are diagnostic,
not replacement validation for this feature worktree.

The author reproduced all eight failures in the original feature worktree:
158 tests, 150 passes, eight failures. Direct source inspection identified
`allowsImplicitCapabilityWrites`: an unlabelled linked worktree must not
bootstrap, heal, discover or prune capabilities. The seven old tests expected
these persistent-owner effects without declaring that owner. Their temporary
fixture now declares the test binary's runtime identity, maps all global
writes to a unique temporary workspace and isolates HOME. It restores every
changed environment value after each case. The broken-skill case also uses
an external temporary project so runtime-descendant remapping does not replace
the boundary it is trying to test. Production capability policy is unchanged.

The eighth assertion still included `gpt-dot` among protected built-in cloud
identities. F202 deliberately retires that special identity; its existing
ordinary-member create/rename/delete regression remains. The protection test
now names `gpt-pro` and retains its rejection code, no-write assertion and
allowed null-agentProvider update. No protected identity is added to templates.

Fresh isolated validation in this same worktree:

```sh
node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 \
  test/capabilities-route.test.js test/cats-routes-runtime-crud.test.js \
  test/f324-alpha-capabilities-read.test.js test/startup-cli-config.test.js
```

Result: exit 0; 173 passed, no failures or skips. This includes the original
158 route tests and existing negative tests protecting preview/shared config
from implicit writes. Changed-file Biome at error severity and whitespace
checks pass. The next exact-commit independent review and full gate are pending.

## Sixth canonical gate: remaining writer positive control

The canonical gate at `c7ce9a56a7ae275afaf873405849a8d34d573a1f` exited 1
after 1988 seconds. Public chunks 0 through 10 passed. Chunk 11 contained
1519 tests: 1517 passed, one skipped, one failed. The remaining failure was
`home-state/capability-read-service.test.js`: its snapshot read/no-write control
passed, but the paired Console bootstrap control expected implicit writer
authority from the unlabelled linked checkout. The original positive control
was reproduced in isolation before the change (exit 1, `config_missing`).

The already-reviewed temporary persistent-owner fixture is now shared by the
capabilities-route tests and this positive control. Its body and isolation
policy are unchanged; the binary root is resolved relative to the helper's
location. Both the snapshot's empty fs-write spy and the Console's observed
`capabilities.json` writes remain asserted. No production policy changed.

The failure-mode sweep covered all seven test files directly importing the
capabilities route or startup writer policy: capabilities-route, home-state
capability-read-service, F324 alpha capabilities, native MCP first-run, mock
agent integration, governance health route, and startup CLI config. F324 and
startup already declare positive/negative deployment identities; native
first-run uses explicit fixture roots/environments; mock board and governance
health are reads. Only the missing home-state writer control required adoption.

Fresh validation of these seven files plus cat runtime CRUD, in the original
worktree with isolated test HOME/Redis and the TS loader: exit 0; **228 passed,
no failures or skips**. Changed-file Biome at error severity and whitespace
checks pass. Logs: `/tmp/f202-capability-owner-sweep-red.log` and
`/tmp/f202-capability-owner-sweep-green.log`.

The public runner has 22 fail-fast chunks. Chunks 12 through 21 have not yet
been exercised by the previous full gate. A diagnostic pass of chunks 11–21
will collect all remaining failures before another canonical gate; it does
not replace the final exact-commit gate or experience acceptance.

## Remaining public chunks: completed diagnostic and final fixture alignment

The diagnostic at `fbc864780f628bcefc40d4a18f2e2a85281c8908` completed all
11 remaining chunks (11–21) in 1291 seconds. Ten chunks passed; chunk 16
reported four failures, with no other failing chunks. Per-chunk results and
full logs are retained under
`/var/folders/1z/8dpvll5d2fq7brlf2qk4kkw40000gn/T/f202-public-tail-fbc864780f-DPAbfJ/`.
This diagnostic deliberately collected failures past the first failing chunk;
it did not modify the canonical runner or replace the full gate.

Three failures were stale version assertions in plugin inventory/installer
tests. The consumed archive is the already-frozen `0.3.1-candidate.0`, SHA256
`1e6fc7e3763e4fb8cc60785b325e543bc8ecca67afa7e3a418c4bba0221175b7`.
The pin assertion now verifies that exact artifact. Under the existing semver
policy, `0.3.1-beta.1` is older than the consumed candidate, so both inventory
and installer now positively verify its admission. Their negative boundary
uses `0.3.1-candidate.1` and retains the below-floor/stable-future rejections,
no inventory writes, and quarantine evidence.

The fourth failure was the M0 Host-control fixture omitting the now-required
message delivery `reason`. The adapter now supplies `reason: 'subscription'`
to the unchanged real supervisor/stdio transport. The signed behavior catalog,
12 execution oracles, child process, receipt checks and side-effect checks
remain unchanged. The other direct M0 delivery call sites were checked; this
was its only supervisor-delivery construction. The old pin and out-of-range
beta assumptions were searched across API tests and no other stale matches
remain.

Fresh isolated regression from the original feature worktree:

```sh
node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 \
  test/plugin-host-inventory.test.js test/plugin-official-package-installer.test.js \
  test/plugin-m0d-joint-acceptance.test.js test/plugin-external-runtime-messaging.test.js
```

Result: exit 0; **49 passed, no failures or skips**, including the M0 catalog's
12 real execution paths. Log: `/tmp/f202-contract-integration-green.log`.
Changed-file Biome/error and whitespace checks pass. Production code,
compatibility policy, package archives and runtime configuration are unchanged.
Independent incremental review and a final exact-commit canonical gate remain
pending; previous chunks passing on different commits are not a combined gate.

## Experience environment: not ready

No current candidate acceptance server is running. A managed preview was
registered with launchd, then explicitly stopped before readiness after its
outer `WORKTREE_PORT_OFFSET` was found absent from the child environment.
The launcher forwards only a small environment allowlist. Both the bounded
and documented ordinary launch forms with explicit child
`WORKTREE_PORT_OFFSET=-70` were rejected by the native guard as
`unbounded_managed_preview_operation`.

The intended isolated coordinates are Web 5172, API 3172 and Redis 6328, with
checkout-local `.cat-cafe` persistence. Do not reuse operator ports or data,
edit runtime configuration, or bypass the guard. An accepted launch path must
be established before claiming browser or operator experience acceptance.

## Remaining acceptance

After the new canonical gate and policy review, start the exact candidate in
an accepted isolated environment. Verify Plugin Manager install/enable,
addressed request/reply and attribution, image access, alias changes, disable,
uninstall/reinstall and credential retention. Real-account pairing and reply
must be exercised before requesting the operator's explicit experience
confirmation. Merge into the fork and soak follow that confirmation; upstream
merge readiness is not established by the existing review or targeted tests.
