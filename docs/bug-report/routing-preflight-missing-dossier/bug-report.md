---
feature_ids: [F293]
topics: [routing, dossier, installation, regression]
doc_kind: note
created: 2026-09-05
---

# Missing installation dossier degrades routing preflight (#1438)

Issue: https://github.com/zts212653/clowder-ai/issues/1438

Accepted scope: https://github.com/zts212653/clowder-ai/issues/1438#issuecomment-5548991778

## Diagnosis

| Field | Evidence / decision |
|---|---|
| Reporter / symptom | A local installation without a dossier repeatedly sees `routing_context_unavailable` before otherwise successful messages. |
| Runtime evidence | Public `f3dba7a1abb9474a88764f21283297cbe9935e2b`; owner snapshot returns `dossier_unavailable`; preflight logs show `resolver_degraded`. Sanitized evidence is in #1438. |
| Root cause | The publication contract leaves dossier creation to each installation, but production composition inherits the profile source's `required` default. |
| Investigation | Trace absent file → profile source → shared resolver → actual dispatch preflight. The existing optional branch also suppresses an existing unreadable/empty dossier, so changing wiring alone would hide real failures. |
| Bounded scope | Make absence optional in production composition; preserve existing-file and model-contract degradation. Keep catalog, signal, preference, and preflight ownership unchanged. |
| Stop conditions | No schema, storage, member mutation, runtime restart, or generic parser redesign is needed. Any newly discovered unrelated failure is reported separately. |
| User outcome | A not-yet-created dossier does not generate a false routing warning. Real dossier failures still warn; unavailable members still reject. |
| Acceptance | Production composition regressions cover repeated sends, preferences, unavailable signals, unreadable and unparseable files, model-contract failure, and later dossier creation. |

Architecture cell: routing-context

Map delta: none. This corrects the existing profile-source composition and preserves all domain ownership boundaries.

## Change and validation

Production composition explicitly selects optional dossier absence. The profile source still degrades when an existing file yields no readable/parseable profiles; model-contract validation is unchanged. No files, member profiles, preferences, or availability signals are synthesized.

- RED, before implementation: composition suite **4 passed / 4 failed**. The four failures reported expected `fresh`, actual `degraded` for missing-dossier scenarios.
- GREEN: API build passed. The composition suite and related catalog, resolver, reducer, read-route, projector, preflight, telemetry, and actual-send suites passed **56 tests / 12 suites**, with no failures or skips.
- Changed-file Biome check and `git diff --check` passed.
- Runtime path smoke used a freshly spawned, in-memory Redis instance over a private Unix socket, actual Redis stores, Fastify route injection, production dispatch preflight, and the existing frontend receipt formatter. It confirmed:
  - missing dossier: HTTP 200, fresh snapshot, absent profiles, allowed send, no visible warning;
  - persisted preference: the configured local member order remains effective;
  - persisted unavailable signal: send rejected, rejection notice visible;
  - existing invalid dossier: global degradation and the diagnostic notice remain visible.
- The smoke Redis process exited cleanly. No live runtime data or service ports were used for branch validation.

Reproduce the focused checks from the repository root:

```sh
env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION CI=1 pnpm install --frozen-lockfile --prefer-offline --prod=false
env -u NODE_ENV pnpm --filter @cat-cafe/api build
env -u NODE_ENV -u REDIS_URL bash packages/api/scripts/with-test-home.sh node --test --test-timeout=60000 packages/api/test/routing-context-*.test.js packages/api/test/routing-preflight-*.test.js packages/api/test/routing-dispatch-preflight.test.js
```

Validation setup notes: the first install inherited production-only dependency selection; explicitly including locked development dependencies resolved it. The stock isolated Redis runner stopped before the smoke with `redis-pid must be a positive integer`; the same behavior checks then passed using the independent Unix-socket instance described above. The lease runner was not changed by this patch.

Risk: behavior medium (routing availability decisions), data low (read-path composition only), security low (no authorization change), contract medium (absence versus failure), irreversibility low (no migration). Independent validation is the repository maintainer's PR review, as offered in the accepted issue comment. Full-workspace gate and live deployment are not claimed.
