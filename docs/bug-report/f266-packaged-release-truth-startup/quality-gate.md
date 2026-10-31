---
feature_ids: [F266, F273]
topics: [desktop, windows, packaging, startup, eval, release-truth, quality-gate]
doc_kind: quality-gate
created: 2026-08-06
tips_exempt:
  reason: Startup incident verification for an existing packaged desktop capability; no new discoverable Hub capability is introduced.
---

# Packaged release-truth startup repair — implementation quality gate

## Verdict

Author-side mechanical verification is green and the repair is ready for mandatory cross-family hotfix review. Delivery is not yet green: exact-head cloud review/CI and a replacement Windows package launch plus tray/prompt acceptance remain required.

## Acceptance matrix

| Requirement | Evidence | Result |
|---|---|---|
| Packaged API startup does not require `.git` | The production resolver was constructed against a real temporary directory with no repository metadata; construction survived with `loadedRuntimeHead` unavailable | Met |
| F266 release facts stay fail-closed | Valid `verifyMainLanded` and `verifyLiveActive` inputs reject with `commit_unavailable` whenever runtime Git truth cannot be frozen | Met |
| Input validation is not weakened | A Git-looking option such as `--all` still rejects with `invalid_commit` before the unavailable-source result | Met |
| Repository runtime behavior is unchanged | Existing tests still freeze loaded `HEAD` and separately verify main ancestry and live runtime equality | Met |
| Unrelated packaged capabilities remain available | API startup logs the unavailable capability instead of throwing; the resolver remains registered so lifecycle case operations exist while unverifiable release writes reject | Met |
| Replacement package closes the field incident | Exact-head Windows install launches and completes the F273 tray/prompt sequence | Pending external acceptance |

## RED→GREEN record

1. Windows package `0.12.0-rc.1105.10` reproduced the P1: both normal and memory-store API starts exited before port `3004` was ready.
2. Logs identified `git rev-parse --verify HEAD^{commit}` in a packaged directory without `.git` as the common failure.
3. The new regression test used the real Git adapter against a temporary non-repository directory. RED failed during resolver construction with the same `commit_unavailable` condition.
4. GREEN moves only that initial truth-source outage into an unavailable resolver. It preserves strict commit validation and fail-closed release-fact methods.
5. Existing F266 resolver, case service, and lifecycle-route tests passed after the repair.

## Verification evidence

| Check | Result |
|---|---|
| Focused F266 resolver/case/route suites | 10 passed, 0 failed |
| `pnpm --filter @cat-cafe/api test:public` | 19,698 tests; 19,620 passed, 78 skipped, 0 failed |
| `node --test desktop/*.test.js` | 188 passed, 0 failed |
| `pnpm lint` | Exit 0; existing warnings only |
| `pnpm check` | Exit 0; all repository checks passed |
| `pnpm -r --if-present run build` | Exit 0 |
| `git diff --check` | Passed |
| no-Git production-module dogfood | `startupSurvived=true`, `loadedRuntimeHead=null`, `releaseFactCode=commit_unavailable` |

The root `pnpm test` also exercised most internal tests successfully, but its final result is not valid for this public export because private/home-only files such as `.claude/settings.json`, hook scripts, and internal reflection anchors are intentionally absent. The repository-defined public suite above is the corresponding CI truth source and passed completely.

## Security and failure-mode audit

- No commit identity is fabricated and no caller claim is trusted without Git proof.
- No `.git` data is bundled into the installer.
- The catch is limited to the typed `commit_unavailable` result produced while freezing runtime `HEAD`; unexpected exceptions still abort startup.
- The unavailable resolver validates input before reporting source unavailability, preserving option-injection defenses.
- The repair does not add a desktop retry or storage fallback; both had already demonstrated the same failure and are outside the causal boundary.
- The current patch adds one typed catch at the release-truth owner and one startup-state log branch. It does not add three fallback layers to any file.
- No UI code changed, so there is no new screenshot or `.pen` comparison target.
- Artifact hygiene found no generated root media or unexpected tracked build output.

## Remaining delivery gate

After cross-family review and exact-head CI are green, build a replacement Windows RC from that exact commit. The operator must verify launch, then pending prompt → hide/tray → tray manual check → same prompt re-present → resolve. `0.12.0-rc.1105.10` remains superseded and must not be delivered.
