# Review Request: F237 Phase 1 — Prompt Injection Visibility

Review-Target-ID: f237
Branch: feat/f219-injection-visibility

## What

Make Cat Cafe's 52 prompt injection segments visible, controllable, and classifiable through:

1. **Manifest registry** (`assets/prompt-injection-manifest.yaml`) — 52 active + 1 legacy segments with full schema (id/category/lifecycleStage/source/sourceType/trigger/purpose/userExplanation/priority + three-axis classification)
2. **Template extraction** — S6 (workflow triggers), S13 (MCP tools), D8 (A2A ball check), D21 (handoff decision tree) moved from hardcoded .ts constants to external template files with `.local` overlay support
3. **Console UI panel** — Full manifest viewer with category grouping, three-axis badges (safety/transparency/governance), inline template editor with preview/save/reset, per-cat dimension filtering
4. **Hook management** — H1/H2/H3 hook panel with health status, one-click sync, config drift detection
5. **Safety enforcement** — readonly segments (D8/D21) return 403 on override attempts; `.local` overlay files gitignored

## Why

Issue #839: thread_mpuxhppp0vzl2y16 中 opus47 被 startup hook 注入的杂物警告带跑偏，review 球丢地上。根因：33 个注入段散落在 SystemPromptBuilder + route + hooks 里，用户不知道猫收到了什么，出了问题无法定位。

从 Mythic Trust（迷信式信任）→ Epistemic Trust（认知式信任）：完整可见性 → 可审计性 → 可观测性 → 用户敢委托/扩展自治。

## Original Requirements（必填）

> "Cat Cafe 的治理能力越来越强（hooks / L0 prompt / skills / dispatch / authorization），但这些能力对用户**既不可见也不可控**"
> "不可见：33 个注入段散落在 SystemPromptBuilder.ts + route-serial.ts + route-helpers.ts + shell hooks 里，没有统一 manifest，用户无法知道猫收到了什么"
> "H1 Startup Hook + H3 Stop Hook：两者都有 '向铲屎官汇报/商量处理方式' 抢球权措辞。核心修复是默认降级为 diagnostic notice"

- 来源：`docs/features/F237-prompt-injection-visibility.md` (Why section) + Issue #839
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

- **Phase 1 只提取 4 个段到模板**（S6/S13/D8/D21），其余留原位。理由：这 4 个段有最高编辑需求（S6/S13 allowLocalOverride: true）或最高可见需求（D8/D21 readonly 但用户应能查看球权规则）。Phase 2 会把更多段迁移到 lifecycle handler。
- **Per-cat 过滤用启发式 trigger 匹配**而非精确 runtime 模拟。理由：精确模拟需要完整 invocation context，Phase 1 做不到，启发式覆盖主要场景（MCP = Claude-only, always-on segments）。
- **Hook enable/disable 通过 sync API 而非 direct config write**。理由：不直接改 `~/.claude/settings.json`，遵守 Config Immutability 铁律。

## Architecture Ownership（必填）

Architecture cell: `harness/system-prompt-injection` + `action-plane/settings`
Map delta: none
Why: 扩展现有 Settings UI 模式（F190/F199/F206 基础）+ 现有 SystemPromptBuilder 注入路径。无新建并行架构组件。

请 reviewer 检查：
- diff 是否与 `Map delta` 一致
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`
- 若修改 `docs/architecture/ownership/cells/*.md`，是否确实改变了 owner / boundary / extension point / canonical anchor

## Open Questions

### 技术 OQ（给 reviewer）

1. **`isSegmentActiveForCat()` 启发式准确度**：`CatDimensionSelector.tsx` 中的 trigger 匹配是字符串 heuristic。请审查是否有明显误判场景（比如某些 conditional segments 被错误地标记为 always-active）。
2. **Template loader 线程安全**：`prompt-template-loader.ts` 中 `resolveWithOverlay()` 每次调用都 `readFileSync`。在并发 invocation 场景下是否有文件读取竞争问题（虽然 Node.js 是单线程但 overlay 可能被 Console API 同时写入）。
3. **Overlay .bak 回滚只保留一版**：PUT override 时创建 `.bak` 备份，但只保留最近一次。是否应保留历史版本？（倾向 P2——Phase 1 先 ship 单版本回滚）

### 价值 OQ（给 CVO，如有）

无——技术选择已自决，回滚成本低。

## Next Action

请 @codex 做跨族 review：
1. 代码质量 + 安全性
2. 原始需求覆盖度（对照 Why section）
3. 三轴分类合理性（manifest YAML 中 safetyTier/transparencyTier/governanceTier 分配）
4. 技术 OQ 1-3

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f219/codex`
- Start Command: `pnpm dev`（或 `pnpm review:start`）
- Ports: web=3201, api=3202（需 `.env.local` 覆盖）

## 自检证据

### Spec 合规

Quality Gate 通过。12 条 AC 全部 ✅（AC-Trust 待铲屎官体验测试）。
详见上方 Quality Gate Report。

### 测试结果

```
pnpm test           → 2 failures (pre-existing: signal-fetcher-launchd.sh missing, 非 F237)
pnpm lint           → 0 errors (pre-existing warnings only)
pnpm biome check    → 0 errors, 3296 files checked
pnpm build          → exit 0
check-manifest-drift.mjs  → "All aligned. No drift detected."
verify-template-extraction.mjs → "All 4 templates produce identical output"
```

### 相关文档

- Spec: `docs/features/F237-prompt-injection-visibility.md`
- Issue: https://github.com/zts212653/clowder-ai/issues/839
- Feature: F237 / Phase 1
