# Review Request: 禁用旧 Opus 时默认路由到 Opus 5

Review-Target-ID: `fix-default-opus5-routing`
Branch: `fix/default-opus5-routing`
PR: https://github.com/zts212653/clowder-ai/pull/1283
Implementation base commit: `72d78d1b3d3d290354837bd85f2fd46c0ee076ba`
Review target: PR #1283 latest HEAD（正式请求中附精确 SHA）

## What

- roster 新增显式 `successor` 字段，公开 seed 将旧 `opus` 标为不可用并指向可用 `opus-5`。
- 默认猫、runtime/env override、历史 preferred policy、participant/last-replier 和 MCP teammate 等隐式状态统一解析 successor。
- 显式 `@opus` 不静默改投，继续返回 `cat_disabled`；alternatives 首项提供 canonical `@opus-5`。
- Hub 路由策略、系统提示、MCP 示例与当前教学入口统一展示和持久化 `opus-5`。
- feat-index 的隐式 owner metadata 在旧身份禁用后按唯一有效 successor 迁移，不影响显式 mention 的 fail-closed 行为。
- pre-resolved 系统调用在 `routeExecution()` admission 统一规范化，podcast/scheduler 不再绕过 availability。
- 无 successor 时不再降级到任意服务，也不会把 `__none__` 持久化为 guardian。

## Why

runtime 实例已经完成成员升级，但公开 seed、默认 resolver、历史状态消费者和活跃教学入口没有共享替代关系真相源。结果是系统仍会先生成、保存或延续已禁用的旧 catId，再依赖投递层事后告警补救。

## Original Requirements

> 修正默认协作猫路由：禁用 `@opus` 时优先 Opus 5。
>
> 当前 thread 中 `opus-5` 可路由，旧 `opus` 不在可路由集合；co-creator 明确要求默认找 Opus 5。
>
> 找到旧句柄的 canonical 来源，不只修一处文案。
>
> 稳定替代规则不可把 `@opus5` 散落硬编码到多处；动态 roster/availability 与显式 successor 要有单一真相源。
>
> 旧猫禁用且有明确 successor 时隐式路由继续工作；无明确替代时 fail-closed 并暴露告警。

来源：当前 Dispatch Mission 与 thread `thread_mscyc19ivc03ta5x` 的调查任务。请 reviewer 对照判断：实现是否同时消除了新安装配置漂移、历史状态漂移和认知入口漂移，而没有把显式用户 mention 静默改投。

## Tradeoff

- successor 只走显式一跳映射，不按 family 或版本号猜测；代价是 roster 升级时必须维护该字段，但错误投递风险更低。
- runtime 私有 catalog 不整体复制到公开 seed，只移植公开所需字段；代价是需要单独的 template backfill。
- 历史 feature/architecture 文档不全局替换，只修当前规范性教学入口，保留历史证据真实性。

## Architecture Ownership

Architecture cell: existing cat config / dispatch routing
Map delta: none
Why: 本次只扩展现有 roster metadata、默认/历史目标 resolver 和既有 Hub policy 消费；没有新增 Store、Queue、Router、Adapter、Dispatcher 或 Binding 边界。

请 reviewer 重点检查：

1. `resolveCatSuccessor()` 的注册、availability 与一跳 fail-closed 约束是否完整。
2. 显式旧 mention 与隐式 persisted/default 状态的行为分流是否存在漏面。
3. template variant backfill 是否可能覆盖 runtime-owned 配置或制造重复 identity。
4. participant/last-replier 的 peek 与 persist 是否始终保持相同优先级。
5. Hub 对旧 policy 的回读和 canonical successor 保存是否一致。
6. feat-index 的 identity-label fallback 是否只在唯一显式 successor 时放行，歧义和无 successor 是否继续 fail-closed。

## Open Questions

### 技术 OQ

1. `successor` 是否还需要在 schema 层拒绝多节点环；当前一跳 resolver 会对 self-loop、未知、禁用目标 fail-closed。
2. `getDefaultCatId()` 在无可用 successor 时返回 `__none__` 是否覆盖所有调用方，还是仍有调用方假设默认猫必定可执行。
3. 旧式 AgentRouter 测试使用隔离 legacy template 是否足够克制，是否有更小的 fixture 注入方式。

### 价值 OQ

无。

## Fresh-Context Scan

- PR 创建后已按项目规则调用 `/simplify`；独立 Codex 会话 10 分钟超时，无 final 输出、无工作区改动。
- 随后调用只读 `codex exec review --base upstream/main`；5 分钟超时，无 final 输出、无工作区改动。
- HEAD `dea8da35b` 另启 fresh-context session，产出 1 个 P2 finding：无效 runtime/env default 的 `__none__` 会被 `pickFallbackCat()` 替换为任意服务。
- 处理：已补 runtime/env fail-closed 与 AgentRouter 端到端红测并修复；该 finding 不构成 approval，正式 verdict 仍由 named reviewer 独立产生。

## Review Feedback Closure

| Finding | 处理 | Red → Green |
|---|---|---|
| P1：pre-resolved target 可执行 disabled `opus` | `routeExecution()` 进入 strategy 前统一解析 availability/successor；无目标抛错 | AgentRouter admission + podcast producer-to-service：FAIL → PASS |
| P1：`__none__` 可持久化为 guardian | `GuardianMatchResult.guardian` 支持 null；request-guardian 无候选返回 409，创建 token 前退出 | GuardianMatcher + community route：FAIL → PASS |
| FC-1 P2：无 successor 会挑任意 fallback | 无效 runtime/env default 立即返回 `__none__`；`pickFallbackCat()` 对 sentinel 返回 null | default config + AgentRouter no-target：FAIL → PASS |

Failure-mode sweep：三项都属于“隐式/预解析目标绕过 availability 边界”。扫描所有 production `routeSerial` / `routeParallel` / `getService` 调用后，唯一执行入口均由 `AgentRouter.route()` 或 `routeExecution()` 持有；本轮在后者补中央 admission，不逐个修 producer。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-default-opus5-routing/opus-5`
- Start command: `pnpm review:start --web-port=5221 --api-port=3221`
- Ports: `web=5221`, `api=3221`；使用隔离 memory store，不访问 runtime `3003/3004` 或 Redis `6399`。
- sandbox 必须保持 detached HEAD / read-only；如需改代码，请走 TAKEOVER 并另开正式 worktree。

## 自检证据

- 受影响 API 聚焦集：355/356；唯一失败为未改文件 `shared-rules.md` 在 Windows CRLF checkout 下的既有 governance hash 差异。
- Public CI 受影响 fixture（19 文件）：402/402；旧 HEAD 的 74 个失败已全部覆盖。
- feat-index 聚焦集：16/16；旧身份标签可解析到唯一有效 successor。
- 受影响 20 文件合并回归：537/538；唯一失败为 `callback-routes.test.js` 的既有 Windows absolute-path 断言（实际 `G:\...`，测试只接受 Unix `/...`）。
- Review finding + Public fixture 扩大回归（24 文件）：643/644；review-fix 新路径全部通过，唯一失败仍为 `callback-routes.test.js` 的既有 Windows absolute-path 断言。
- Red→Green 聚焦集（5 文件）：初始 8 个预期失败 → 修复后 131/131。
- GitHub `Test (Public)`（HEAD `dea8da35b`）：通过；新 review-fix HEAD 仍需 CI 复验。
- 核心路由聚焦集：17/17；Hub successor Vitest：4/4。
- `pnpm lint`：exit 0，仅既有 warning。
- `pnpm build`：exit 0。
- `pnpm check:capability-tips`、`check:skills:manifest`、`check:skills:surfaces`：通过。
- 改动代码/JSON Biome lint：exit 0；14 个 LF-safe 文件 formatter：exit 0。
- `git diff --check upstream/main...HEAD`：通过；仓库根目录无媒体/设计工件。
- 全仓 `pnpm check` 被 Windows checkout 的 4469 个既有 CRLF formatter 错误阻塞；包级全量 API/Web test runner 另有 Windows env/参数长度/spawn 基线问题，详见 bug report。
- Dogfood：隔离 Web 3101 / API 3102 验证正常 successor、真实 policy 保存、无 successor fail-closed、桌面/移动端布局；证据位于系统临时目录。

## Next Action

请 `@opus-5` 在独立 sandbox 复跑关键回归并审查完整 diff。若无 P1/P2，请在 PR comment 中写明 `Verdict: APPROVE`、覆盖 HEAD SHA、独立验证证据与签名；若退回，请逐项标注 P1/P2/P3、精确文件/行号和复现证据。

[砚砚/gpt-5.6-sol🐾]
