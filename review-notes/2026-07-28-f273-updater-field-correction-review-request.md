# Review Request: F273 updater field correction

Review-Target-ID: f273
Branch: fix/f273-update-ux-fallback
Base: `origin/main@7207936a3`
Superseded readiness HEADs: `b768d4e91`, `83ae487a7`, `38c7ffd07`
Superseded packages: `0.12.0-rc.1105.3`, `0.12.0-rc.1105.4`, `0.12.0-rc.1105.5`
R3 implementation HEAD: supplied in the formal handoff; it must include this packet
Exact review HEAD: the pushed R3 implementation HEAD, not any superseded SHA

## What

- Replace the native plain-text update offer with a context-isolated AppShell modal that shows only the checker-selected package for the current platform/architecture plus a main-owned canonical release link.
- Keep automatic download on Electron's default system-proxy session while adding bounded, redacted proxy/redirect/response/phase/byte diagnostics.
- Add Retry / Download in Browser / Cancel recovery without weakening installer identity, size, digest, resume, journal, or execution checks.
- Bind renderer readiness to a main-owned document capability minted only when
  a trusted main-frame document commits. Revoke it when the next document
  commits, the renderer process is lost, or the controller is disposed; reject
  untrusted, malformed, stale, and replayed readiness IPC.
- Atomically mint and first-deliver the capability during trusted main-frame
  commit, then idempotently replay the same value on top-level `dom-ready`.
  Keep the renderer API zero-argument and the capability inside
  context-isolated preload. Readiness intent persists across capability
  replacement and sends READY exactly once for each delivered capability.
- Remove renderer-initiated registration completely, so a queued message from
  a retired document cannot replace authority after the live document is
  already ready.
- Keep the Windows AppUserModelID in explicitly packaged runtime code. The
  running main process must not dereference electron-builder's build-only
  `package.json.build` metadata.
- Close four fresh-context recovery findings: upper-boundary URL leakage, sticky download lock after directory failure, rejected browser opener, and stale renderer readiness.

## Why

Windows field validation proved that v0.10.0 could discover v0.12.0, but the
native dialog exposed literal Markdown and an eight-minute
`net::ERR_CONNECTION_CLOSED` left neither actionable diagnostics nor a browser
recovery path. Later exact-head package validation exposed a second failure:
frame/origin trust could admit a queued READY from the replaced document,
making `_rendererReady` true without a mounted prompt and suppressing the
bounded native fallback. The first token repair still let a retired document's
delayed REGISTER replace the live token after the replacement document had
already become ready. The repair must preserve Electron's system proxy and the
existing trusted asset tuple while making readiness a document-scoped
main-process capability whose replacement authority never crosses into the
renderer. Real installation of the reviewed `.4` package then exposed a
separate startup failure: electron-builder consumed the `build` block from its
input package metadata, while top-level `main.js` tried to read
`require('./package.json').build.appId`. The process crashed before `ready`.
The replacement must source the same exact AUMID from code that is actually
shipped in `resources/app`.

Real Windows installation of the `.5` replacement then proved a liveness gap
in the repaired authority protocol. Manual checking reached main, selected
`v0.12.0`, and timed out after 15 seconds because renderer readiness never
completed. Capability creation on `did-navigate` and one-shot first delivery
on the separate `dom-ready` event formed a split, unacknowledged transaction.
The replacement must make commit itself deliver the new capability; the later
event may replay, but cannot be the sole liveness edge.

## Original Requirements

> A packaged Windows v0.10.0 client detects v0.12.0, but the update dialog shows literal Markdown tokens and the automatic download ends with `net::ERR_CONNECTION_CLOSED`.
> “正常的源码应该不会提示这个吧；应该只有安装包才会提示吧。”
> “如果是Windows就推荐Windows的setup安装包 macos就提示mac对应的dmg……因为用户点击download的时候你也是需要下载合适的版本的包的。”
> “升级的弹窗有点太宽了；可以窄一点的。”
> “Windows和mac的好像不太一样的？然后点击下载的之后看不到下载进度的；是不是可以给个小的可以在页面拖动和去掉的进度条这种之类的”
> AC-14: 健康启动不因 navigation/readiness 竞态落入 native fallback。

- Sources: `docs/bug-report/f273-update-ux-field-validation/bug-report.md` and
  `docs/bug-report/f273-renderer-readiness-download-progress/bug-report.md`
- Please judge the deliverable against both field recovery and the ordinary-browser isolation boundary above.

## Tradeoff

- No hard-coded proxy, proxy environment injection, mirror, alternate downloader, or arbitrary external URL.
- The renderer owns presentation only; main retains release/version/action authority and all download/install state.
- The renderer does not parse release Markdown or infer the OS. Main reuses the exact asset already selected by `selectUpdateTarget()` and sends only `windows|macos + assetName`; the compact offer is capped at `max-w-lg`.
- Native dialogs remain the bounded fallback when the renderer or automatic download cannot complete.
- `did-start-navigation` is deliberately not an invalidation boundary because a
  provisional navigation may be cancelled or fail. `did-navigate` atomically
  revokes the retired capability and mints the replacement after a new
  main-frame document commits; `render-process-gone` remains the independent
  crash boundary.
- The capability is main-generated and first delivered main→preload atomically
  at trusted commit; top-level `dom-ready` replays the same capability. It is
  never exposed through `contextBridge`. Preload latches the
  renderer's zero-argument readiness intent and completes READY at most once
  per delivered capability. A main-rejected capability cannot authorize a
  retry or replacement; a transport-level invoke rejection only re-arms the
  still-current capability for a later event-driven attempt. Only a later
  main-owned commit can mint replacement authority.
- No renderer REGISTER channel, handler, polling loop, or retry timer exists.
  The existing presentation timer remains the only bounded fallback.
- The archived browser screenshot uses an explicitly injected mock Electron bridge. This keeps the ordinary web app inert while exercising the real component.

## Architecture Ownership

Architecture cell: `hub-action-surface`
Map delta: none
Why: The modal is a desktop-owned action surface mounted in the existing AppShell. The correction adds no service, persistence owner, feed, network boundary, or parallel infrastructure abstraction.

Please reviewer check:

- the diff is consistent with `Map delta: none`;
- no parallel `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding` was introduced;
- the renderer bridge remains a narrow extension of the existing desktop boundary.

## Open Questions

### Technical OQ

1. Can any renderer-supplied URL, stale version, child frame, duplicate action, or destroyed window cross the main-owned IPC boundary?
2. Can any signed asset path/query re-enter logs or dialogs through a higher error boundary?
3. Do directory creation, browser launch, renderer navigation/crash, redirect, response, and stream failures all release their state owner and leave a visible bounded recovery path?
4. Does the ordinary browser remain inert while packaged Electron can replay exactly one pending prompt?
5. Does `desktop.build.files` close the full local JavaScript dependency graph reachable from `main.js`?
6. Is the displayed recommendation exactly the asset that `downloadAndInstall(target)` will receive, with no other-platform package exposed?
7. Can an old or crashed document receive a replacement capability, or make a
   retired capability ready, across main→preload delivery, READY, and
   navigation-event ordering?
8. Do intent-before-capability, capability-before-intent, and rejected
   C1→replacement C2 all converge to exactly one READY per capability without
   consuming readiness intent or starting a second timer?
9. Can duplicate capability delivery, duplicate READY, dispose, process loss,
   or a delayed retired-document message leak/replace authority, duplicate
   `onRendererReady`, or strand the pending prompt?
10. Can packaged startup reach `app.on('ready')` without any runtime dependency
    on electron-builder-only metadata, while the process, builder, and Inno
    shortcut AppUserModelIDs remain exactly equal?
11. Does trusted commit immediately produce one capability delivery, with
    `dom-ready` replaying the identical value and preload emitting at most one
    READY regardless of delivery/intent order?
12. After a READY invoke rejection, can the same current capability retry on a
    later replay without a retired rejection clearing the replacement marker?

### Value OQ

None.

## Fresh-Context Findings

Historical agent: [砚砚/gpt-5.6-terra🐾]
Historical SHA scanned: `4fac84c26`
Historical findings: 4 (0 P1, 4 P2, 0 P3)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 | Manager re-logged URL-bearing errors after installer sanitization | fixed in `d1965ef83`; boundary regression test added | Closed |
| FC-2 | `mkdirSync` failure stranded `_downloading` | fixed in `d1965ef83`; two-attempt recovery test added | Closed |
| FC-3 | Browser fallback rejection was unhandled | fixed in `d1965ef83`; visible canonical manual URL test added | Closed |
| FC-4 | Renderer readiness survived reload/crash and could hang the prompt queue | fixed in `d1965ef83`; lifecycle invalidation/timeout tests added | Closed |

Terra independently reproduced all four corrected paths and confirmed no new P1/P2 within that remediation delta. This was finding closure only, not a formal verdict.

Superseded document-token delta:

- SHA scanned: `83ae487a72d2f79c9a7f15ecf3ebb2f7ef0fb497`
- [宪宪/claude-opus-4-6🐾] initially returned a zero-finding adversarial scan,
  then explicitly withdrew it after the omitted delayed-D1-REGISTER ordering
  was demonstrated.
- [砚砚/gpt-5.6-terra🐾] reported `[FC:new]` P2 FC-1: a delayed REGISTER from
  retired D1 could arrive after D2 REGISTER→READY, replace the live token, and
  demote readiness without producing a rejection that could trigger retry.
- Author disposition: accepted. The R2 contract removes renderer registration
  and makes trusted main-frame commit the only capability mint/replacement
  edge.
- [宪宪/Fable🐾] confirmed the R2 contract. Its two P3 verification requests
  are included: persistent intent across rejected C1→C2 and terminal disposal.
- [金渐层/codex-for-me-gpt-5.4🐾] returned no usable evidence because its
  backup invocation failed before inspection; no verdict is inferred.

Formal reviewer: annotate findings as `[FC:covered]`, `[FC:new]`, or `[FC:N/A]`.

## Next Action

Perform a fresh, exact-HEAD review against `origin/main@7207936a3`, with
particular emphasis on the package-startup delta after `a4f5df5cb`.
Independently rerun the runtime-identity/package-files contract and the
commit-owned capability, preload intent/delivery ordering, retired-document
authority, pending-prompt fallback, lifecycle wiring, disposal, packaging,
browser-isolation, and signed-URL cases. Return a named APPROVE or
REQUEST-CHANGES verdict with P1/P2/P3 severity and exact evidence.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f273/codex`
- Start Command: `pnpm review:start --web-port=3231 --api-port=3232`
- Ports: `web=3231`, `api=3232`
- Safety: detached/read-only HEAD, isolated memory/test data, no runtime Redis, no production service, no reserved port, and no runtime config changes.

### Sandbox Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
```

The targeted desktop and packaging tests do not import API `dist/`; build `@cat-cafe/api` only if expanding the review to tests that do.

## Self-check evidence

### Spec compliance

- The exact selected Windows Setup or current-architecture macOS dmg is shown; the GitHub release body and cross-platform download table do not cross prompt IPC.
- Complete release notes remain available through the main-owned exact-version link.
- Electron default-session proxy remains authoritative; proxy refresh/resolution is diagnostic and best-effort.
- Renderer actions are enumerated and admitted only for the current main frame and exact pending version.
- No renderer REGISTER path exists. A trusted main-frame commit is the only
  capability mint/replacement edge and performs first delivery atomically;
  top-level `dom-ready` replays the same value to current preload, which retains
  it inside the isolated world. READY must present the exact current capability.
- A committed main-frame navigation or renderer-process loss revokes both token
  and readiness. Same-document, child-frame, cancelled, and provisional failed
  navigation do not mutate readiness.
- Readiness intent persists across a rejected capability and is evaluated once
  for each newly delivered capability. Duplicate delivery/READY for the
  current capability is idempotent. A retired capability or former REGISTER
  message cannot clear or suppress the singular pending-prompt fallback timer.
- Manual recovery cannot authorize automatic execution; existing asset tuple and digest verification remain unchanged.
- Ordinary browsers have no desktop bridge, make no updater request, and render no prompt.

### Tests

```text
node --test desktop/update-manager.test.js \
  desktop/update-prompt-controller.test.js desktop/preload.test.js
  67 passed, 0 failed

node --test desktop/*.test.js \
  packages/api/test/build-script-cross-platform.test.js
  193 passed, 0 failed

pnpm --filter @cat-cafe/web exec vitest run \
  src/components/__tests__/DesktopUpdatePrompt.test.tsx \
  src/components/__tests__/DesktopUpdateSettingsPanel.test.tsx
  16 passed, 0 failed

pnpm --filter @cat-cafe/web exec tsc --noEmit
  exit 0

pnpm check
  exit 0

pnpm lint
  exit 0; existing warnings only

pnpm -r --if-present run build
  exit 0

git diff --check
  passed
```

The literal root `pnpm test` is not green in this public checkout because it
expects private governance packs/scripts/settings that are not present. That
known repository-boundary failure is not represented as product-test success;
the project-defined `pnpm check`, complete relevant desktop/package suite,
typecheck, lint, and build above are green.

The isolated production-controller dogfood probe exercised the real IPC
handlers and produced:

```json
{"firstReady":{"accepted":true},"staleReady":{"accepted":false},"replacementReady":{"accepted":true},"legacyRegisterPresent":false,"timersAfterReplacementReady":0,"readinessEpochs":2,"promptReplayed":true,"resolvedAction":"later"}
```

This proves the old capability is rejected after commit, the removed REGISTER
handler cannot replace the live authority, the replacement document clears the
fallback timer, and the pending prompt is replayed. It does not replace
packaged Electron acceptance.

### Browser evidence

- Screenshots: `docs/bug-report/f273-update-ux-field-validation/artifacts/update-modal-v0.10.0-to-v0.12.0.png` and `update-modal-macos-arm64-v0.10.0-to-v0.12.0.png`.
- Exact component, isolated Next.js production server on web 3231, explicit Windows and macOS mock `desktopBridge` payloads.
- DOM verified the compact `max-w-lg` width, dialog semantics, canonical link, versions, single selected asset, platform-specific download label, and absence of the other platform's extension.
- Ordinary-browser regression deletes `window.desktopBridge` and asserts empty output.
- Server/browser/temp route were removed and port 3231 was closed.

### Artifact gate

- Root worktree media/design artifact scan: empty.
- Root committed-diff media/design artifact scan: empty.
- Screenshot is intentionally archived under the F273 bug-report artifact directory.
- No generated build output is tracked.

### Related documents

- Plan: `feature-specs/2026-07-28-f273-update-ux-fallback.md`
- State contract: `docs/plans/2026-07-29-f273-renderer-document-readiness-state-contract.md`
- Feature: `docs/features/F273-desktop-in-app-update.md`
- Field diagnosis: `docs/bug-report/f273-update-ux-field-validation/bug-report.md`
- Readiness/progress diagnosis:
  `docs/bug-report/f273-renderer-readiness-download-progress/bug-report.md`
- Quality gate:
  `docs/bug-report/f273-renderer-readiness-download-progress/quality-gate.md`

[砚砚/gpt-5.6-sol🐾]
