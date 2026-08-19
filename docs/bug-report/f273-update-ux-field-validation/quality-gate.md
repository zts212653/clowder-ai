---
feature_ids: [F273]
topics: [desktop, electron, updater, proxy, markdown, security, quality-gate]
doc_kind: quality-gate
created: 2026-07-28
tips_exempt:
  reason: Verification evidence for an existing desktop updater correction; it does not introduce a discoverable top-level Hub capability.
---

# F273 updater field correction — implementation quality gate

## Verdict

The repair slice is ready for exact-head cloud re-review. It corrects the Windows field findings, the cross-package renderer-cache regression found in `0.12.0-rc.1105.12`, and the remaining cloud-review process-cleanup gap without weakening the existing release-asset identity, size, digest, resume, journal, or installer execution boundaries.

This report gates the implementation slice only. F273 remains `in-progress` until a reviewed exact-head package newer than `0.12.0-rc.1105.12` is installed in the isolated Windows acceptance VM and exercises the v0.12.0 update path on first launch.

## Acceptance matrix

| Requirement | Implementation evidence | Test evidence | Result |
|---|---|---|---|
| Platform-specific recommendation | Main sends the exact `target.asset.name` selected for the current OS/architecture; the compact `max-w-lg` renderer shows that one package and a platform-specific download label, without receiving the release body or other-platform download table | Windows Setup, macOS arm64 dmg, absent-other-extension, width-contract, native-fallback, and invalid-platform payload assertions | Met |
| Exact release link | Main derives `https://github.com/zts212653/clowder-ai/releases/tag/v{version}` after semantic-version validation; renderer can request only `open-release` for the pending version | manager, preload, component, and controller tests | Met |
| Browser-like system proxy path | Download remains on Electron `net.request` and receives `session.defaultSession` only for bounded `forceReloadProxyConfig()` / `resolveProxy()` diagnostics; no proxy override or environment injection is added | proxy success and best-effort failure tests | Met |
| Safe transport observability | Logs expose proxy decision, redirect host/status/method, response host/status, failure phase, and received bytes; every manager/controller error boundary redacts URL-bearing text, and signed redirect path/query are excluded | signed-redirect, upper-manager-error, controller-error, and connection-close phase/byte tests | Met |
| Manual recovery | Failed automatic download offers Retry, Download in Browser, and Cancel; browser action awaits the exact release page, reports opener failure with a canonical manual URL, and tells the user an overwrite install preserves data | manager failure-action and rejected-browser-opener tests | Met |
| IPC trust boundary | Main owns the pending payload and canonical URL; preload admits enumerated actions only; controller checks current main-window sender, main frame, exact version, and action, then resolves once | hostile sender/frame/version/action, replay, duplicate-action, and disposal tests | Met |
| Ordinary-browser isolation | The AppShell can mount the component, but without the Electron preload bridge it subscribes to nothing, performs no update check, and renders no prompt | explicit no-`desktopBridge` component test plus injected-bridge visual test | Met |
| Renderer-unavailable recovery | Initial prompt presentation is bounded; renderer navigation or process loss invalidates readiness and starts the same bounded presentation timer for a pending prompt; timeout falls back to a plain native dialog with the same selected platform asset | controller ready-then-unavailable, main lifecycle-wiring, presentation-timeout, and manager native-fallback tests | Met |
| Desktop popup-link policy | Electron denies all child windows, hands remote HTTPS and exact app/API/preview loopback-origin links to the system browser, and rejects sibling ports, credential-prefix lookalikes, remote HTTP, unsafe schemes, and malformed URLs | pure policy tests plus main-process wiring assertions | Met |
| Download-state recovery | Update-directory creation and download both run inside the `_downloading` ownership boundary, so either failure offers recovery and releases the lock | repeated directory-creation-failure test | Met |
| Packaged dependency closure | Electron build files contain every local JavaScript dependency reachable from `main.js` | recursive dependency-graph test first failed on both new modules, then passed | Met |
| Package-owned renderer entry | Electron keys the initial renderer navigation by `app.getVersion()`; the PWA cache policy deliberately does not ignore that parameter, so a worker left by another package cannot substitute its precached root document | renderer policy, main wiring, PWA configuration, generated-worker, and production-build assertions | Met locally; packaged transition pending |
| Bounded OpenCode cleanup probe | The descendant-disappearance poll owns its deadline and stops scheduling timers when it rejects | deterministic short-deadline regression plus affected suite | Met |

## Red-to-green record

1. Focused tests failed before the implementation for rendered notes, canonical link actions, IPC admission/replay, system-proxy diagnostics, safe redirect logging, phase/byte failures, and browser recovery.
2. The first full public suite found one additional packaging defect: `update-prompt-controller.js` was absent from `desktop.build.files`.
3. The packaging test was strengthened from direct `main.js` imports to the complete reachable local JavaScript dependency graph. Its red result identified both `update-prompt-controller.js` and the transitive `update-network-diagnostics.js`.
4. Both modules were added to the package manifest. The focused packaging test, all desktop tests, and the complete public suite then passed.
5. Fresh-context review reproduced four additional failures: an upper-layer signed-URL leak, a sticky `_downloading` lock after update-directory creation failed, an unhandled browser-opener rejection, and stale renderer readiness after reload or crash.
6. Four focused tests failed for those exact reasons before the correction. Error handling is now sanitized at each ownership boundary, directory creation is inside the existing `try/finally`, the browser recovery action is awaited and reports a canonical manual URL on failure, and Electron lifecycle events invalidate renderer readiness.
7. The same focused tests passed after the correction, followed by all 157 desktop tests and the complete public suite.
8. Operator follow-up rejected the cross-platform release table in the prompt. New manager/component/controller tests first failed because the payload still carried `releaseNotes`; the implementation then switched to the checker-selected `platform + assetName`, and all focused tests passed.
9. Cloud review found that the HTTPS-only popup guard also denied main-owned HTTP loopback links. Policy/wiring tests first failed for exact app/API/preview origins while adversarial origin lookalikes stayed rejected. The policy now admits only those three exact origins in addition to HTTPS, and `main.js` passes the three packaged origins explicitly.
10. Windows field round 13 proved that `0.12.0-rc.1105.12` fetched and selected v0.12.0 correctly but never received renderer readiness: startup emitted neither accepted nor rejected readiness, while a manual check logged `Update available` and then produced no UI. Comparing the installed package with the previous stable package showed that the stable AppShell had no updater component and its persistent-origin service worker could serve that old root shell to the new Electron process.
11. Renderer-entry and PWA-policy tests failed before the cache-ownership fix. Electron now navigates to `/?__clowder_desktop_version=<app.getVersion()>`, and Workbox ignores only tracking parameters. The production build generated the same policy. A package upgrade therefore misses another version's precached root and reaches the current NetworkFirst navigation path without clearing any user storage.
12. Cloud review found that an outer timeout rejected without cancelling the descendant-process polling loop. A deterministic 20 ms regression first observed the old loop continue instead of rejecting internally; the poll now owns a 5 s default deadline and schedules no timer beyond it.

## Verification evidence

| Check | Result |
|---|---|
| `node --test desktop/*.test.js` | 166 passed, 0 failed |
| `node --test packages/api/test/build-script-cross-platform.test.js` | 8 passed, 0 failed |
| `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/DesktopUpdatePrompt.test.tsx` | 7 passed, 0 failed |
| Adjacent AppShell tests | Passed |
| Web TypeScript check | Passed |
| Web production build | Passed |
| `pnpm lint` | Exit 0; existing warnings only |
| `pnpm check` | Exit 0; existing advisory warnings only |
| `pnpm -r --if-present run build` | Exit 0 |
| `git diff --check` | Passed |
| `pnpm check:capability-tips` | Passed |
| `env -u NODE_ENV -u REDIS_URL pnpm --filter @cat-cafe/api run test:public` | 16,690 passed, 0 failed, 28 skipped |
| `node --test desktop/*.test.js packages/api/test/opencode-model-id-request.test.js packages/web/test/next-config.test.cjs` | 203 passed, 0 failed, 1 skipped |
| `pnpm --filter @cat-cafe/web exec tsc --noEmit` | Passed |
| `pnpm --filter @cat-cafe/web build` | Passed; generated `sw.js` preserves the desktop-version parameter |
| `pnpm check:features` | Passed; 282 feature truth files and producer registry parity verified |

### Popup-link dogfood

Scope verdict: required because this bug made local screenshots and artifacts unclickable in the packaged desktop app.

The production popup policy was invoked directly with the packaged app, API, and preview origins plus adversarial URLs. The probe asserted the complete decision object and printed:

```json
{"previewScreenshot":true,"apiArtifact":true,"previewGateway":true,"remoteHttps":true,"credentialSpoof":false,"siblingPort":false,"fileScheme":false}
```

This is the same pure policy called by `setWindowOpenHandler`; main-process wiring assertions prove the packaged handler supplies only `APP_ORIGIN`, `API_ORIGIN`, and the standard `PREVIEW_ORIGIN`. Electron still returns `deny` for every popup, so admitted links open in the system browser rather than an Electron child window.

An isolated manager dogfood probe simulated a signed download error followed by a rejected default-browser launch. It produced:

```json
{"dialogTitles":["Download Failed","Could Not Open Browser"],"signedUrlRedacted":true,"manualUrlVisible":true}
```

The probe used a temporary directory and injected Electron mocks; it touched no runtime service, persistent store, reserved port, or real update directory.

The literal root `pnpm test` is not the public-sync truth source: this checkout intentionally omits private governance and operations artifacts that suite requires. `scripts/pre-merge-check.sh` selects `test:public` when `.claude/settings.json` is absent; the command above is the repository-defined suite for this upstream-main worktree.

## Security and failure-mode audit

- No renderer-supplied URL reaches `shell.openExternal`.
- No signed GitHub asset path, query, response header, token, or credential is logged.
- Proxy diagnostics are bounded and best-effort; failure cannot block the automatic request.
- Update-directory creation failure cannot strand the manager's `_downloading` lock.
- A rejected default-browser launch is awaited, sanitized, and converted into a visible canonical manual URL.
- Renderer navigation or process loss invalidates prompt readiness; every pending prompt still has a bounded native fallback.
- The renderer does not infer the platform or parse GitHub Markdown: it displays the platform enum and exact asset name supplied from the already-selected trusted target.
- The prompt IPC payload no longer contains the GitHub release body or other-platform download table.
- The manual browser path never authorizes local installer execution.
- Renderer popups never create Electron child windows. Only remote HTTPS and the exact app/API/preview loopback origins reach the system browser; sibling ports, hostname/credentials lookalikes, remote HTTP, unsafe schemes, and malformed URLs fail closed.
- A package version owns its renderer entry document. The version query changes no origin or IPC trust decision, and avoids destructive Service Worker, Cache Storage, localStorage, IndexedDB, cookie, or subscription clearing.
- The OpenCode descendant probe owns its cancellation boundary; timeout rejection cannot leave an unbounded timer chain alive in CI.
- Automatic execution still requires fresh GitHub metadata plus exact asset name, size, and SHA-256 digest.
- No local service, production Redis, persistent runtime store, or reserved port was used.
- The current cache-ownership and process-cleanup delta adds no three-layer fallback. The whole PR still triggers the repository fallback ledger in nine pre-existing files; this delta removes the need for cache-clear and renderer-readiness fallbacks by changing the entry-document coordinate directly.
- `scripts/check-fallback-layers.mjs` passed and reported the whole-PR ledger above. The quality-gate skill's named `pnpm check:architecture-ownership` command is not present in this checkout's package scripts; this tooling drift is recorded rather than replaced with an invented command.
- Architecture ownership remains `hub-action-surface` with no map delta: the correction adds no service, persistence owner, feed, or network boundary.
- Artifact-hygiene inspection found no generated root artifact or unexpected tracked build output.

## UI verification

The actual `DesktopUpdatePrompt` component was mounted from exact HEAD through an isolated Next.js production server on port 3231. Playwright explicitly injected mock Windows and macOS `desktopBridge` payloads before mount; this is test-only simulation, not ordinary-browser product behavior. The popup-link delta changes only Electron main-process URL admission and has no rendered component or layout delta. The screenshots are archived at:

- `docs/bug-report/f273-update-ux-field-validation/artifacts/update-modal-v0.10.0-to-v0.12.0.png`
- `docs/bug-report/f273-update-ux-field-validation/artifacts/update-modal-macos-arm64-v0.10.0-to-v0.12.0.png`

DOM inspection verified the compact `max-w-lg` modal, dialog role, canonical release link, current/target versions, Windows-only Setup recommendation, macOS-only arm64 dmg recommendation, platform-specific download labels, and absence of the other platform's extension. The server, injected route state, browser, and temporary main-worktree files were removed afterward; port 3231 was closed. The independent component regression also proves that an ordinary browser without `desktopBridge` renders nothing. No F273 design source exists in the repository (`docs/design/f190-console-layout.pen` is unrelated), so there is no matching `.pen` comparison target.

### Package-transition dogfood boundary

The local dogfood exercised the exact production URL helper, production PWA build, and generated worker. It printed `http://localhost:3003/?__clowder_desktop_version=0.12.0-rc.1105.13`; the generated worker ignores only `utm_*` and `fbclid` and retains its NetworkFirst navigation routes. This is sufficient for source review but cannot prove a real cross-package Service Worker transition. AC-16 therefore remains open until a new exact-head Windows artifact is installed over `0.12.0-rc.1105.12` (or the stable package) and first launch records renderer readiness before the automatic check, followed by a visible manual-check result.
