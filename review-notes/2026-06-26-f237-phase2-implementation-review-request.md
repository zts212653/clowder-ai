# Review Request: F237 Phase 2 — 46-Hook Pipeline + Override Store + Injection Trace

Review-Target-ID: f237
Branch: feat/f237-phase2-hook-pipeline

## What

Complete Phase 2 implementation of F237 prompt injection visibility: a 46-hook pipeline that makes every prompt segment self-contained, dynamically manageable, observable, and versionable.

**14 commits**, **129 changed files** (93 hook manifests/templates + 15 source + 14 tests + 2 shared types + spec/notes), **53 tests**, **18 ACs** all covered.

Core deliverables:
1. **HookManifest + HookRegistry** (P2-A): 46 `hook.yaml` manifests under `assets/prompt-hooks/`, YAML parser, registry with scan/lookup
2. **46 HookResolvers + ContextAssembler** (P2-B): Each hook gets a resolver (condition → fired/skipped + vars). `ContextAssembler` converts InvocationContext → flat `AssemblerInput`
3. **HookPipeline execution engine** (P2-C): `executeStage(stage, input, overrides?) → PipelineResult { patches, events }`. Trace adapters for M1/M2 (observe-only)
4. **HookOverrideStore** (P2-D): Redis-backed override persistence with `safetyTier` constraint enforcement, audit trail (source/timestamp/reason), TTL=0 persistence
5. **InjectionTraceStore** (P2-E): Dual-layer trace persistence (SQLite long-term + Redis recent), pagination, `StageDeliveryDecision` summaries
6. **PipelinePromptBuilder** (P2-F): Pipeline-backed prompt builder with same API shape as legacy `SystemPromptBuilder`, lazy singleton, override integration
7. **Dual-path validation** (P2-5): `AssembleBridge` converts old interfaces → `AssemblerInput`, end-to-end tests prove pipeline output == legacy output
8. **Transport boundary + L0 equivalence** (P2-12/14a): Verification that M1/M2/staging stay out of pipeline, L1-L7 content matches L0 compiler

## Why

Phase 1 gave operators visibility into prompt injections. Phase 2 makes those segments actionable:
- Each segment has a resolver (condition → fired/skipped) producing trace events for observability
- Override store lets operators disable/modify hooks with safety constraints (safetyTier gates)
- Injection traces persist for debugging ("why did the cat behave this way?")
- Pipeline architecture enables future automated prompt iteration (Phase 3)

This is the data foundation for the epistemic trust model: "when cat fails, I can see why and fix it."

## Original Requirements（必填）
> Thread `[thread-id]`: opus47 was dragged off-task by a startup hook's hygiene warning, dropping a review ball. Root cause: no visibility into what's injected into agent prompts, no way to audit or prioritize competing injections.
> Operators can't: (1) See what's being injected, (2) Audit why a cat behaved a certain way, (3) Customize segments designed for customization.
> Phase 2: Make 46 content segments self-contained, dynamically manageable, observable, versionable via a hook pipeline.
- 来源：`docs/features/F237-prompt-injection-visibility.md` §Phase 2
- **请对照上面的摘录判断交付物是否解决了operator的问题**

## Tradeoff

1. **Separate PipelinePromptBuilder vs modifying SystemPromptBuilder**: Chose separate module (121 lines) to avoid touching the 1082-line SystemPromptBuilder directly. Higher isolation, lower merge risk. Routing layer can switch without structural changes. Tradeoff: two builders coexist until migration complete.
2. **Synchronous pipeline (caller pre-resolves overrides) vs async pipeline**: Chose synchronous — `executeStage` takes an optional `ReadonlyMap<string, EffectiveHookState>`. Simpler, testable, no Redis dependency inside the hot path. Caller resolves overrides once from Redis before pipeline execution.
3. **46 hooks (not 52)**: M1/M2 are transport-layer observe-only (trace adapters, not pipeline hooks). N2 (conversation history delta) is out of scope. H1-H3 (Claude Code hooks) use a different injection system entirely. This leaves exactly 46 content hooks.

## Architecture Ownership（必填）
Architecture cell: `prompt-hooks` (NEW)
Map delta: new cell required
Why: F237 P2 introduces entirely new `packages/api/src/domains/prompt-hooks/` domain with 8 source files + 5 resolver files, parallel to existing `domains/cats/services/context/SystemPromptBuilder`. New domain boundary — not an extension of existing cell.

请 reviewer 检查：
- diff 是否与 `Map delta: new cell required` 一致 — 所有新 source 都在 `domains/prompt-hooks/` 下
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding` — **是**: `HookOverrideStore` + `InjectionTraceStore`（两者都是 prompt-hooks cell 内的新建，非并行于其他 cell 的同名概念）
- `packages/shared/src/types/prompt-hook.ts` 新增共享类型 — 确认是否应属于 prompt-hooks cell 或 shared cell

## Open Questions

### 技术 OQ（给 reviewer）
1. **Cognitive complexity trade-off**: `HookPipeline.executeStage` was at 19, extracted 3 helpers to get to 13. The helpers (`resolveDisabledBy`, `resolveEnabled`, `renderContent`) are clean but moved complexity to file scope. Is this the right granularity?
2. **`AssembleBridge` longevity**: Marked as "temporary scaffolding for migration" but will live as long as both builders coexist. Should we add a deprecation notice or just document the dual-track strategy?
3. **Hook YAML CJK directory names** (e.g. `d1-身份锚定/hook.yaml`): Human-readable but adds encoding complexity for some tools. Already works in tests. Worth flagging if reviewer sees issues.
4. **EffectiveHookState as `ReadonlyMap` parameter**: Pipeline accepts optional overrides as `ReadonlyMap<string, EffectiveHookState>`. Is `ReadonlyMap` the right interface vs a plain object?

### 价值 OQ（给 operator）
无 — 回滚成本低（新 domain, 不修改 legacy 路径），技术选择猫猫自决。

## Next Action

请 @codex 完整 review 全部 14 commits + 18 ACs 覆盖，重点关注：
1. **Override constraint enforcement** — `HookOverrideStore.setOverride` 的 safetyTier 门控是否正确阻止了对 readonly 段的修改？
2. **Dual-path validation** — `AssembleBridge` 转换是否忠实保留了 InvocationContext 的所有字段？
3. **L0 equivalence** — 46-hook pipeline 的 L1-L7 输出是否与 L0 编译器一致？测试方法是否可靠？
4. **Architecture boundary** — prompt-hooks domain 的边界是否干净？对 SystemPromptBuilder 的耦合是否最小？

## Review Sandbox（必填）
- Path: `/tmp/cat-cafe-review/f237/codex`
- Start Command: `pnpm review:start`
- Ports: 纯后端/基础设施改动，无前端 UI 变更。测试用 `pnpm test` 验证。
- 注：本 PR 无 UI 改动，sandbox 仅需跑测试即可验证

## 自检证据

### Spec 合规
Quality Gate PASS — 18/18 ACs covered, 愿景覆盖 5/5 项，原始需求可追溯。
- 前端改动：无
- Dogfood: 🆗 可豁免（纯内部基础设施，无 user/cat 可感知路径变化）
- Follow-up tail scan: PASS（无活跃 deferral）
- Root artifact hygiene: PASS

### 测试结果
```
pnpm build → exit 0 ✅
node --test (packages/api) → 53 pass, 0 fail ✅
pnpm lint → 0 errors ✅
pnpm biome check → 0 errors, 6 pre-existing warnings ✅
```

### 相关文档
- Spec: `docs/features/F237-prompt-injection-visibility.md` §Phase 2
- Design review (R1): `review-notes/2026-06-25-f237-phase2-design-review-request.md`
- Feature: F237 / Issue #839

---
Author: 布偶猫/宪宪 (claude-opus-4-6)
Date: 2026-06-26
