---
feature_ids: [F266, F273]
topics: [desktop, windows, packaging, startup, eval, release-truth, git]
doc_kind: bug-report
created: 2026-08-06
---

# Packaged API startup must not require Git worktree metadata

## Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The real Windows install of `0.12.0-rc.1105.10` exits during startup before API port `3004` becomes ready. Expected: a packaged runtime without repository metadata starts normally; release-truth claims remain fail-closed when they cannot be verified. Actual: Electron reports “API process exited with code 1”. |
| **2. Evidence** | The operator supplied the installed-client error dialog and Windows logs. `api.2026-08-06.1.log` records `EvalReleaseTruthError(code=commit_unavailable)` from `git rev-parse --verify HEAD^{commit}` because the packaged runtime is not a Git repository. The normal Redis-backed attempt and the `MEMORY_STORE=1` retry fail identically. Redis connected and the preview gateway started first, excluding storage and port contention. Source tracing reaches unconditional `createEvalReleaseTruthResolver({ repoRoot: findMonorepoRoot(process.cwd()) })` during API boot. The standard local-runtime preflight is not applicable to this remote packaged Windows observation; no stale-runtime claim is being made. |
| **3. Root cause** | F266 moved worktree-backed release-truth initialization into the unconditional API startup path. `createEvalReleaseTruthResolver()` eagerly resolves `HEAD`, while a packaged application intentionally contains no `.git`. A capability-specific truth-source outage therefore aborts the entire API instead of failing only the release facts that require that source. |
| **4. Diagnosis strategy** | Preserve the existing Git-backed verifier for repository runtimes, but represent unavailable Git truth as a fail-closed resolver whose release-fact methods return `commit_unavailable`. First add a deterministic no-repository regression at the resolver boundary, then verify lifecycle routes continue rejecting unverifiable release claims without preventing API construction. |
| **5. Timeout strategy** | If the focused resolver test does not reproduce the eager-startup failure, stop and add a packaged-startup wiring fixture rather than weakening Git verification or changing desktop service retry behavior. |
| **6. Early warning** | Fabricating a commit SHA, accepting release claims without ancestry proof, bundling `.git`, catching all API startup errors, or adding another desktop retry would fix the symptom at the wrong boundary. Three failed repair attempts trigger an architecture review. |
| **7. User-visible correction** | The installed application starts normally. In runtimes without Git metadata, only lifecycle commands that require Git release proof report that verified release truth is unavailable; updater, storage, messaging, and other API capabilities remain usable. |
| **8. Acceptance** | RED reproduced the installed failure at the real Git adapter boundary: constructing a resolver against a directory without `.git` threw `commit_unavailable`. GREEN now proves construction succeeds, both release-verification methods remain `commit_unavailable`, malformed input remains `invalid_commit`, and the existing F266 resolver/case/route suites stay green. API TypeScript, repository lint/check/build, exact-head CI, and a replacement Windows install must also pass before delivery. |

## Reporter and reproduction record

- **Reporter:** operator, using the real Windows package.
- **Package:** `0.12.0-rc.1105.10`, built for PR #1227 delivery acceptance.
- **Reproduction:** install and launch the package on Windows; the API exits before port `3004` is ready.
- **Primary logs:** `/Users/lang/repo/os/share/logs/windows/api/api.2026-08-06.1.log` and `/Users/lang/repo/os/share/logs/windows/desktop.log`.
- **Introduced by:** `ffa73bb8fb03aaf42bd86c3b5ea4d497c86bcf0d` (`sync: cat-cafe 55ca5ecb → clowder-ai (#1282)`).

## Repair decision

Keep Git verification fail-closed, but move failure from API construction to the individual release-truth operation. The resolver exposes an unavailable state when it cannot freeze runtime `HEAD`; both release verification methods retain input validation and then reject with `commit_unavailable`. This preserves F266's authority boundary without making repository metadata a prerequisite for unrelated packaged-runtime capabilities.

## RED→GREEN evidence

- **RED:** `pnpm --filter @cat-cafe/api build && node --test packages/api/test/harness-eval/eval-release-truth-resolver.test.js` failed in the new no-repository case while constructing the resolver, matching the Windows `git rev-parse` log.
- **GREEN:** the same resolver suite plus `reeval-case-service.test.js` and `eval-verdict-lifecycle-case-route.test.js` passed: 10 tests, 3 suites, 0 failures.
- **Static/build gates:** `pnpm lint`, `pnpm check`, and `pnpm -r --if-present run build` passed. The public API suite and replacement Windows package remain explicit delivery gates.
