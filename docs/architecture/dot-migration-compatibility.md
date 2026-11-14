# Dot plugin migration: compatibility and validation

This describes the paired migration candidate in [Host #1923](https://github.com/zts212653/clowder-ai/pull/1923) and [plugins #209](https://github.com/zts212653/clowder-ai-plugins/pull/209). The [accepted scope in #1932](https://github.com/zts212653/clowder-ai/issues/1932#issuecomment-6760968355) defines ownership, legacy compatibility and off-mode boundaries. Scope acceptance does not approve the implementation, merge or release.

## Product boundary

The Host owns installation identity, ordinary addressed routing, visibility, queue admission, durable result association and bounded plugin capabilities. Dot owns external credentials, endpoints, pairing, subscription, verification and recovery. A transport receipt acknowledges delivery; a source-bound result reports completion separately.

Existing shared `/mcp` compatibility is limited to the same owner, original installation lineage and originally approved tool/event surface. A same-instance package update may recover that unchanged approved surface. Expanded surfaces, replacement installations, revoked authority and stale requests do not acquire permission through migration. No general shared authorization or new Host credential issuer is introduced.

A completed import audit records history, not current permission. Legacy adoption re-reads the original source and key registry after importer/media waits and at the credential/shared binding commit. Enable also revalidates an already imported credential. Revocation retires only the matching old bearer; retained history and independently replaced credentials are preserved.

## Review cuts

The original integration reference cut is Host `1b8f0c8268b79cbaba96ee58cf1d9e4360a1b46c` against public base `50e5695607a42d5bdbe6e95703e83b038287f290`, paired with plugin `4e2dc4e50b02954a52de982d28c9907bbef18361`. Subsequent Host revisions synchronize the upstream base and correct legacy authorization revalidation. Read the PR's current exact HEAD for those changes; original-cut test results do not certify new authorization checks. The subsequent alpha.52 candidate simplifies early reply association and gates initial subscription consumption until runtime initialization completes.

The following are bounded review units over that integration cut. They are not claimed to be four independently deployable intermediate commits.

| Unit | Source boundary | Verification boundary |
| --- | --- | --- |
| Representation / contract | `packages/shared/src/target-response.ts`, messaging result types, plugin-contract and SDK `PluginDeliveryInput` / response types | Optional persisted fields; addressed/subscription distinction; receipt versus result; old retained inbox normalization |
| Historical import | `packages/api/src/domains/plugin/migration/`, plugin `migration.ts` and storage schemas | Owner/instance validation, original bytes retained, exact import receipts, revoked authority and replacement-install rejection |
| Consumers | Messaging `target-response/`, `SendService`, pending media publication, shared compatibility service, web `target-response-projection.ts` | Source/result association, delayed publication, terminal monotonicity, old/new record consumption and history refresh |
| Activation / off-mode | Carrier router and runtime composition; plugin entrypoint, connection and automatic verification | Registration versus runtime-ready, stop/restart, subscription cursor recovery, disabled ingress, no duplicate replies |

Each cut can be inspected with `git diff 50e5695607a42d5bdbe6e95703e83b038287f290 1b8f0c8268b79cbaba96ee58cf1d9e4360a1b46c -- <paths>`. Integration behavior and cross-cut dependencies still require the paired tests below; path partitioning is not a rollback certificate.

## Supported combinations

| Host / consumer | Data or plugin input | Supported result |
| --- | --- | --- |
| Paired Host / Dot alpha.52, SDK candidate.12 | Current addressed or subscription delivery | Fixed delivery entrypoint; actual source and instance validation; only addressed results settle a carrier |
| Current Dot consumer | Anonymized retained ordinary dispatches from earlier plugin installations | Read after restart, retained completed reply, no second send, stale-source rejection; three cases in `historical-replay.test.mjs` |
| Current Host compatibility adapter | Original opaque credential, dispatch/image records and original PNG bytes | Owner-checked idempotent import; same-instance legacy connection; no key resurrection after replacement installation |
| Superagent SDK `0.3.0-beta.2-candidate.11` / current contract | Retained pre-`reason` inbox rows | Inspect/retry/route old rows; live ingress still rejects a missing or invalid reason |
| Existing approved shared connection / current Host | Same owner, lineage and unchanged approved surface | Existing route remains usable; revoked, replaced or expanded authority is rejected |
| Older Host without this capability set / alpha.52 | New `call`, result and migration boundaries | Not a supported pairing. Keep the original installation before cutover, or return to the paired Host without deleting migrated state |

This matrix does not claim that an old Host binary can consume every new message, image or target-result state written after activation.

## Off-mode and rollback

Before activation, keep the plugin disabled if validation fails. Migration records and original source files remain retained; no callback or accepted work should be manufactured to make activation appear successful. Cancellation of activation is distinct from restoring an earlier application binary and data snapshot.

After activation, disable the plugin to stop new ingress. Retain the existing Host message/media history, plugin state, import receipts and delivery cursors. The paired Host remains the reader for new messages, original images and result metadata. Resume on a compatible paired Host/plugin installation; do not feed migrated live stores to an unvalidated older binary or delete them to force setup again.

Unacknowledged subscription work resumes from its existing cursor after real runtime readiness. Accepted external work with an unknown outcome is not blindly re-sent. Dot retains event/result identities, and completed replies remain idempotent across stop/restart. Verification retry reuses its original event/thread/nonce and checks current authority. Off-mode is not a credential-revocation bypass, and reinstall does not rebind retained history to a new instance.

The package integration test checks original connection, dispatch, image metadata and PNG bytes remain identical through import, disable and reinstall; disabled legacy ingress returns 409; the original pre-migration record remains readable. This proves source retention and off-mode boundaries, not a full downgrade of the live Host binary.

## Reproducible checks

From the Host checkout, build with the normal package command, then run isolated compatibility tests:

```sh
pnpm --filter @cat-cafe/api build
cd packages/api
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import tsx --import ./test/helpers/setup-cat-registry.js \
  --test --test-concurrency=1 \
  test/f202-dot-legacy-*.test.ts test/f202-dot-migration-*.test.ts \
  test/f202-shared-extension-service.test.js test/f202-shared-extension-route.test.js
```

From the plugin checkout:

```sh
pnpm --filter @clowder-ai/chatgpt-dot test
pnpm --filter @clowder-ai/superagent test
pnpm --filter @clowder-ai/superagent typecheck
```

The current original-image and frozen-package checks use alpha.52, SHA-256 `4c31b455e4243bf93d7d8d6edddd28a68f62144fa6ecfae75870545847bef0c9`. Its dependency closure is retained from the previously verified alpha.51; only Dot runtime, version and guides change.

## Historical use evidence and limits

A read-only inspection of retained worktree request and message records linked seven complete receive/read/reply chains: three ordinary addressed conversations and four connection checks. Replies reference their exact source in the same thread. One earlier connection-check attempt remained incomplete. Private bodies, credentials, endpoints, identities and original database/log records are not published.

The retained installation history ends with alpha.38. This is real-use evidence for earlier installed revisions, not a final alpha.51 or final-source observation certificate. Public anonymous fixtures substitute identities, content, revisions and digests while retaining record shape and event ordering; fixture replay is reported separately from real external use. Elapsed calendar time alone does not demonstrate a restart, mixed-version read or rollback.

## Reply association and initialization

Dot subscribes to a thread once before sending its question. If a reply arrives before its local send receipt is saved, Dot verifies the parent with the existing Host own-send lookup (`messaging.findSent`), including the thread and admitted recipient. No receipt-pending exception or second subscription is used to force a replay. This requires the paired Host’s own-send lookup.

The Host records subscription intent during initialization without invoking an unavailable receiver. Successful initialization begins consuming the existing pending cursor; failed/canceled initialization removes its live registrations. Re-registration alone does not schedule retries, and a repeated readiness callback does not restart delivery. Addressed A2A task failure/terminal handling is unchanged. The pre-existing subscription delivery read/ack guarantee remains separate from A2A task execution.
