# Dot plugin migration: compatibility and validation

This describes the paired migration candidate in [Host #1923](https://github.com/zts212653/clowder-ai/pull/1923) and [plugins #209](https://github.com/zts212653/clowder-ai-plugins/pull/209). Public scope discussion is [#1932](https://github.com/zts212653/clowder-ai/issues/1932); an open discussion is not acceptance or release approval.

## Product boundary

The Host owns installation identity, ordinary addressed routing, visibility, queue admission, durable result association and bounded plugin capabilities. Dot owns external credentials, endpoints, pairing, subscription, verification and recovery. A transport receipt acknowledges delivery; a source-bound result reports completion separately.

Existing shared `/mcp` compatibility is limited to the same owner, original installation lineage and originally approved tool/event surface. A same-instance package update may recover that unchanged approved surface. Expanded surfaces, replacement installations, revoked authority and stale requests do not acquire permission through migration. No general shared authorization or new Host credential issuer is introduced.

## Review cuts

The product-code reference cut is Host `1b8f0c8268b79cbaba96ee58cf1d9e4360a1b46c` against public base `50e5695607a42d5bdbe6e95703e83b038287f290`, paired with plugin `4e2dc4e50b02954a52de982d28c9907bbef18361`. Later test/document cleanup does not change these product trees or the alpha.51 archive.

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
| Paired Host / Dot alpha.51, SDK candidate.12 | Current addressed or subscription delivery | Fixed delivery entrypoint; actual source and instance validation; only addressed results settle a carrier |
| Current Dot consumer | Anonymized retained ordinary dispatches from earlier plugin installations | Read after restart, retained completed reply, no second send, stale-source rejection; three cases in `historical-replay.test.mjs` |
| Current Host compatibility adapter | Original opaque credential, dispatch/image records and original PNG bytes | Owner-checked idempotent import; same-instance legacy connection; no key resurrection after replacement installation |
| Superagent SDK `0.3.0-beta.2-candidate.11` / current contract | Retained pre-`reason` inbox rows | Inspect/retry/route old rows; live ingress still rejects a missing or invalid reason |
| Existing approved shared connection / current Host | Same owner, lineage and unchanged approved surface | Existing route remains usable; revoked, replaced or expanded authority is rejected |
| Older Host without this capability set / alpha.51 | New `call`, result and migration boundaries | Not a supported pairing. Keep the original installation before cutover, or return to the paired Host without deleting migrated state |

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

The original-image and frozen-package checks use the exact alpha.51 archive, SHA-256 `6214d9b5717900bde17691ff255d148df90423b46fe7820476f6bc1ce3c4283e`. Tests and developer-guide changes do not alter its runtime/assets/manifest/README closure.

## Historical use evidence and limits

A read-only inspection of retained worktree request and message records linked seven complete receive/read/reply chains: three ordinary addressed conversations and four connection checks. Replies reference their exact source in the same thread. One earlier connection-check attempt remained incomplete. Private bodies, credentials, endpoints, identities and original database/log records are not published.

The retained installation history ends with alpha.38. This is real-use evidence for earlier installed revisions, not a final alpha.51 or final-source observation certificate. Public anonymous fixtures substitute identities, content, revisions and digests while retaining record shape and event ordering; fixture replay is reported separately from real external use. Elapsed calendar time alone does not demonstrate a restart, mixed-version read or rollback.
