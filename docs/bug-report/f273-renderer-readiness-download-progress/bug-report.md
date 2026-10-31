---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, download-progress, windows]
doc_kind: bug-report
created: 2026-07-28
updated: 2026-08-04
tips_exempt:
  reason: Field correction for the existing desktop updater presentation and download-status path.
---

# F273 renderer readiness and in-app download progress

## Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | In the packaged Windows `0.12.0-rc.1105.2` client, the update offer appeared as Electron's native fallback instead of the existing renderer modal. After choosing Download, the application page exposed no download progress even though the taskbar/tray path can receive percentages. Expected: the platform-specific renderer offer appears during a healthy app startup, and an in-app surface shows the active transfer without making visibility control equivalent to cancellation. |
| **2. Evidence** | Operator screenshots captured both the actual native Windows dialog and the expected warm renderer modal. The installed dialog identifies current version `v0.12.0-rc.1105.2`; fork Actions run `30355177588` built that version from exact HEAD `fa6989130`, so this is not an old-package claim. `UpdatePromptController.show()` starts a 15-second timer whenever `_rendererReady` is false; expiry resolves `undefined`, and `UpdateManager._promptUpdate()` maps that result to the native dialog. Startup calls `updater.startSchedule()` immediately after `createMainWindow()`, while renderer readiness is emitted later from a React `useEffect`. Download progress currently terminates at `mainWindow.setProgressBar()` and tray tooltip mutation in `desktop/main.js`; no progress IPC exists in preload or the web bridge. The standard API-process preflight is not applicable to this remote packaged Electron observation; no claim about an unrefreshed local runtime is being made. |
| **3. Root cause** | **Prompt root cause:** startup update checking was scheduled immediately after `createMainWindow()`, which only starts asynchronous navigation. The check could reach `UpdatePromptController.show()` before the React-owned trusted-ready signal; its 15-second presentation deadline was measured from the check result rather than from renderer readiness. Expiry is the only valid-payload path that resolves without an action, and `UpdateManager._promptUpdate()` maps that result to the observed native dialog. The bug is the startup ordering contract, not Windows styling. **Progress root cause:** the main process never projected download status into renderer state, so the page could not render progress. |
| **4. Diagnosis strategy** | Trace the exact lifecycle `services.startAll()` → `createMainWindow()` → `startSchedule()` → `show()` → readiness IPC and characterize the race with a deterministic failing test. Compare it with the working hidden-window replay path. Separately trace `downloadAsset()` progress callbacks through `UpdateManager` and `main.js`, then specify one bounded, typed main→preload→renderer status projection before implementation. |
| **5. Timeout strategy** | If a deterministic startup-order test cannot distinguish a readiness race from an IPC-origin/preload failure, stop before implementation and add one safe lifecycle diagnostic at each boundary rather than increasing the timeout. Do not use live GitHub, production data, Redis `6099`, or reserved runtime ports for reproduction. |
| **6. Early warning** | A timeout-only increase, a second independent updater state machine in React, or making the close button abort the download means the design is treating symptoms. Three new fallback layers in one file trigger the Maine Coon coordinate-system audit. |
| **7. User-visible correction** | The automatic schedule begins on the first trusted renderer-ready epoch, so a healthy AppShell owns the offer; the existing bounded native fallback remains available if a pending prompt later loses its renderer. An app-local floating download card appears at the point of action, can be repositioned, collapsed, or hidden, and keeps the transfer alive when hidden. Terminal success or failure clears the card; a healthy renderer owns the actionable completion confirmation, with the native dialog retained only as a presentation fallback. |
| **8. Acceptance** | Red→green tests now cover startup ordering, one schedule per readiness epoch, typed main→preload→renderer progress, last-value replay after reload, hide-without-cancel, same-version retry resurfacing, ordinary-browser isolation, and the supported no-tray path continuing to project progress and terminal clear. Focused desktop/component suites, the complete desktop suite, Web TypeScript, targeted Biome, and `git diff --check` pass. Repository gate and exact-head visual/Windows package evidence are recorded separately; they are not inferred from component tests. |

## Reporter and reproduction record

- **Reporter:** operator, from a real Windows install of the RC package.
- **Operator requirement:** “Windows和mac的好像不太一样的？然后点击下载的之后看不到下载进度的；是不是可以给个小的可以在页面拖动和去掉的进度条这种之类的”
- **Actual:** native fallback offer followed by no app-visible download progress.
- **Expected:** renderer-owned platform offer followed by in-context progress.
- **Field package:** `ClowderAI-Setup-0.12.0-rc.1105.2.exe`, Actions artifact `8686889080`, exact source `fa6989130`.

## Field round 2: Windows identity, update preference, and color roles

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | After the Windows upgrade completed, the Windows 11 Toast attribution line showed `electron.app.Clowder AI` instead of `Clowder AI`. The operator also requested a default-on automatic-update switch under System Settings and identified that the update modal used the same teal status color for its link and primary action. |
| **2. Evidence** | The operator supplied a real Windows screenshot from the installed RC: the Toast body correctly says `Clowder AI Updated / Updated to v0.12.0`, while the OS-owned attribution line says `electron.app.Clowder AI`. `desktop/package.json` declares `build.appId: ai.clowderai.desktop`, but exact source `4e8aa1486` neither calls `app.setAppUserModelId()` nor writes `AppUserModelID` on the Inno-created Start Menu and desktop shortcuts. `update-checker.js` already defaults `autoCheck` to `true` and persists it, but no trusted renderer bridge or settings UI exposes it. The modal's primary button and release link both use `semantic-info`; the repository's operation/link roles are `console-button-primary` and `console-inline-link`. |
| **3. Root cause** | **Toast identity:** the application had a package identity value but never applied it to the running Windows process or the installer-created shortcuts, so Windows attributed the Toast to Electron's fallback identity. The title/body are not the cause. **Preference gap:** persistence existed without a user control plane, and `_scheduleStarted` prevented a stopped schedule from being restarted safely. **Color-role gap:** a semantic status token was used as a general interaction token. |
| **4. Diagnosis strategy** | Compare the packaged app ID, early main-process lifecycle, and both Inno shortcut declarations; require one exact AUMID across all three. Trace `autoCheck` from its persisted default through start/stop scheduling, trusted IPC, preload, and System Settings. Compare the modal classes against the repository's shared primary-button and inline-link CSS rather than selecting new colors locally. |
| **5. Timeout strategy** | If the shared AUMID still produces incorrect attribution in the next Windows package, inspect the installed `.lnk` property store and Toast activator registration on that VM before adding registry or notification-library workarounds. Do not guess or replace the working Electron notification body path. |
| **6. Early warning** | A hard-coded display name in the Toast body, renderer access to the settings JSON path, canceling an active download when auto-check is disabled, or adding a modal-only blue hex value means the fix is at the wrong layer. |
| **7. User-visible correction** | Windows Toast attribution is owned by the installed Clowder AI identity. System Settings exposes “自动检测更新”, default ON; OFF stops future automatic checks but leaves manual checking and any active transfer intact; ON checks immediately and restores the daily timer. Primary actions follow the selected theme, hyperlinks use the shared dark-blue link token, and download status retains its semantic color. |
| **8. Acceptance** | Red→green coverage requires process/shortcut AUMID equality, default/read/write/disable/re-enable schedule behavior, preservation of preference changes across in-flight checks and Skip prompts, trusted main-frame settings IPC, ordinary-browser isolation, modal focus containment/restoration, settings toggle success/failure, and CSS role assertions. Final Toast attribution remains a real Windows package acceptance item because macOS/component tests cannot prove Windows Shell identity resolution. |

The platform mechanism follows the upstream contracts: Electron requires a Windows Start Menu shortcut with an AppUserModelID for notifications, Microsoft requires explicit process/shortcut identity consistency, and Inno Setup supports `AppUserModelID` on `[Icons]` entries:

- <https://www.electronjs.org/docs/latest/tutorial/notifications>
- <https://learn.microsoft.com/en-us/windows/win32/shell/appids>
- <https://jrsoftware.org/is6help/topic_iconssection.htm>

### Design Gate: settings and interaction color roles

- **Existing System Settings language:** `SettingsSection`, `settings-resource-card`, and `SettingsResourceToggleSwitch` already define the warm card, text hierarchy, spacing, and theme-aware switch. The update preference extends this surface; it does not create a new settings dialect.
- **Primary action role:** `console-button-primary` maps to `--cafe-accent` / `--cafe-accent-hover` / `--cafe-accent-foreground`, so the download button follows the active theme.
- **Hyperlink role:** `console-inline-link` is the shared link class used by settings documentation links. Its foreground moves from the teal cross-post/status token to `--conn-blue-text` (light `#1d4ed8`, dark `#93c5fd`) with `--conn-blue-hover`.
- **Progress role (superseded by Field round 9):** the initial implementation used `semantic-info`; the real Windows acceptance screenshot showed that this reads as a separate teal dialect next to the selected theme. Field round 9 moves the dot, percentage, and fill to `--cafe-accent` so the update flow has one active-theme identity.
- **Pencil boundary:** Pencil MCP was retried before this round's implementation and again failed to connect because the active server targets `vscode`, not Antigravity. No `.pen` artifact is claimed. The real modal screenshot, settings primitives, and repository tokens are the design truth sources.

```yaml
in_context_observability:
  primary_surface: "System Settings toggle for the persistent preference; Windows Toast for completed-upgrade attribution"
  why_not_dashboard_only: "The preference must be visible where users configure system behavior, while completion belongs at the OS notification point; a separate updater dashboard would hide both."
  deep_dive_surface: "main.log and the persisted update-settings.json remain diagnostic truth sources, not user control surfaces"
  noise_dedup_policy: "one persistent toggle state and one journal-backed completion Toast per successful upgrade; no notification is emitted for preference changes"
```

## Design Gate: contextual download progress

Pencil MCP was attempted before implementation, but the active server is configured for `vscode` and cannot connect to the required Antigravity editor. No `.pen` artifact is claimed. The fallback design record below uses the real field screenshots, the existing `DesktopUpdatePrompt`, and the repository's own draggable-surface primitives as the truth sources.

### Existing surface and style inventory

- `packages/web/src/components/AppShell.tsx` owns route-surviving root surfaces: activity rail/sidebar/content, the presentation float, concierge, and the desktop update prompt.
- `DesktopUpdatePrompt.tsx` establishes the updater's warm language: `bg-cafe-surface`, `border-cafe`, `rounded-2xl`, semantic-info accent, neutral text hierarchy, and modal z-index `120`.
- `PresentationFloatView.tsx` and `FloatingTranscriptWindow.tsx` establish the draggable-window language: `react-rnd`, `bounds="window"`, a dedicated move handle, warm surface/border/ring tokens, and explicit minimize/close controls.
- `ToastContainer.tsx` occupies bottom-right at z-index `50`; the concierge ball is movable at z-index `30`; presentation floats use z-index `35`; blocking update modal uses z-index `120`.
- The progress surface is a new status projection, not a second update action entry point. It coexists with taskbar/tray progress and the existing completion/failure dialogs.

### Proposed surface

- **Placement:** AppShell root so an active transfer survives route changes. Initial geometry is a compact `320px` card near the lower-right, offset above the default concierge ball; dragging is bounded to the viewport, and expansion or window resize re-clamps stale coordinates before paint.
- **Layering:** z-index `40`: above presentation/concierge floats, below transient toasts and blocking dialogs.
- **Visual language:** warm elevated cafe surface, subtle cafe border/ring, active-theme accent status dot/percentage/fill, 12–14px text, 10–12px radius. No new hard-coded palette.
- **Content:** move handle + “Downloading update” + percent; selected asset name on one truncated line; one active-theme accent progress track.
- **Controls:** collapse changes the card to a narrow draggable status pill; close means “hide this transfer” and sends no IPC. The accessible label states that downloading continues.
- **State ownership:** the main process remains the single transfer owner. Renderer receives a last-value status projection only; it cannot start, pause, cancel, or retarget a download.
- **Terminal behavior:** main emits `idle` after the transfer stage. The card clears, while the existing Ready to Install or Download Failed dialog remains the actionable terminal surface. A retry starts a fresh visible projection even for the same version.

### Placement trade-off

- **Selected:** lower-right with vertical offset. It is spatially consistent with transient progress/status, stays out of the activity rail and sidebar, and is draggable when it overlaps page content.
- **Rejected:** permanent header/status-bar entry. It would be less obtrusive but is not visible enough for a user who just initiated an 800 MB transfer, and it cannot satisfy the requested movable/removable behavior.
- **Collision policy:** toasts retain higher priority and may temporarily cover the card; the progress surface keeps its state and remains movable. The card does not attempt a new global overlay-layout manager.
- **Narrow fallback:** width is clamped to viewport minus `32px`; the desktop shell's current `900px` minimum normally keeps the full card viable. The collapsed pill remains usable without drag.

### State coverage

| State | Visible behavior |
|---|---|
| No active transfer / ordinary browser | No DOM and no update IPC activity. |
| Download start | Full card appears at `0%` (or the first resumed percentage). |
| Downloading | One card is updated in place; repeated progress events never stack notifications. |
| Collapsed | Draggable single-line pill retains version/percent. |
| Hidden | No card; transfer, taskbar, and tray progress continue. |
| Retry | A new start event resets hidden/collapsed presentation and resurfaces the card. |
| Verified / failed | Card clears; the existing actionable main-process dialog is shown. |
| Renderer reload | Current main-owned progress snapshot is replayed when the bridge subscribes again. |

```yaml
in_context_observability:
  primary_surface: "AppShell root draggable download-progress card"
  why_not_dashboard_only: "The user needs immediate feedback at the point where an 800 MB transfer was initiated; a separate dashboard would make healthy progress look like a stalled click."
  deep_dive_surface: "taskbar/tray for OS-level glanceability and main.log for after-the-fact diagnosis"
  noise_dedup_policy: "one last-value card per active transfer; progress replaces in place; user may collapse or hide it; terminal dialogs remain singular"
```

## Field round 3: initial reverse-tab containment

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The update dialog receives initial focus, but pressing Shift+Tab before moving to a child control can move focus behind the modal instead of wrapping to its last admitted control. |
| **2. Evidence** | `containTabFocus()` treats `dialog.contains(dialog)` as an inside-dialog case, while the dialog's `tabIndex={-1}` deliberately excludes it from `getFocusableElements()`. The existing test covers last→first, first→last, external→first, and restoration, but not dialog→last. |
| **3. Root cause** | The containment decision distinguishes outside, first, and last focus, but omits the programmatically focused dialog container as an explicit boundary state. Native reverse traversal therefore remains unhandled for the first keystroke after opening. |
| **4. Diagnosis strategy** | Extend the existing focus-lifecycle test with one Shift+Tab event while the dialog owns initial focus. Require the last admitted control to receive focus, then make the smallest decision-table correction in `containTabFocus()`. |
| **5. Timeout strategy** | If the focused component test does not fail for this exact assertion, stop and inspect jsdom keyboard traversal semantics rather than changing production focus behavior without a deterministic reproducer. |
| **6. Early warning** | Adding another listener, querying a second focusable set, or moving focus ownership out of the existing effect means the correction is duplicating the focus state machine. |
| **7. User-visible correction** | Both Tab directions remain inside the blocking update dialog from the first keystroke after it opens. |
| **8. Acceptance** | The focused prompt test failed 1/13 on dialog→Shift+Tab before the fix and passed 13/13 afterward. The complete prompt/settings run passed 16/16 while retaining forward/reverse boundary wrapping, escaped-focus recovery, and close restoration. |

## Field round 4: frame-scoped renderer readiness

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | Loading an embedded preview frame can clear the AppShell readiness epoch even though the top-level document and its update listeners remain mounted. A later rendered prompt keeps its native-fallback timer and may fall through after 15 seconds. |
| **2. Evidence** | `main.js` listens to WebContents-wide `did-start-loading`, which has no frame identity. Electron 35.7.5 exposes `did-start-navigation` details with both `isMainFrame` and `isSameDocument`; the AppShell contains embedded preview navigation. |
| **3. Root cause** | Readiness belongs to the trusted top-level document, but invalidation is currently wired to an aggregate loading signal. The lifecycle owner therefore cannot distinguish AppShell replacement from subframe or same-document navigation. |
| **4. Diagnosis strategy** | Encode the document-boundary decision as a pure predicate, cover main-document, same-document, and child-frame cases, then wire only qualifying `did-start-navigation` events to `markRendererUnavailable()`. Preserve `render-process-gone` as the independent crash boundary. |
| **5. Timeout strategy** | If Electron 35.7.5 does not expose the documented navigation detail fields, stop rather than infer deprecated positional arguments. Verify the installed version's published type declaration first. |
| **6. Early warning** | Retaining `did-start-loading`, adding a compensating ready signal for iframe completion, or resetting the fallback timer would leave readiness attached to resource loading rather than document ownership. |
| **7. User-visible correction** | Embedded previews and in-page AppShell navigation no longer disturb update-prompt readiness; a real top-level document replacement still invalidates readiness until the trusted renderer registers again. |
| **8. Acceptance** | The focused desktop run failed 2/57 before the predicate and wiring existed, then passed 57/57. The complete boundary table admits only new main-frame documents; main-process wiring uses frame-qualified navigation, retains crash invalidation, and the complete desktop/package suite passes 187/187. |

## Field round 5: document-bound renderer readiness

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | A main-document navigation can invalidate renderer readiness and then accept a queued `desktop-update:ready` from the old document. A prompt created before the new AppShell mounts sees readiness as true, arms no presentation fallback, and can wait indefinitely. |
| **2. Evidence** | PR #1227 exact HEAD `b768d4e91` reproduces the sequence trusted ready → `markRendererUnavailable()` → same old main-frame ready → `show()` with zero fallback timers. Sender WebContents, origin, and `WebFrameMain` equality authenticate the frame but do not identify the document occupying it. |
| **3. Root cause** | `_rendererReady` combines three distinct facts—document authority, AppShell readiness, and ready-message admission—without a document identity. Navigation invalidation therefore cannot distinguish the retired document's queued IPC from the replacement document's readiness. |
| **4. Diagnosis strategy** | Adopt the Stateful Object Gate contract in `docs/plans/2026-07-29-f273-renderer-document-readiness-state-contract.md`: main owns an opaque per-document token, commit/process loss revokes it, preload keeps it inside the isolated closure, and READY must match. First encode the stale-ready sequence as a failing controller test, then cover registration/retry in preload before implementation. |
| **5. Timeout strategy** | If token revocation does not make the exact stale-ready test fail then pass, stop and inspect the test's event ordering and token capture; do not add another navigation listener, retry loop, or longer timeout. |
| **6. Early warning** | Reintroducing `did-start-navigation` readiness mutation, exposing the token to React, letting renderer choose tokens, or adding a second fallback timer means the fix has left the document-identity coordinate system. |
| **7. User-visible correction** | A retired document can never suppress the bounded native fallback. Cancelled, failed provisional, same-document, and child-frame navigation leave the live AppShell ready; a committed replacement must complete a fresh trusted handshake before renderer presentation is considered ready. |
| **8. Acceptance** | The focused controller/preload test first failed in exactly two places: the old document started a second readiness epoch, and preload emitted no registration handshake. The document-token implementation then passed 65/65 focused controller/preload/main tests and 191/191 complete desktop/package tests. Web TypeScript, targeted Biome, `pnpm lint`, `pnpm check`, the workspace build, `git diff --check`, and an isolated production-controller lifecycle dogfood pass. Exact-head review/CI and a replacement package remain pending; `0.12.0-rc.1105.3` is superseded/do-not-install. |

## Field round 6: retired registration authority inversion

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The first document-token implementation can become not-ready after the replacement document has already completed its successful handshake. A later prompt then starts the native-fallback timer even though the live AppShell is mounted and had been ready. |
| **2. Evidence** | At PR HEAD `83ae487a7`, every trusted `desktop-update:register` unconditionally replaces `_documentToken` and sets `_rendererReady=false`. The deterministic sequence D2 REGISTER→READY accepted, then delayed retired-D1 REGISTER, makes duplicate D2 READY return `{ accepted:false }` and `show()` create one fallback timer. The production-controller probe returned `retiredD1ReplacedToken:true`, `d2DuplicateAfterD1.accepted:false`, and `fallbackTimersAfterLateRegister:1`. |
| **3. Root cause** | REGISTER is renderer-originated and authenticated only as the current trusted top frame. That identity survives same-site document replacement, while navigation and renderer IPC have no global order. A retired document can therefore replace authority after D2 READY has already succeeded; rejection-based retry is never triggered because the authority inversion happens after acceptance. |
| **4. Diagnosis strategy** | Return to the Stateful Object Gate and apply the same no-global-order invariant symmetrically. Delete renderer registration; let the controller mint the capability only on trusted main-frame commit and deliver it main→current-preload on top-level `dom-ready`. Preload persistently latches readiness intent and sends READY at most once for each delivered capability. |
| **5. Timeout strategy** | If removing REGISTER does not make the exact delayed-D1 test pass, stop and inspect every remaining capability write and message direction. Do not add another retry, longer timeout, or frame predicate. |
| **6. Early warning** | Any renderer IPC that creates/replaces capability, any one-shot intent that is consumed after a rejected stale delivery, or a second presentation timer means the authority boundary is still split. |
| **7. User-visible correction** | Only a committed trusted AppShell can receive current readiness authority. Retired documents cannot demote the live renderer, and an old capability delivered across a fast navigation is rejected before the current capability reuses the persistent readiness intent. |
| **8. Acceptance** | The controller RED failed 1/20 because D2 READY became rejected after the delayed retired REGISTER. Preload RED failed 2/8 because renderer intent still minted authority and capability delivery was absent. After reversing the direction, focused controller/preload/main tests pass 67/67 and the complete desktop/package suite passes 193/193. Tests cover absent REGISTER, intent/capability both orders, duplicate delivery/intent, C1 rejection followed by C2 acceptance, dispose revocation, stale READY, singular timer, and callback idempotence. Exact-head review/CI and replacement packages remain pending. |

## Field round 7: packaged startup identity metadata

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The real Windows install of `0.12.0-rc.1105.4` aborts before creating application UI. Electron shows “A JavaScript error occurred in the main process” with `TypeError: Cannot read properties of undefined (reading 'appId')` at packaged `resources/app/main.js:13:55`. |
| **2. Evidence** | Exact source `a4f5df5cb` line 13 evaluates `require('./package.json').build.appId`. The field screenshot points to that exact expression after installation, proving the packaged `package.json` exists while its electron-builder-only `build` member does not. The run itself is green and the failure happens during top-level module evaluation, before `app.on('ready')`, so renderer readiness, services, network access, and Toast delivery are not involved. |
| **3. Root cause** | The Windows identity correction treated electron-builder input metadata as runtime application metadata. electron-builder consumes the `build` block to create the package and does not promise it in the running app's generated `package.json`; dereferencing it at module load therefore crashes the packaged process. The previous test compared source configuration and installer text but never exercised the runtime metadata boundary. |
| **4. Diagnosis strategy** | First add a focused regression that forbids packaged startup from reading `package.json.build`, requires a runtime identity module to be present in `build.files`, and still proves equality across runtime, electron-builder, and Inno identities. Then move the constant into packaged code without adding a fallback or delaying identity setup. |
| **5. Timeout strategy** | If the replacement still fails before `ready`, inspect the new package's `resources/app` file inventory and first stack frame. Do not add optional chaining or a fallback display name: silently skipping the process identity would restore the original Windows Toast bug. |
| **6. Early warning** | Reading any `build` field at runtime, deriving AUMID from product display text, or swallowing identity initialization errors means the build/runtime boundary is still wrong. |
| **7. User-visible correction** | The installed application starts normally and applies `ai.clowderai.desktop` before any Windows UI or notification. The installer shortcuts, electron-builder config, and running process remain contract-checked to the same value. |
| **8. Acceptance** | The focused manager suite failed 1/40 on the new packaged-metadata assertion against `.4` source, then passed 40/40 after `app-identity.js` became a packaged runtime input. Fresh complete gates, review, CI, and a real replacement Windows install remain required. `0.12.0-rc.1105.4` is superseded/do-not-install. |

## Field round 8: one-shot renderer capability delivery

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The real Windows install of `0.12.0-rc.1105.5` starts successfully, but startup shows no update offer and a manual “Check for Updates” produces no visible prompt. |
| **2. Evidence** | `main.log` records the manual check at `2026-08-03T01:12:55.660Z`, identifies the installed version as `0.12.0-rc.1105.5`, successfully selects `v0.12.0` at `01:12:56.973Z`, and then records `Rendered update prompt did not become ready for v0.12.0` at `01:13:11.985Z`. There is no release-fetch, version-selection, or network failure. The UI and API are otherwise live. Production wiring creates document authority on `did-navigate` and performs its only delivery on the separate `dom-ready` event. Tests call those two controller methods in the expected order and separately test preload latching, but no test requires a committed document to make its capability deliverable without depending on a later lifecycle event. |
| **3. Root cause** | Capability creation and first delivery are split across two independently emitted Electron lifecycle events with no acknowledgement or recovery path. If the one-shot `dom-ready` delivery runs before authority exists or is otherwise missed, main retains a valid token that preload never receives; renderer readiness intent cannot progress, and every prompt reaches the 15-second fallback boundary. The protocol made authority safe from retired documents but not live: commit was not an atomic create-and-deliver transition. |
| **4. Diagnosis strategy** | Add a controller regression requiring trusted document commit to mint and immediately deliver its capability, while retaining `dom-ready` as an idempotent replay. Cover both delivery orders through the existing preload latch tests, and add lifecycle logs so a future field package distinguishes commit, delivery, and accepted readiness. Keep main as the only capability owner. |
| **5. Timeout strategy** | If the new commit-delivery test does not fail against `.5` source, stop and instrument the packaged preload bridge before changing behavior. If the replacement package still times out, inspect the new commit/delivery/ready log sequence; do not increase the 15-second timeout. |
| **6. Early warning** | Reintroducing renderer registration, letting renderer mint or replace authority, adding a polling loop, or adding another presentation fallback means the fix has left the capability-ownership coordinate system. |
| **7. User-visible correction** | A live trusted document completes readiness regardless of whether React intent or the replay event arrives first. Startup auto-check and manual checks use the warm in-app update prompt; the bounded native fallback remains only for a genuinely unavailable renderer. |
| **8. Acceptance** | The commit-delivery regression failed 1/21 against `.5` behavior because commit produced zero deliveries, then passed after commit became the atomic create-and-first-deliver transition. Cloud review then found that an IPC invocation rejection left the current capability permanently marked as signaled; the preload RED failed 1/9 because same-token replay made only one attempt. The correction conditionally re-arms only the still-current capability, while a retired failure cannot clear its replacement. Focused controller/preload/manager tests pass 70/70 and the complete desktop/package suite passes 196/196. Exact HEAD `706cb6aec` then passed cross-family review, cloud review, CI 5/5, four-family artifact verification, and the operator's complete Windows update-flow acceptance as RC `0.12.0-rc.1105.6`. `0.12.0-rc.1105.5` remains superseded/do-not-deliver. |

## Field round 9: release-note projection and renderer-owned install confirmation

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The accepted Windows `.6` flow works end to end, but the update offer shows only a linked version and selected package instead of the corresponding release-note body. “Update Available” and the download dot/percentage/fill use the old teal status color rather than the active theme used by the primary button. After download verification, Windows falls back to a blue native “Ready to Install” dialog that does not match the warm in-app surface. |
| **2. Evidence** | Three operator screenshots from the real `.6` Windows VM show the exact offer, active transfer, and native completion confirmation. `selectUpdateTarget()` already retains the authoritative GitHub release body as `target.releaseNotes`, but `_promptUpdate()` drops it before renderer IPC. `DesktopUpdatePrompt` uses `text-semantic-info` for the eyebrow and recommendation details; `DesktopUpdateProgressCard` uses `semantic-info` for all three progress accents. `_executeInstall()` unconditionally calls `showDialog()` after verification even though the same trusted `showUpdatePrompt()` transport is available and already has a bounded native fallback. |
| **3. Root cause** | **Release notes:** the main→preload→renderer payload was defined as an asset recommendation only, so already-fetched release content never crossed the presentation boundary. **Color roles:** the first progress design treated transfer state as an independent semantic-info role, but the accepted app theme makes that teal read as an unrelated brand color; the update journey needs the selected cafe accent while the version remains the shared deep-blue link token. **Install confirmation:** offer presentation was renderer-first, but completion presentation bypassed that abstraction and directly selected the OS dialog. |
| **4. Diagnosis strategy** | Encode two discriminated prompt kinds: `available` and `ready-to-install`. Constrain actions per kind at the main-process controller (`download/later/skip/open-release` versus `install/later`), keep every action version-bound in preload, and preserve main ownership of integrity verification, journaling, service shutdown, installer spawn, and quit. Project a bounded release body through the `available` payload and render it with a release-only Markdown surface that has no chat/workspace/Mermaid behavior. |
| **5. Timeout strategy** | If the new renderer confirmation cannot become ready, let the existing 15-second presentation contract resolve without an action and show the unchanged native confirmation. Do not add a second timer, a renderer-side installer path, or a retry loop. If release content causes layout pressure, keep one bounded scroll region and the canonical release link rather than truncating the entire dialog. |
| **6. Early warning** | Letting renderer choose a URL or installer path, accepting `install` on an `available` prompt, losing either pre-spawn integrity check, removing the native fallback, feeding remote release Markdown into workspace-aware rendering, or introducing a modal-local hex color means the change crossed the trust or design boundary. |
| **7. User-visible correction** | The offer contains a scrollable Markdown release-note section plus the exact deep-blue version link for the complete release page. The eyebrow, selected package treatment, download dot, percentage, and progress fill follow the active cafe theme. Once the verified download finishes, the same warm renderer modal offers “Restart & Upgrade” on Windows or “Quit & Install” on macOS; “Later” closes it without falling through to a native dialog. |
| **8. Acceptance** | RED failed 8 desktop assertions across manager/controller/preload and 3/14 component tests for missing payload content, unconstrained prompt kinds, absent `install`, native-only confirmation, teal tokens, and missing release-note UI. GREEN passes 75/75 focused desktop tests and 14/14 prompt/progress component tests. Web TypeScript, targeted Biome, and `git diff --check` pass. Complete repository gates, cross-family review, fresh exact-head CI/cloud review, a replacement four-family package set, and real Windows UI acceptance remain required; `.6` is the functional baseline, not evidence for the new UI delta. |

### Prompt state contract

| Prompt kind | Main-owned payload | Admitted renderer actions | Fallback behavior |
|---|---|---|---|
| `available` | version/current version, platform-selected asset, canonical release URL, bounded release notes | `download`, `later`, `skip`, `open-release` | Existing native Update Available dialog when renderer presentation is unavailable. |
| `ready-to-install` | version, platform, already-verified asset name | `install`, `later` | Existing native Ready to Install dialog when renderer presentation is unavailable. |

The renderer never receives the installer path, digest, journal, service controls, or spawn capability. Selecting `install` only releases the existing main-process verification and elevation path.

### Design acceptance

- [x] Existing warm modal remains the healthy-renderer update offer on Windows and macOS.
- [x] The healthy-renderer offer includes bounded, scrollable release-note Markdown and retains the deep-blue canonical version link.
- [x] Progress card uses repository tokens and existing `react-rnd` behavior.
- [x] The update eyebrow, package treatment, progress dot, percentage, and fill follow the selected cafe theme accent.
- [x] Expanding a collapsed card or shrinking the window re-clamps its geometry so the full controls remain inside the viewport.
- [x] Closing/hiding the card emits no download action and does not alter `_downloading`.
- [x] Renderer reload replays active progress instead of waiting for the next byte.
- [x] Terminal success/failure remains actionable even when the progress card was hidden.
- [x] A verified download uses the warm renderer install confirmation; the native Ready to Install dialog remains the bounded unavailable-renderer fallback.
- [x] Component screenshot is compared against the existing warm modal and actual AppShell layering before review.
- [x] Automatic-update preference reuses the existing System Settings card and theme-aware toggle.
- [x] An in-flight check or Skip action cannot overwrite a newer automatic-update preference.
- [x] Primary update action follows the active cafe theme; shared hyperlinks use the dark-blue connector link role.
- [x] The blocking update prompt moves keyboard focus inside, traps Tab traversal, and restores the prior control on close.
- [ ] A package built from the corrected exact HEAD shows `Clowder AI` (not `electron.app.Clowder AI`) in Windows Toast attribution.
- [ ] A fresh exact-head Windows package visually confirms the release-note layout, active-theme progress, and warm Ready to Install flow.

## Field round 10: straight-line check results and durable presentation

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | In the real Windows `0.12.0-rc.1105.7` install, a manual check took unusually long to show anything, then displayed the old native “Update Available” MessageBox. The custom themed modal and the full release-note body were absent; only the release URL remained. Automatic detection appeared to produce no prompt. |
| **2. Evidence** | `desktop.log` records Web TCP acceptance/`Local` at `2026-08-04T09:22:30.473Z`, while Next does not log `✓ Ready` until `09:22:51.854Z`. `main.log` nevertheless records `startAll() done` at `09:22:30.720Z`, a committed renderer document and delivered capability at `09:22:32.167Z`, but never records accepted renderer readiness. The manual check starts at `09:22:50.852Z`, selects `v0.12.0` at `09:22:52.053Z`, and logs `Rendered update prompt did not become ready` exactly 15 seconds later at `09:23:07.068Z`. The native manager fallback contains the selected asset and URL but deliberately omits the renderer-only release-note Markdown, matching the screenshot exactly. |
| **3. Root cause** | Three layers encoded one simple operation. Service startup treated a TCP accept as Web readiness and created BrowserWindow before the current Next document was HTTP-ready. The document-capability protocol then required a separate main delivery and preload acknowledgement that never reached its accepted state in the field run. Finally, a presentation timer converted the still-valid pending result into `undefined`, and `UpdateManager` interpreted that transport state as permission to construct a lower-fidelity native result. Release discovery and semantic comparison were healthy; the failure was entirely in presentation readiness and fallback policy. |
| **4. Diagnosis strategy** | Preserve one truth source: `fetchReleases()` → `selectUpdateTarget()` → one typed result. Encode the six automatic/manual outcomes as a manager matrix first. Replace the token/capability/timer protocol with one trusted-current-main-frame `desktop-update:ready` invoke whose response is the pending payload or `null`; subscribe before invoking so both event and response paths are lossless. Require an actual HTTP response before declaring packaged Web ready. |
| **5. Timeout strategy** | No ordinary update-check presentation timeout remains. A valid result stays pending until the trusted renderer dismisses or acts on it, survives navigation/process loss, and is returned on the next readiness invoke. Network request timeouts remain owned by the existing release fetcher; download/install recovery dialogs remain unchanged. |
| **6. Early warning** | Reintroducing a document token, readiness capability delivery channel, presentation timer, or native fallback for `available`/`up-to-date`/`check-failed` means the implementation has left the straight-line contract. Treating a bare TCP accept as a usable Web document is the startup form of the same error. |
| **7. User-visible correction** | Automatic checks show the custom AppShell prompt only when a newer non-skipped release exists; no-update and failure are silent, with failures logged for the next scheduled retry. Manual checks always show one themed result: the full available-release surface, an up-to-date confirmation, or a failed-check result with “View Releases”. Reloading the AppShell cannot discard the pending result. |
| **8. Acceptance** | RED produced 17 focused desktop failures and 3 focused renderer failures across the new behavior matrix, HTTP readiness, pending-response replay, new prompt kinds, and removal of native update-result fallback. GREEN passes 69/69 focused desktop tests and 17/17 prompt/progress component tests. Complete quality gates, independent review, exact-head CI/package build, and real Windows acceptance remain required before `.7` is replaced. |

### Prompt state contract after round 10

| Prompt kind | Visible trigger | Admitted actions | Presentation recovery |
|---|---|---|---|
| `available` | automatic or manual newer release | `download`, `later`, `skip`, `open-release` | retained in main and returned by trusted readiness invoke; no native check-result fallback |
| `up-to-date` | manual check with no newer release | `dismiss` | retained/replayed until dismissed |
| `check-failed` | manual fetch/refresh/parse failure | `dismiss`, `open-release` | retained/replayed; canonical Releases URL is main-owned |
| `ready-to-install` | verified download | `install`, `later` | existing native install confirmation remains available only if renderer presentation is unavailable |

Automatic no-update and failure outcomes create no prompt transaction. The renderer still never receives the installer path, digest, journal, service controls, or spawn capability.

## Architecture ownership

- **Architecture cell:** `hub-action-surface`
- **Map delta:** none
- **Why:** this correction extends the existing desktop-updater projection into the existing AppShell surface. It adds no service, persistence owner, queue, router, adapter, dispatcher, or network boundary. Main remains the sole transfer owner; preload and React receive a read-only last-value snapshot.
