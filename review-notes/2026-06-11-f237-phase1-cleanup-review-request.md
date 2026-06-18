# Review Request: F237 Phase 1 — Console Prompt Injection Visibility Cleanup

Review-Target-ID: f237
Branch: feat/f219-injection-visibility

## What

Console "协作与规则" settings page 的全面视觉 + 功能性清理（60 commits, 99 files, +5697/-823）。本次 Phase 1 cleanup commit (`40c60e58d`) 是最新一轮 CVO 验收驱动的修改，涵盖：

**视觉层次**：
- OKLCH 層4/層3/層2 嵌套深度层次体系，所有组件统一阴影
- 新增 `--console-elevated-bg` token（層3），LifecycleFlowDiagram / SegmentRow / L0 模板 / RuleFileCard 统一使用
- 删除生命周期图中多余的 ↻ 循环图标

**内容组织**：
- L0 模板卡片通过 `slotAfterCarrier` prop 定位到 carrier info 下方
- CarrierInfoPanel 从卡片改为纯文本注释
- session-init / carrier / L0 模板三处描述文案去冗余
- 编译预览弹窗增加注释图例

**功能**：
- Hook 脚本预览：API 读取 H-prefixed 段的 `.sh` 文件并在 readonly modal 展示
- Hook resolver 提取到 `prompt-injection-hooks.ts`（350 行限制）
- 目录路径防御（H2 PostCompact 无独立脚本，不 crash）
- X1 遗留段从 manifest 物理删除

## Why

CVO 在验收过程中逐项驱动的视觉和功能改进。核心目标：让 prompt injection manifest 的 Console 展示达到可交付质量——层次清晰、信息不冗余、hook 脚本可预览。

## Original Requirements（必填）

> "生命周期/会话循环/事件驱动/L0系统提示词等等这些本身的阴影也要补齐；然后agent规则那边的卡片和内层的嵌套卡片也要准守这个规则"
> "hook脚本预览这个我们能当前阶段做么"
> "遗留那个直接物理删除？"
> "注入位置: 这个应该是注释不应该用卡片的"
> "L0 系统提示词模板是在L0 系统提示词上面 和注入位置下面"

- 来源：当前 thread 直接对话（F237 Phase 1 验收）
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

- H2 (PostCompact) 没有独立脚本文件，选择在前端 `isViewable` 层过滤（source 以 `/` 结尾 = 目录 = 不可预览），而非在 manifest 加 `viewable` 字段——避免 manifest schema 膨胀
- 阴影值（`rgba(43,33,26,0.04)` / `0.08` / `0.10`）直接内联在组件 style 中，未抽为 CSS variable——F056 Phase E 的 `cafe/no-hardcoded-colors` lint 规则已有 warning，但本 PR 不引入新值体系，留给专项治理

## Architecture Ownership（必填）

Architecture cell: harness/system-prompt-injection + action-plane/settings
Map delta: none
Why: 本 PR 是 F237 manifest/template 体系的 Console 展示层清理，不改变 injection 架构本身。新增 `prompt-injection-hooks.ts` 是路由层代码提取，非新架构概念。

请 reviewer 检查：
- diff 是否与 `Map delta: none` 一致
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`
- 若修改 `docs/architecture/ownership/cells/*.md`，是否确实改变了 owner / boundary / extension point / canonical anchor

## Open Questions

### 技术 OQ（给 reviewer）

1. **Hook resolver `statSync` 防御**：`prompt-injection-hooks.ts` 用 `statSync().isFile()` 区分文件/目录。是否需要 try-catch 包裹（symlink 等边缘情况）？
2. **manifest cache 无失效**：`loadManifestEntries()` 用模块级 `manifestCache` 做 lazy load 但无 TTL。manifest 在运行期不变，但 hot reload 场景是否需要考虑？
3. **`isViewable` 前端启发式**：`!s.source.endsWith('/')` 区分文件/目录。如果未来有 hook 段的 source 字段不以 `/` 结尾但也不是可读文件，需要更健壮的判断。

### 价值 OQ（给 CVO，如有）

无

## Next Action

请 reviewer 完整 review 本分支对 main 的全量 diff（99 files），重点关注：
1. 视觉层次是否一致（層4/層3/層2 嵌套规则）
2. Hook 预览 API 的安全性（路径拼接、manifest 解析）
3. 前端状态管理（slot threading、isViewable 逻辑）
4. 文案描述是否准确

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f219/codex`
- Start Command: `pnpm review:start`
- Ports: `web=3201`, `api=3202`

## 自检证据

### Spec 合规

CVO 逐项验收驱动，每项改动有铲屎官原话可追溯。

### 测试结果

- `pnpm lint` → 0 errors（仅 pre-existing warnings）
- `pnpm biome check . --diagnostic-level=error` → 0 errors
- `pnpm test` → 1 pre-existing failure（`signal-fetcher-launchd-script.test.js` — 缺失 `scripts/signal-fetcher-launchd.sh`，与本 PR 无关）
- `pnpm check:followup-tails` → 1 pre-existing failure（revert commit "out of scope"，与本轮 cleanup 无关）

### 相关文档

- Feature: `docs/features/F237-prompt-injection-visibility.md`
- Manifest: `assets/prompt-injection-manifest.yaml`
- Issue: [#839](https://github.com/zts212653/clowder-ai/issues/839)
