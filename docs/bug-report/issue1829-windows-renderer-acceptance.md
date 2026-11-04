---
tips_exempt: "Performance correction to existing work counters; no new user operation or entrypoint."
---

# Windows 桌面作品刷新风暴：修复与验收

公开来源：[缺陷 #1829](https://github.com/zts212653/clowder-ai/issues/1829)、[现场问题 #1813](https://github.com/zts212653/clowder-ai/issues/1813)、[本修复 PR #1839](https://github.com/zts212653/clowder-ai/pull/1839)、[先前修复 #1820](https://github.com/zts212653/clowder-ai/pull/1820)。
本报告记录 Windows 桌面作品刷新缺陷的修复与验证，目标分支为 `next`。

Architecture cell: hub-action-surface
Map delta: none
Why: 只修正现有作品投影的刷新依据，不改变投影来源或桌面进程职责。

## 桌面适用性与修复决定

安装版 `desktop/main.js` 创建 `BrowserWindow`，运行 `preload.js`，加载桌面网关提供的 Next 生产前端。
`HeaderCounts → useThreadArtifacts → useWorksSourceRefresh` 在 Electron renderer 中执行。
`touchStreamActivity` 以及批量流写入会更新消息的活动 `timestamp`；该字段原先进入作品的 `materialKey`，导致每个文本片段取消旧读、重新读取作品。
#1820 处理历史消息行渲染及日期格式器分配，没有修改这条作品刷新路径。

砚砚与宪宪讨论后采用的改动：从 `materialKey` 移除 `timestamp`，保留消息 ID、`isStreaming`、`hasActive`、rich 材料和非文本块。
补充反例发现，`useThreadMessages` 还按显示时间排序：两个尚无 lifecycle 快照的并发回复交替更新活动时间，会交换 ID 顺序，间接改变 key。
因此作品刷新改用现成的 `selectThreadMessagesRaw`，排除活动时钟造成的显示重排；UI 仍使用原有显示排序。
不修改消息时间或游标，不添加防抖，不关闭页头作品计数。
`materialKey` 比较序列化后的内容，rich 对象重新分配但内容相同本身不会触发刷新。

## RED / GREEN

新测试挂载真实 `ThreadWorksButton`，通过生产 `writeStreamText` 和 `touchStreamActivity` 输入 20 个片段。

- 修复前：期望 1 次作品读取，实际 21 次，测试失败；其他两项既有语义回归通过。
- 修复后：20 个片段只保留首次读取；消息文本、活动时间和时间线游标均继续更新。
- 并发反例：只移除时间戳时，两个无 lifecycle 快照的回复交替 20 个片段，仍是期望 1 次、实际 21 次；改读原始线程快照后为 1 次。
- 补充验证：rich、新消息、非文本材料、流结束、调用激活/结束、显式投影失效仍刷新；切换线程重新读取，旧线程继续产出不会刷新新线程作品。

命令（工作目录 `packages/web`）：

```powershell
pnpm exec vitest run src/components/shell/__tests__/header-works-streaming.test.tsx src/hooks/__tests__/useThreadArtifacts-scope.test.tsx src/hooks/__tests__/useGlobalArtifacts-loading.test.tsx src/hooks/__tests__/usePagedGlobalWorks.test.tsx --maxWorkers=1
```

结果：4 个文件，21 项通过。现有 scope 测试的 selector mock 随读取边界调整，覆盖原来的失败撤回与跨线程读隔离。
完整 Web 类型检查先需要构建 API：测试引用其 `dist`；缺失产物时的 TS2307 不代表产品源码失败。

## Windows Electron 对照

2026-11-04 在同一 Windows 主机运行 Electron **35.7.5 / Chromium 134.0.6998.205**，未关闭 sandbox。
两组使用同一测试入口、真实 `BrowserWindow`、原 `preload.js`、原 `runtime-web-server.js` 和真实静态资源。
保留 PWA、IndexedDB、context isolation 和默认 Node 隔离；使用独立 profile、回环随机端口、synthetic HTTP/Socket.IO API。
没有访问当前运行态业务 API、Redis、用户数据或真实模型。

| 文本片段（间隔 30ms） | 旧安装包前端 | 修复前端 |
| --- | ---: | ---: |
| 浏览器作品请求 | 40 | 1 |
| 单猫 40 片段作品请求取消（多次采样） | 38–39 | 0 |
| 双猫再交替 40 片段的作品请求 | 40 | 0（已有消息） |
| 双猫交替的作品请求取消 | 39 | 0 |
| pageerror / console warning | 0 / 0 | 0 / 0 |

旧组：安装包 `.build-commit=faaa1b000ebe0dc6da2aa4c7c09fa80c5be5da43`，BUILD_ID=`uYY9fMzghPPducJ5UgUyR`，已包含 #1820。
首次单猫修复组：`.build-commit=a33d8c8988c9832166f00fe96ffbb413afc2c199`，BUILD_ID=`tTBgY5iA1QvyDkqd0YXhp`。
补齐并发反例后，以 `CAT_CAFE_WEB_BUILD_REVISION=170fed6e1e3c4a7df5edc7a3ca15dcf9db53c11c` 固定提交完整重建；嵌入配置和 `.build-commit` 一致，桌面加载器校验通过。
最终对照产物为 `baseline-1793778416030` / `fixed-1793778889498`，构建身份及实际端口写入各自 `result.json`。
该提交后的变更只有回归测试、验收工具与本文档，产品代码与采样构建保持一致。

完整隔离旅程：首次新对话初始化 → 点击 A 并显示 A 的历史 → 接收流式输出 → A 持续后台输出时点击 B → B 历史取代 A → 在 B 输入草稿 → A/B 往返并恢复 B 草稿 → 点击新对话 → 输入 `@` 显示成员 → 正常输入，composer SVG 图标和成员头像资源可用。
fixture 成员含必需 `carrier`，未替换顶层 AppShell、页头或新对话组件。

初次完整对照的最大 long task 为旧组 199ms、修复组 190ms；最终双猫及后台切换对照为旧组 142ms、修复组 147ms，也没有复现秒级 long task。
最终修复组 A/B 点击到目标历史显示约 469–576ms，新页完成输入及接收成员解析为 1337ms；旧组 A/B 为 923–1906ms，新页 511ms。构建/测试负载、冷缓存及新页成员等待均影响单次数字，不将它们视为性能提升证据。
这些合成数据及单机时延不能证明现场数秒冻结已消失。CPU profile 保留供审阅，不据此宣称完整性能改善比例。

复现命令（先按锁文件安装工作区依赖）：

```powershell
$env:CAT_CAFE_DESKTOP_WEB_BUILD='1'
pnpm --filter @cat-cafe/web build
# 指向与 desktop/package.json 相同版本的独立 Electron，不能指向已安装的 Clowder AI.exe。
$env:ELECTRON_EXECUTABLE='C:\path\to\electron.exe'
node desktop/test/issue1829-electron-profile.mjs fixed
# 可选：对一个已经构建且带 desktop build stamp 的旧前端运行同一旅程。
$env:ISSUE1829_WEB_ROOT='C:\path\to\baseline\packages\web'
node desktop/test/issue1829-electron-profile.mjs baseline
```

输出默认进入系统临时目录 `cat-cafe-evidence/issue1829/`；可用 `ISSUE1829_EVIDENCE_DIR` 指定证据目录。
每次保留 `result.json`、`observations.json`、renderer CPU profile、截图、服务器日志及隔离 profile。
profile 为纯测试数据；测试退出会关闭自身 Electron、网关、Socket.IO 和 API。

fallback 检查只命中测试工具：CORS 头默认值、fixture 默认响应和三个独立 CLI/env 默认值，不是产品多层恢复链；产品没有新增 fallback。

## 自检与剩余边界

行为风险：作品刷新遗漏，已按材料及生命周期测试；数据/安全/契约/不可逆风险：无新增产品变更。
生产前端构建及 PWA cache policy 通过；完整 lint、类型检查和相关测试按 PR 的本轮回执核对。
`next` 当前未提供 skill 中提及的 `check:architecture-ownership` 命令，保留此工具缺口；本次没有架构边界变化。

**真实原现场完整旅程尚未验收恢复。** 这组 Electron 测试证明请求放大缺陷在桌面成立且已消除，无法确认原用户 profile 的历史规模、缓存、主进程 IPC/托盘/ServiceManager 或首次安装行为。
两组都没有重现现场数秒冻结，也未定位截图里成员/输入框迟迟未完成初始化的全部原因。
#1813 保持打开；本 PR 只修复 #1829，不把“窄缺陷已修”写成“原现场已恢复”。
未合并、未替换当前安装包。真实安装包恢复验收需要包含本修复的安装产物及相同操作时段的 renderer trace，再沿 #1813 核对。
