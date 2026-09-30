# F229 Cat Ball scroll browser evidence

Source revision: `8de7e8c52ad1ece136082d8a332566303f7cc30d` (PR #1546, scrolling-only revision including the anchored widget-layout P1 fix; screenshots recaptured before this artifact commit).

Run: `node --test packages/web/test/browser/f229-cat-ball-scroll-evidence.test.mjs` with a Playwright module available through `F229_PLAYWRIGHT_MODULE` when the public checkout does not contain `packages/ppt-forge`. The test starts its own Next dev server on an available localhost port, uses headless Chromium, and stops the server afterward. It uses synthetic thread/message data and intercepts API requests; no user data or live OpenCode invocation is involved.

The fixture mounts the real full `ThreadChatSurface` for selected thread A and the AppShell's real `ConciergePanel` for background thread B. The test checks:

1. [Before jump](artifacts/01-before-jump.png): B is scrolled upward and its `到最新` button is visible while A is at `scrollTop=220`.
2. [After jump](artifacts/02-after-jump.png): clicking B's button brings B within 120px of its bottom; A remains at 220.
3. [After append](artifacts/03-after-append.png): a new B message appears at the bottom and B follows it; A remains at 220.
4. [After full remount](artifacts/04-full-remount-restored.png): after unmounting and remounting A, its `scrollTop` is restored to 220.
5. [Full widget disclosure](artifacts/05-full-widget-compact-preserved.png): expanding and collapsing the real full-A HTML widget leaves B's reading offset at 600.
6. [Compact widget disclosure](artifacts/06-compact-widget-full-preserved.png): expanding and collapsing the real compact-B HTML widget leaves A's reading offset unchanged.
7. [Reading remount after widgets](artifacts/07-widget-reading-remount-restored.png): remounting A restores its post-disclosure reading position while B retains its own post-disclosure offset.

The exact source-revision run passed 1/1 Chromium test.

The widget snapshots include their originating chat container before layout can detach the anchor. The hook ignores foreign and stale-container events before cancelling restoration or updating scroll memory. Unit regression coverage runs full→compact and compact→full, with attached and removed local anchors, then remounts both surfaces and replays a delayed event from the old container. These four cases failed on `2a41b050d` with the foreign offset copied into the other surface, then passed after the fix. Scroll-memory now passes 22/22; the selected scroll, thread-switch, teleport, pagination, scoped-selector and HTML-widget suites pass 84/84.
