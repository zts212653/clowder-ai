# Review Request: 配额窗口语义去重与 Claude 刷新来源隔离

Review-Target-ID: fix-1027-quota-codex-auth
Branch: fix/1027-quota-codex-auth
Previous reviewed HEAD: `987ba3adefa0069569e8dc69af181fecd75adf41`（REQUEST_CHANGES）

## Review Status

**CHANGES ADDRESSED — new exact-HEAD review pending.**

此前对 `987ba3ad` 的复审确认了显式凭证路径权威性与 provider cache 隔离，但又发现 body/header 重复窗口和 Claude 并发刷新竞争两项 P1。本次改动处理这两项 P1；当前 HEAD 尚无独立 APPROVE，不引用旧结论作为新 HEAD 的放行证据。

## What

- Codex Wham parser 以 `primary_window`、`secondary_window`、`credits_balance` 作为稳定语义身份；对应 body 已成功解析时，不再追加 header fallback。
- Claude cache 分别维护 `officialError` 与 `cliError`，再确定性派生兼容字段 `error`；每个来源成功时只清理自己的错误。
- 同时请求 Claude/Codex 但仅一方有凭证时，可用 provider 继续刷新，缺凭证 provider 会留下可见 warning 与来源级 cache error。
- 配额看板会解析所有刷新响应中的 `warnings`，包括 HTTP 200 的局部成功响应，并去重展示。
- 保持上一轮已修契约：显式 `CODEX_CREDENTIALS_PATH` 对 native/legacy 文件均权威且失败关闭；provider-scoped refresh 不修改未请求 provider 的 cache。

## Why

展示标签不是配额窗口身份。七天 primary body 与 primary header 可以分别投影成“每周使用限额”和“5小时使用限额”，以 `poolId + label` 去重会把同一窗口错误展示两次。

同理，Claude OAuth 与 ccusage 是两个独立探针。把它们折叠进同一个可变 `claudeCache.error`，会让后完成的成功覆盖另一个来源刚写入的失败；HTTP 200 的 warnings 若不解析，用户仍然看不到局部故障。

## Original Requirements

> “又被检查出了两个问题，请解决！”

Reviewer blockers：

1. body `primary_window.limit_window_seconds=604800` 与 `x-codex-primary-used-percent` 同时存在时只应产生一个 weekly item；
2. official failure + ccusage success 的两种完成顺序都必须保留 official failure，且 UI 必须展示 HTTP 200 partial warnings；
3. 更新 PR 正文中的显式凭证优先级、测试数量与 review 状态。

真相源：

- `docs/bug-report/quota-display-window-semantics/bug-report.md`
- `docs/bug-report/quota-claude-source-error-isolation/bug-report.md`

## Tradeoff

- header 仍保留为兼容 fallback，但只在相同语义来源没有可用 body 数据时启用；不会因为 body 对象存在但缺少有效百分比而丢失 header 数据。
- 保留聚合 `claude.error` 兼容现有 API/Web 消费者，同时增加 source-specific 字段。没有引入锁或请求串行化；每个异步完成点都基于当时最新 cache 做来源级合并，因此完成顺序不影响错误保留。

## Architecture Ownership

Architecture cell: existing quota API parser/cache + quota board response projection

Map delta: none

Why: 没有新增 Store / Queue / Router / Adapter / Dispatcher / Binding；只把既有 cache 的聚合错误槽拆成来源级状态，并修正既有 parser fallback 身份。

## Failure-Mode Sweep

模式：用展示/聚合字段代替稳定来源身份，导致重复数据或并发覆盖。

扫描范围：

- Codex body/header 三个来源：primary、secondary、credits；
- Claude official success/failure、missing credentials、disabled refresh、ccusage success/failure；
- Web “刷新全部”对 2xx / non-2xx response body 的消费。

结果：

- 三个 Codex header 均绑定对应 body source，body 成功解析后跳过相同来源 fallback；
- 所有 Claude writer 均只改自己的 `officialError` 或 `cliError`；
- Claude/Codex 两个方向的部分缺凭证都返回 provider-scoped warning，且 `skipped` 只包含本次实际请求的 provider；
- official/CLI failure 与另一来源 success 的双向、双完成顺序均有确定性测试；
- Web 对每个响应只解析一次 body，同时收集 status error 与 warnings。

## Open Questions

### 技术 OQ（给 reviewer）

1. body source 的标记时机是否正确覆盖“body 有效则权威、body 无有效百分比则允许 header fallback”？
2. `mergeClaudeOfficial*` / `mergeClaudeCli*` 是否在所有完成顺序下只清理自身错误，并稳定派生聚合 `error`？
3. Web 对 2xx warnings、non-2xx error 及重复消息的处理是否完整且无二次读取 body？

### 价值 OQ（给 operator）

无。

## Next Action

请不同个体在新 HEAD 上复跑定向测试，并核对 exact diff。若无 P1/P2，请明确 APPROVE；若有 finding，请附严重级别与精确证据。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-1027-quota-source-isolation/<reviewer-handle>`
- Start: `pnpm review:start --web-port=<safe-port> --api-port=<safe-port>`
- 禁止访问 3003/3004；使用 memory store、临时 `CODEX_HOME`、`CAT_CAFE_HOME` 与 `CAT_CAFE_GLOBAL_CONFIG_ROOT`，不得刷新真实 OAuth。

## 自检证据

- API quota：76 passed, 0 failed。
- API env registry：40 passed, 0 failed。
- Web quota：22 passed, 0 failed。
- Ambient-isolation diagnostics：149 passed, 0 failed（清除本机 `PENCIL_MCP_*`、runtime-root 与 `ANTHROPIC_MODEL` 注入后）。
- `pnpm check`：passed。
- Web typecheck / production build：passed。
- Directory Size Guard / `git diff --check` / follow-up-tail check：passed。
- Test (Public) 净化环境复跑：API 16,597 passed / 0 failed / 29 skipped；Desktop 13 passed / 0 failed。
- 浏览器 smoke：隔离 Web 3221 / API 3222 / memory store；注入 `每周使用限额, usedPercent=27`，`/settings` 返回 200 并已在 Hub Browser Preview 打开。
- HTTP 200 warning 的可见性由组件回归测试固定验证；浏览器 smoke 不使用真实 OAuth 制造 partial warning。

[清明/gpt-5.6-sol🐾]
