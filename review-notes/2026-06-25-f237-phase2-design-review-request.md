# Review Request: F237 Phase 2 设计方案 — Hook Pipeline + Injection Trace

Review-Target-ID: f237-phase2
Branch: feat/f237-phase2-hook-pipeline

## What

F237 Phase 2 的完整设计 spec（纯文档，无代码变更）。核心内容：

- **46 hook pipeline**：将 SystemPromptBuilder 的 46 个 `if/push` 段落重构为声明式 hook（HookManifest YAML + Resolver + Template）
- **3 Tier 2 trace adapters**：N2 (conversation history delta) + M1-M2 (transport-layer) 观测适配器
- **InjectionTrace 双层持久化**：Summary (TTL=0) + Detail (7-day TTL)
- **Runtime Override Store**：Redis 覆盖层（enable/disable, version switch, template edit）
- **双轨上游策略**：fork 建终态 (Path B) + 上游渐进 3-PR 合入

## Why

Phase 1 (PR #859) 交付了可见性——operator 能看到 52 个注入段。Phase 2 让 46 个段变为可管理、可追踪、可迭代的 hook。

约束：
- Maintainer 要求 trace-only 先行，pipeline 和 override store 分开审查
- 我们和 maintainer 达成双轨方案：fork 不做临时工作，上游按 trace → pipeline → override store 三步走
- H1-H3 (Claude Code hooks) 完全移出 Phase 2/3 scope

## Original Requirements（必填）
> Thread `thread_mpuxhppp0vzl2y16`: opus47 was dragged off-task by a startup hook's hygiene warning, dropping a review ball. Root cause: no visibility into what's injected into agent prompts, no way to audit or prioritize competing injections.
- 来源：Issue [#839](https://github.com/zts212653/clowder-ai/issues/839) + maintainer triage + 多轮 comment 讨论
- **请对照上面的摘录判断设计方案是否解决了 operator 的问题**

## Tradeoff

| 放弃的方案 | 原因 |
|-----------|------|
| Trace-only 先行（Path A/C） | 46 个 trace.record() 调用点是临时工作，pipeline 建好后全部删除 |
| 一个 PR 全部提交 | ~5,500 行太大，maintainer 无法 review |
| H1-H3 纳入 pipeline | 完全不同的注入系统（Claude Code hooks），scope 不匹配 |
| L1-L7 保持 observe-only | 它们是运行时动态编译的模板，和 S 段完全相同的 pattern，应统一 |

## Architecture Ownership（必填）
Architecture cell: prompt-assembly（SystemPromptBuilder + compile-system-prompt-l0.mjs + route-layer injection）
Map delta: new cell required（HookPipeline + HookRegistry + ContextAssembler + HookOverrideStore + InjectionTrace 为新增子系统）
Why: 将散落在 8 个文件中的 46 个 if/push 段落统一到声明式 pipeline，新增 5 个核心组件

请 reviewer 检查：
- diff 是否与 `Map delta` 一致（本 PR 是纯 spec，代码变更在后续实现 PR）
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`
  - 是：HookOverrideStore (Redis), HookRegistry (scan+resolve), ContextAssembler (IO), HookPipeline (execution)
  - 这些都是设计中明确定义的，不是无意间新建的并行组件

## Open Questions

### 技术 OQ（给 reviewer）
1. **Resolver 粒度**：每个段一个 resolver class 是否太碎？是否有更好的组织方式（如按 stage 分组、按 input 依赖聚合）？
2. **order 字段设计**：100 步间距够不够？是否需要 float 或者 priority group？
3. **Dual-path 验证**：从 if/push 迁移到 pipeline 时，snapshot test 是否足够证明等价？是否需要更强的等价证明（如 property-based testing）？
4. **上游 PR 1 (trace-only) 的实现**：从 fork 的 pipeline 实现中提取 trace-only 子集，技术上是否可行且不引入耦合？

### 价值 OQ（给 operator，如有）
无——方向已由 co-creator 和 maintainer 共同确认，技术选择在设计 scope 内自决。

## Next Action

请 reviewer 重点审查：
1. **架构合理性**：Two-Tier 分层（46 pipeline + 3 observe-only）是否正确
2. **State Model**：baseline (YAML/git) + runtime override (Redis/TTL=0) 两层解析是否合理
3. **上游策略**：双轨方案（fork 建终态 + 上游 3-PR）是否站得住
4. **代码量评估**：PR 拆分方案（P2-A → P2-E）粒度是否合适
5. **TraceEvent 设计**：discriminated union (fired/skipped/disabled/observed) 是否覆盖所有场景

## Review Sandbox（必填）
- N/A — 纯设计文档 review，无代码需要运行
- Spec 文件：`docs/features/F237-prompt-injection-visibility.md`
- 分支：`feat/f237-phase2-hook-pipeline`（12 commits）

## 自检证据

### Spec 合规
- 纯设计文档，无代码变更——quality-gate 代码检查项不适用
- Spec 完整性：17 ACs 定义 ✅ / 5 sub-phase landing order ✅ / 上游策略写入 ✅ / H1-H3 scope 清理 ✅
- 内部 review 历史：codex 4 轮 14 findings 全部修复 + co-creator 3 轮设计修正

### 测试结果
N/A — 纯 spec 文档，无运行时变更

### 相关文档
- Spec: `docs/features/F237-prompt-injection-visibility.md`
- Issue: [#839](https://github.com/zts212653/clowder-ai/issues/839)
- Phase 1 PR: [#859](https://github.com/zts212653/clowder-ai/pull/859) (merged)
- Feature: F237
