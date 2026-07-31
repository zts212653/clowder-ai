# Review Request: #1252 OpenCode 本地模型键与上游 ID 映射

Review-Target-ID: fix-opencode-kimi-model-alias
Branch: fix/opencode-kimi-model-alias
Implementation-SHA: 233f825e0c72e004626eb190ba42be49c0c984ca
PR: https://github.com/zts212653/clowder-ai/pull/1233

`Implementation-SHA` 是已验证的实现 HEAD。若本 review packet 作为后续文档提交进入 PR，正式 verdict 仍须核对当时的实际 PR HEAD，并确认代码差异除 review packet 外未变化。

## What

为账户配置新增 `modelAliases`，把 OpenCode 的稳定本地模型键映射到 endpoint-specific 上游模型 ID。映射贯穿账户 REST、legacy migration、account resolver、ACP spawn 和普通 invocation；OpenCode 配置使用 `{ id: upstreamId, name: localKey }`，未配置映射时保持恒等路由。Debug summary 新增 local key → upstream ID 映射，但不包含凭据。

## Why

OpenCode `1.18.9` 将 `provider.<id>.models` 的 map key 用作本地选择键，真正发送给 SDK 的模型 ID 来自条目 `id`；`name` 只负责展示。旧实现只改 `name`，因此选择 `kimi/kimi-code/k3` 时仍向 OpenAI-compatible endpoint 发送 `model: kimi-code/k3`。

## Original Requirements

来源：[Issue #1252](https://github.com/zts212653/clowder-ai/issues/1252)，已获 maintainer `WELCOME / accepted bug`。

> 1. `models` 中的键保持为用户选择、session 恢复和 telemetry 使用的稳定本地键。
> 2. OpenCode 自定义 provider 的模型条目使用 `id` 传递上游请求 ID。
> 3. `name` 仅用于展示，不承担路由语义。
> 4. 未配置映射时使用恒等映射，不做字符串猜测。
> 5. 映射由对应账户/provider profile owner 维护；通用 generator 不维护跨 provider 硬编码 alias 表。
> 6. 验收必须启动真实 OpenCode 进程、捕获请求体并断言实际 `model`，不能只检查生成 JSON。
> 7. Debug summary 同时展示 local key 与 upstream ID，且不得泄漏 API key。

请 reviewer 对照以上原始契约判断，而不只检查类型与单元测试是否通过。

## Tradeoff

我们没有建立全局 provider alias catalog，也没有按模型名做猜测。代价是第三方 endpoint 的账户 owner 必须显式维护映射；收益是通用 generator 不持有会漂移的第三方知识，未知模型继续恒等路由，现有本地模型键与 session 绑定保持稳定。

## Architecture Ownership

Architecture cell: `identity-session`（`identity-agent` 的账户/运行时配置边界）
Map delta: none
Why: 本变更扩展既有账户配置与 provider adapter 数据流，没有新增 Store、Queue、Router、Dispatcher、Binding 或新的 ownership 边界。

请 reviewer 检查 diff 是否与 `Map delta: none` 一致，并确认 `modelAliases` 没有形成第二份全局配置真相源。

## Invariant Matrix

| Invariant | 断言 | 证据 |
| --- | --- | --- |
| INV-1 | 本地模型键在账户、成员选择与 OpenCode `model` 选择路径中保持不变 | config template、invocation 回归 |
| INV-2 | 只有账户级映射决定上游 `id`；未配置时恒等路由 | generator 单测、catalog/resolver 回归 |
| INV-3 | ACP 与普通 invocation 使用同一映射契约 | ACP config 与 invocation 定向测试 |
| INV-4 | REST create/list/update/clear 与 legacy migration 不丢映射 | accounts route、catalog tests |
| INV-5 | Debug summary 展示映射但不包含 API key | config summary assertions |
| INV-6 | OpenCode `1.18.9` 的真实请求体发送 `model: kimi-k3` | `opencode-model-id-request.test.js` |

## Dogfood-Your-Slice

Scope verdict: 必做，已完成。

端到端路径：生成账户映射配置 → 启动真实 OpenCode `1.18.9` 子进程 → 指向随机端口本地假 OpenAI-compatible server → 捕获 `POST /v1/chat/completions`。

捕获结果：本地选择仍为 `kitcoding/kimi-code/k3`，请求体 `model` 为 `kimi-k3`。假服务故意返回 503，仅用于在无真实凭据条件下终止请求；测试不把 kitcoding 原始 503 根因当作已独立复核事实。

## Open Questions

### Technical OQ

1. `modelAliases` 的 trim、空值拒绝和 trim 后重复键检测是否覆盖了所有 canonical 冲突路径？
2. REST、legacy migration、ACP pool 与普通 invocation 是否存在遗漏的账户复制/序列化边界？
3. OpenCode schema 版本变化时，`1.18.9` 精确版本断言是否能足够早地阻止静默漂移？
4. Debug summary 的 `modelMappings` 是否在所有路径都只包含模型标识，不可能带入凭据或 endpoint secret？

### Value OQ

None.

## Fresh-Context Findings

Agent: Archimedes（fresh-context scan）
SHA scanned: `233f825e0`
结果：0 remaining findings；FC-2/FC-3 已修复，FC-1 经源码真相源复核后驳回。

Fresh-context scan 只负责 finding generation，不构成正式放行。

## Quality-Gate Evidence

检查 worktree：`G:\AIwork\clowder-ai\cat-cafe-opencode-kimi-fix`

### Fresh targeted tests

```text
accounts-route.test.js                         17 passed, 0 failed
account-resolver.test.js                       20 passed, 0 failed
catalog aliases/migration pattern              2 passed, 0 failed
OpenCode ACP/config alias pattern               4 passed, 0 failed
invoke-single-cat alias propagation             1 passed, 0 failed
real OpenCode 1.18.9 request capture            1 passed, 0 failed
Total                                           45 passed, 0 failed
```

### Build / lint / formatting

```text
pnpm --filter @cat-cafe/api run build          exit 0
pnpm --filter @cat-cafe/shared lint             exit 0
pnpm --filter @cat-cafe/api lint                exit 0
pnpm --filter @cat-cafe/web lint                exit 0（既有 warnings）
pnpm -r --if-present run build                  exit 0
```

本地 Windows checkout 的 Biome 对 CRLF 工作树按整文件报格式差异，未自动改写；GitHub exact HEAD `233f825e0` 的 `Lint` check 为 SUCCESS。`Test (Windows)`、`Build`、`Directory Size Guard` 同样为 SUCCESS；发请求时 `Test (Public)` 仍在运行，由 PR tracking 事件驱动继续跟踪。

完整大文件合并运行会触发该 checkout 已知的 HOME 串扰与 Windows 路径断言基线；本轮按仓库隔离约定逐组运行新增契约，45 项均绿。根目录媒体/设计工件检查为空，无匹配 `.pen`。

`scripts/check-hotfix-pattern.mjs`、`scripts/check-fallback-layers.mjs` 与 `check:architecture-ownership` 在此上游 checkout 不存在。人工 diff 审计未发现同文件新增三层 fallback，也未新增架构 ownership primitive。

## Review Focus

1. 账户配置的 source-of-truth 与所有传播边界是否完整。
2. local key / display name / upstream ID 三者是否始终分离。
3. legacy migration 与 canonical conflict 是否可能静默覆盖映射。
4. 真实 OpenCode 进程测试是否足以证明请求语义，而非只证明 JSON 形状。
5. Debug summary 与日志是否保持凭据安全。

## Next Action

请对当前 PR exact HEAD 做独立跨家族 review，在 PR conversation 以 logical review comment 给出明确 `APPROVE` 或 `REQUEST-CHANGES`，覆盖 HEAD SHA，并将每个 finding 标为 P1/P2/P3。不要使用 `gh pr review --approve`，因为 author/reviewer 共用 GitHub login。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-opencode-kimi-model-alias/opus`
- Start command: `pnpm review:start`
- Ports: 由 review launcher 分配；不得占用 runtime `3003/3004`。

[砚砚/GPT-5.6 Sol🐾]
