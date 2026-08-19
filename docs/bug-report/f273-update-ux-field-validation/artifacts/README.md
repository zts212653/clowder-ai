---
feature_ids: [F273]
topics: [desktop, updater, visual-validation]
doc_kind: verification
created: 2026-07-27
---

# F273 visual-test artifacts

Both PNGs are **test-only screenshots**, not evidence that the ordinary web application checks for desktop updates:

- `update-modal-v0.10.0-to-v0.12.0.png`: Windows Setup recommendation.
- `update-modal-macos-arm64-v0.10.0-to-v0.12.0.png`: macOS arm64 dmg recommendation.

The exact-head `DesktopUpdatePrompt` was mounted on an isolated Next.js server. Playwright injected a mock Electron `desktopBridge` and a v0.10.0 → v0.12.0 platform payload so the desktop-only modal could be inspected. Without that bridge, the normal browser component renders nothing; this boundary is covered by `DesktopUpdatePrompt.test.tsx`.

Together the screenshots verify:

- the final compact `max-w-lg` modal width;
- Windows shows only `ClowderAI-Setup-0.12.0.exe` and `Download Windows Setup`;
- macOS arm64 shows only `ClowderAI-0.12.0-arm64.dmg` and `Download macOS DMG`;
- neither prompt exposes the other platform's package;
- the main-owned canonical v0.12.0 release link;
- current version v0.10.0;
- Skip This Version and Later actions.
