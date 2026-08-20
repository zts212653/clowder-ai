---
feature_ids: [F273]
topics: [desktop, updater, browser-dogfood, visual-validation]
doc_kind: verification
created: 2026-07-28
updated: 2026-07-28
---

# F273 browser dogfood artifacts

These screenshots are isolated browser-harness evidence for renderer surfaces. They do not prove Windows Shell attribution or packaged Electron behavior.

| Artifact | Evidence |
|---|---|
| `f273-dogfood-01-modal-windows.png` | Warm Windows renderer modal at candidate `4e8aa1486`; superseded for color-role evidence by artifact 06. |
| `f273-dogfood-02-progress-0pct.png` | One in-AppShell progress card at transfer start. |
| `f273-dogfood-03-progress-42pct.png` | Main-owned intermediate progress projected in place. |
| `f273-dogfood-04-collapsed-85pct.png` | Collapsed progress presentation. |
| `f273-dogfood-05-retry-resurfaced.png` | Same-version retry visible after an idle boundary. |
| `f273-dogfood-06-theme-modal.png` | Current working-tree modal: cafe theme primary action and shared dark-blue version link. |
| `f273-dogfood-07-settings-auto-check.png` | Current working-tree System Settings card with the default-on automatic-check toggle. |
| `f273-dogfood-settings-toggle.webm` | Short System Settings interaction recording: ON → OFF → ON, without runtime or production data access. |

The visual harness used an isolated Next.js server on `127.0.0.1:4317` and a mock API on `127.0.0.1:4318`, with runtime ports and production Redis excluded. A typed mock `desktopBridge` supplied only the Electron-owned payload/preferences needed by each surface.
