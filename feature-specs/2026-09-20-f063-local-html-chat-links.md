---
feature_ids: [F063]
topics: [workspace, chat-links, desktop, local-html]
doc_kind: implementation-plan
created: 2026-09-20
---

# F063 Local HTML Chat Links Implementation Plan

**Feature:** F063 — `docs/features/F063-hub-workspace-explorer.md`
**Goal:** 猫猫消息中的本地 HTML 文件链接点击后，在不越过 Workspace 安全边界的前提下用系统默认浏览器打开，保留离线报告的相对资源与页内跳转。
**Acceptance Criteria:** AC-4 消息中的文件路径可点击；AC-5 HTML 可直接展示；AC-7 不能访问注册 Workspace 之外的系统文件；AC-13 点击猫猫消息中的文件地址可到达真实内容。
**Architecture cell:** `hub-action-surface`
**Map delta:** none
**Map delta why:** 这是 F063 已有 chat → Workspace/preview 动作的缺口修复，不新增独立 owner、持久化或布局面。
**Architecture:** Web 只把 `.html/.htm` 本地文档链接提升为 typed Workspace target；Electron main frame 通过窄 IPC 请求打开该 target。API 以已注册 worktree/linked root 为唯一边界，返回已校验的 canonical absolute path，由 Electron `shell.openPath` 交给默认浏览器。普通 HTTPS 链接与 Markdown Workspace 链接保持现有语义。
**Tech Stack:** React/ReactMarkdown, Fastify, Electron context-isolated IPC, Node test/Vitest
**前端验证:** Yes — 组件点击回归 + Electron controller 端到端边界测试 + 实际离线报告路径 dogfood

---

## Straight-line finish line

**B definition:** 在桌面版猫咖中点击
`[report](</registered/workspace/report/index.html>)` 会打开真实本地文件，
且任何未注册路径、非 HTML 目标、子 frame 或伪造 sender 都不能达到
`shell.openPath`。

**Not building:** 不放开任意 `file://` URL，不增加通用任意文件启动器，不用
API 同源 HTTP 服务器执行 workspace HTML，不改变外部 HTTPS 链接的系统浏览器语义。

**Terminal schema:**

```ts
interface OpenWorkspaceHtmlRequest {
  worktreeId: string;
  path: string;
}

type OpenWorkspaceHtmlResult = { ok: true } | { ok: false; error: string };

interface ResolvedOpenableWorkspaceHtml {
  absolutePath: string;
}
```

本修复不引入有生命周期的新状态对象；链接分类、安全解析与 IPC 结果都是单次纯投影/请求。

### Task 1: Capture the broken chat-link behavior

**Files:**
- Modify: `packages/web/src/components/__tests__/chat-workspace-link.test.tsx`
- Modify: `packages/web/src/components/MarkdownContent.tsx`
- Modify: `packages/web/src/components/ChatWorkspaceLink.tsx`

1. Add a failing component test for the real absolute path form, including URL-escaped spaces, and assert it renders a local-action button rather than `target="_blank"`.
2. Add a failing test for a relative `reports/index.html` target inside the active project.
3. Keep regression assertions for HTTPS, protocol-relative URLs, `javascript:`, `file://`, paths outside registered roots, and existing `.md/.mdx` behavior.
4. Run:
   `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/chat-workspace-link.test.tsx`
   and record the expected RED: HTML still renders as a browser anchor / never invokes a typed local action.

### Task 2: Resolve only registered HTML targets

**Files:**
- Modify: `packages/api/src/domains/workspace/workspace-path-resolution.ts`
- Modify: `packages/api/src/routes/workspace.ts`
- Modify: `packages/api/test/workspace-project-context.test.js`
- Modify: `packages/api/test/workspace-navigation-auth.test.js`

1. Add RED tests proving `.html/.htm` can reuse the typed document resolver while non-document paths remain rejected.
2. Add a loopback-only internal route that accepts `{ worktreeId, path }`, resolves through `getWorktreeRoot` + `resolveWorkspaceFilesystemPath`, verifies a regular `.html/.htm` file, and returns its canonical absolute path.
3. Prove browser-origin/session calls, traversal, denylisted/symlink escape, directories, missing files, and non-HTML files fail before returning an absolute path.
4. Build and run focused API tests:
   `pnpm --filter @cat-cafe/api build && node --test packages/api/test/workspace-project-context.test.js packages/api/test/workspace-navigation-auth.test.js`.

### Task 3: Add a narrow desktop open bridge

**Files:**
- Create: `desktop/workspace-file-open-controller.js`
- Create: `desktop/workspace-file-open-controller.test.js`
- Modify: `desktop/preload.js`
- Modify: `desktop/preload.test.js`
- Modify: `desktop/main.js`
- Modify: `packages/web/src/desktop-bridge.d.ts`

1. Add RED tests for the typed preload call and main-process controller.
2. Require the current trusted main frame, exact `{ worktreeId, path }` shape, `.html/.htm`, successful internal API resolution, an absolute canonical response, and an empty `shell.openPath` error string.
3. Reject subframes, destroyed/foreign windows, malformed input, resolver non-2xx/malformed bodies, non-HTML canonical paths, and `openPath` failures; log only safe error text, never the local path.
4. Wire controller creation/disposal beside the existing desktop update controller without exposing generic `openExternal`, URL, or command execution.
5. Run: `node --test desktop/preload.test.js desktop/workspace-file-open-controller.test.js desktop/renderer-link-policy.test.js`.

### Task 4: Make the chat click use the trusted bridge

**Files:**
- Modify: `packages/web/src/components/ChatWorkspaceLink.tsx`
- Modify: `packages/web/src/components/MarkdownContent.tsx`
- Modify: `packages/web/src/components/__tests__/chat-workspace-link.test.tsx`

1. Preserve Windows absolute HTML hrefs through ReactMarkdown only as narrowly as current Markdown path preservation.
2. Resolve HTML to `{ worktreeId, path }`; on desktop invoke `openWorkspaceHtml`, while an ordinary browser falls back to the existing Workspace file surface.
3. Surface a small inline error on rejected/failed opens and preserve latest-click cancellation semantics for asynchronous absolute-path resolution.
4. Re-run the focused Web test and then `pnpm --filter @cat-cafe/web exec tsc --noEmit`.

### Task 5: Verify the real report and close the bug record

**Files:**
- Create: `docs/bug-report/f063-local-html-chat-links/bug-report.md`

1. Consolidate the debugging capsule and five-part bug report with the observed real target
   `/Users/josephnatsu/代码/AC Claw/抓包分析/hybrid-report-dogfood/index.html`.
2. Run changed-file formatting with the repository-confirmed command:
   `pnpm biome format --write <changed files>`.
3. Run focused Web/API/desktop tests, relevant typechecks, and `pnpm check` as the terminal repository gate.
4. Dogfood the exact click path in an isolated acceptance build: assert the system opener receives the validated canonical `index.html`, and verify the opened report can follow a relative link such as `ap6-busy-downlink.html`.
5. Commit with Why + identity signature, then enter `quality-gate` before requesting independent review.
