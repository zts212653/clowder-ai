# r3b39 · 独立的路由删除改动

本清单与绑定／数据生命周期改动分开审阅、分开提交；本轮没有 git add、commit 或 push。

## 删除依据与范围

用 TypeScript AST 对静态 import／export、import type、字面量 dynamic import／require 做一次 import walk；包括 `@/`、loader 引用及星球 frame 的 presence alias。没有添加常驻检查、lint 规则或防再犯机制。

保留入口：

- `src/app/layout.tsx`
- `src/app/(chat)/layout.tsx`
- `src/app/(chat)/page.tsx`
- `src/app/(chat)/thread/[threadId]/page.tsx`
- `src/app/frames/starry/route.ts`
- `src/app/story/[storyId]/public/page.tsx`（r3b41 已改成本页字体／颜色值，见下）

删除的是这些入口不再引用的旧路由和专用生产文件，以及仅测试这些已删界面／模块的测试与浏览器 fixture。完整删除文件清单：[route-deletion.files](route-deletion.files)。共 **1383 个删除路径，19 个旧路由（18 个 page、1 个 dev route）**。纯数据 writer／helper 被当前宿主或 frame 引用的继续保留；没有按目录名整批删。

删除的路由：

- `src/app/dev/f294-html-widget-responsive-export/delayed-image/route.ts`
- `src/app/collective/page.tsx`
- `src/app/memory/catalog/page.tsx`
- `src/app/memory/graph/page.tsx`
- `src/app/memory/health/page.tsx`
- `src/app/memory/page.tsx`
- `src/app/memory/preview/page.tsx`
- `src/app/memory/search/page.tsx`
- `src/app/memory/status/page.tsx`
- `src/app/mission-control/page.tsx`
- `src/app/mission-hub/page.tsx`
- `src/app/mission/page.tsx`
- `src/app/settings/page.tsx`
- `src/app/signals/page.tsx`
- `src/app/signals/sources/page.tsx`
- `src/app/starry/page.tsx`
- `src/app/story-export/grep-hippocampus/page.tsx`
- `src/app/story-export/page.tsx`
- `src/app/story/[storyId]/page.tsx`

`src/app/starry/page.tsx` 的实现逐字节搬到 `src/starry/page.tsx`，frame entry 改为引用它；旧 `/starry` 页面入口删除，`/frames/starry` 保留。搬前／搬后字节比较为 `True`。星球 iframe 内还需要的 React 组件和 CSS 属于保留入口，不是 console document 的全局 CSS。

## 静态核对结果

```text
consoleFiles: 502
keptFiles: 640
components: 388
oldRoutes: []
unreachableComponents: []
```

`components` 统计 `src/components` 下非测试的生产 TS／JS 文件；保留的全部可由上述入口到达。测试 fixture 不当作生产组件。这个核对是静态字面量 import walk，不冒充浏览器验收。

console 可达的全部 JSX：

| 文件 | JSX 标签 |
| --- | --- |
| `src/app/(chat)/layout.tsx` | `SessionBootstrap`, `Suspense`, `AppShell` |
| `src/app/layout.tsx` | `html`, `body`, `script` |
| `src/components/AppShell.tsx` | `PdlAppHost` |
| `src/components/thread-chat/ThreadChatRuntimeProvider.tsx` | `ThreadChatHistoryAdmissionContext.Provider`, `ThreadChatHistoryAdmissionProvider`, `ThreadChatRuntimeContext.Provider` |
| `src/components/workbench/WorkspaceSurfaceVisibility.tsx` | `WorkspaceSurfaceVisibilityContext.Provider` |
| `src/pdl/PdlAppHost.tsx` | `ThreadChatRuntimeProvider`, `div`, `ChatBinding`, `ComposerOwnerBinding`, `ProjectDataBinding`, `ScheduleRecordBinding`, `ProposalRecordBinding`, `MemoryMessageOwnerBinding`, `CloudRecoveryOwnerBinding`, `RuntimeRecordBinding`, `FirstMessageBinding` |
| `src/pdl/ProjectDataBinding.tsx` | `ReviewOwnerBinding`, `DocumentOwnerBinding` |

layout 只建文档；AppShell 指向宿主；其余是 providers、返回 null 的数据 owner 和唯一引擎根 `div`。没有旧 React 界面在 console entry 的可达图里画 UI。frame／公开分享页面各有自己的界面，不在 console entry 的图里。

## 单独删除改动要一起带上的文件／hunk

- 上述完整删除清单。
- `src/app/layout.tsx`、新增 `(chat)/layout.tsx`、`(chat)/page.tsx`：移除 console 的旧全局样式／injector／provider 包装；providers 只留在 chat group。
- `src/starry/entry.tsx`、新增 `src/starry/page.tsx`：保留星球 frame 的实现。
- `src/hooks/useDeploymentWaitProjection.ts` 的 `DeploymentWaitHydration` 类型，以及 `src/pdl/useTerminalBindings.ts` 的 `AgentPane` 类型 hunk：类型不再来自已删 UI。
- `scripts/vendor-stylesheets.mjs`、`scripts/sync-vendor-assets.mjs`、`src/generated/vendor-stylesheets.json`：撤全局 vendor xterm 样式；app CSS 仍供独立 starry frame 使用。终端平台口的本地 CSS import 属于终端绑定改动。
- `package.json`：测试命令移除已删界面 fixture 的入口，smoke 改跑现有 `src/pdl`；保留的真实浏览器/API测试没有为失败改断言。
- `src/app/__tests__/layout-stylesheet-identity.test.tsx`：验证 console document 不再装旧全局 stylesheet。
- `components/capability-evolution/__tests__/fixtures/{demo-data,demo-conditions,exploration-data}.ts` 与两个行为测试 import：保留探索比较／决策行为测试的数据，脱开已删 UI。
- `components/shell/__tests__/mailbox-filtered-counts.test.ts` 的 type-only session-auth import：继续给仍在使用的真实 API 测试装载 Fastify 类型扩展，不靠被删 UI 测试的偶然 import。

其中 `useTerminalBindings.ts` 同时有终端 io 改动；按 hunk 拆分，不把两层改动混在一起。

## public story 与保留的边界

`story/[storyId]/public/page.tsx` 的全部直接 imports：

- React 的 `useEffect`／`useState`；
- `next/navigation` 的 `useParams`；
- `@cat-cafe/shared` 的 `deploymentDefaults`（纯配置）；
- `../parseStoryId` 的 `decodeStoryParam`（纯工具）。

本地可达图只有 public page 和 `parseStoryId.ts`，没有与 console 或已删路由共享 React 界面。r3b41 按 lang 决定将 inline styles 的旧 `--console-font-*` 与颜色／等宽字体变量替换成本页值（颜色沿原 fallback），现在不再引用 console／全局 CSS 变量，保留为自包含的公开分享页；没有另画分享页或恢复旧组件。

保留的真实浏览器流程仍可能含旧 DOM selector；本轮没有为这类失败改生产绑定或测试。只有可证实仅服务已删组件的 fixture／测试进入删除清单。
