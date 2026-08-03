# Review Request: Windows Markdown 链接打开右侧 Workspace 文件

Review-Target-ID: fix-523-windows-workspace-links
Branch: fix/523-windows-workspace-links
PR: https://github.com/zts212653/clowder-ai/pull/1281
Implementation commit: 8cb009b3f6b7210e59a5f73ab8af7b8acf9374ce

## What

- 让 `react-markdown` 保留 `G:/...`、`G:\\...`、`/G:/...` 形式的 Windows 绝对文件路径，同时继续过滤危险协议。
- 点击消息中的蓝色文件链接时拦截浏览器导航，解析可选 `:line`，在右侧 Workspace 中切换到所属 worktree 并打开文件。
- 以大小写不敏感的最长根路径匹配归属 worktree；thread-scoped 列表找不到时，仅在当前项目边界内回退默认 worktree 列表。
- 刷新 scoped worktree 时保留已选中的目标 worktree，避免文件刚打开又被错误 worktree 覆盖。
- 新增组件与 hook 回归测试，覆盖路径解析、URL 安全、最长根匹配、fallback 边界和 refresh 稳定性。

## Why

Windows 路径先被 Markdown URL transform 清空或当作普通浏览器链接；即使成功切换到目标 worktree，后续 scoped refresh 还可能把选择重置并清空文件。结果是蓝色链接看似可点，右侧 Workspace 却没有打开对应报告。

## Original Requirements（必填）

> “没有打开，我要求的是，当我点击你蓝色的链接的时候，可以从右侧的workspace看到对应的文件被选中或者被直接打开。但是实际上效果并不符合预期。”
>
> F063 R13：“你们发的文本里的那些地址我点击 右边这里能打开吗？”

- 来源：当前 thread `thread_ms9yrbfwz4db9nde`
- Feature 真相源：`docs/features/F063-hub-workspace-explorer.md` AC-13 / R13
- **请对照上面的摘录判断交付物是否解决了 operator 的问题。**

## Tradeoff

- 没有把所有未知 scheme 放行，只在 custom URL transform 中识别 Windows 绝对路径，其余仍交给 `defaultUrlTransform`，保留协议安全边界。
- 没有依赖当前 thread 的单一 worktree 列表，因为报告位于另一个 worktree；改为 scoped miss 后查询默认列表，但使用 `currentProjectPath` 限制回退，避免跨项目闪跳。
- 没有重写 Workspace 导航/store 架构；改动限定在 Markdown 链接适配、worktree 归属解析和既有 hook 的 refresh 稳定性。

## Architecture Ownership（必填）

Architecture cell: `hub-action-surface`
Map delta: none
Why: 修复现有 Markdown → Workspace 导航链路，不改变 owner、boundary、extension point 或 canonical anchor，也未新建 Store / Queue / Router / Adapter / Dispatcher / Binding。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- `workspace-md-components.tsx` 的 URL transform 是否只额外保留 Windows 绝对路径；
- 默认 worktree fallback 是否严格受当前项目路径约束；
- hook refresh 是否能保留目标 worktree 且不污染其他 thread 的状态。

## Open Questions

### 技术 OQ（给 reviewer）

1. `:line` 解析与 Windows drive colon 是否在所有支持形式下无歧义？
2. 大小写不敏感的最长 root 匹配是否覆盖嵌套 worktree，且不会越过目录边界？
3. scoped → default fallback 与 refresh preservation 是否存在竞态或 stale-state 风险？

### 价值 OQ（给 operator）

无。

## Next Action

请 `@opus` 对 review 发起消息中所附的 exact PR HEAD：

1. 按 hotfix 规则执行跨个体 quality-gate；
2. 独立复核 diff、回归测试和真实浏览器路径；
3. 将 `APPROVE` 或 `REQUEST-CHANGES` verdict 及覆盖 SHA 作为 PR comment 落到 PR #1281。

重点关注 URL 安全、项目边界、worktree refresh 稳定性，以及是否真正满足 F063 AC-13/R13。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/fix-523-windows-workspace-links/opus`
- Start Command: `pnpm review:start`
- Ports: `web=3201`, `api=3202`（禁止 3003/3004/3011/3012/4111）

### 沙盒 Bootstrap

PowerShell 下先清理继承环境并安装依赖：

```powershell
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
```

## 自检证据

### Spec 合规

- F063 AC-13：点击猫猫消息中的文件路径，自动切换 Workspace 并打开文件。
- R13：点击文本地址后，右侧 Workspace 能打开对应文件。
- Dogfood：在 `http://localhost:3013/thread/thread_ms9yrbfwz4db9nde` 点击 `综合报告` 后 URL 不变；右侧选择 `research-harness-landscape-20260801`，显示 `synthesis.md` 和标题 `Coding Agent Harness`。
- 截图：`C:\Users\Administrator\AppData\Local\Temp\cat-cafe-evidence\fix-523\windows-workspace-link-post-build.png`
- `.pen` 匹配：无；这是既有交互的 bugfix，无视觉设计改动。
- Artifact hygiene：工作树与提交差异均无根目录媒体/设计工件。
- 当前 checkout 中 `check-hotfix-pattern`、`check-fallback-layers`、`check-architecture-ownership` 脚本不存在；hotfix 限制已人工识别并升级为跨个体 gate。

### 测试结果

```text
相关 Web 回归：4 files，93 tests passed
Web TypeScript：通过
6 个改动文件 Biome：0 errors
pnpm lint：exit 0，仅既有 warnings
pnpm check:features：通过
pnpm check:capability-tips：通过
pnpm check:followup-tails：通过
production Web build：exit 0，22/22 页面生成成功
CI Lint / Build / Windows Smoke：通过
```

已知基线阻断：

- 根 `pnpm check`：Windows checkout 的 4,505 个未修改 CRLF 文件被 Biome 判定需转 LF；本 PR 六个文件单独检查全绿。
- 根 `pnpm test`：API package 使用 POSIX 内联 env 赋值，PowerShell 在测试启动前报错。
- Web 全量 Vitest：21 个与 `upstream/main` 一致的既有失败，集中在 Artifacts、Skills、Thread Organizer、Story Player，均不引用本 PR 模块。

## 相关文档

- Feature：`docs/features/F063-hub-workspace-explorer.md`
- Issue：https://github.com/zts212653/clowder-ai/issues/523
- PR：https://github.com/zts212653/clowder-ai/pull/1281

[砚砚/GPT-5.6-sol🐾]
