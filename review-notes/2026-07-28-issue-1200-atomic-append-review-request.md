# Review Request: #1210 收窄为 Redis 原子 append / idempotency / TTL

Review-Target-ID: f258
Branch: feat/f258-d2-cursor-order
Implementation commit: `ebb5392a3f229b660aeb7091bc1c83d23d6374a7`
PR: https://github.com/zts212653/clowder-ai/pull/1210

## What

- 删除本分支原有的 private `orderKey`、cursor relation 与分页改写；相对
  `upstream/main` 的最终实现净差异只有 3 个文件。
- `APPEND_LUA` 把 idempotency winner 检查、stale mapping 回收、message hash、
  timeline/thread/user/mention indexes 与 TTL 设置收进一个 Redis linearization
  point。
- idempotency replay 只返回既有消息，不重复触发 `onAppend`；并发 winner 在返回前
  消失时 fail closed，而不是伪造成功。
- 首次 append、idempotency replay 与重新 hydrate 均保留显式空数组
  `contentBlocks: []`、`toolEvents: []`、`whisperTo: []`，不把“显式为空”折叠成
  “字段缺失”。

## Why

Maintainer 已裁定 #1210 走 path 1：现有 lexical message-ID cursor 契约下若无法
表达稳定 successor relation，本 PR 不得留下半套 private ordering coordinate，只能
保留不改变 cursor contract 的独立 atomicity / idempotency / TTL 修复。本轮因此把
cursor 架构完整移出 #1210，同时保住 Redis append 的单点原子性与重放语义。

## Original Requirements（必填）

> “If that cannot be expressed under the existing contract, keep only the independent
> atomicity/idempotency/TTL fixes in this PR and treat the typed/order cursor as
> separate architecture work.”

- 来源：[PR #1210 maintainer exact-HEAD review](https://github.com/zts212653/clowder-ai/pull/1210#pullrequestreview-4788829366)
  与 [Issue #1200](https://github.com/zts212653/clowder-ai/issues/1200)。
- 请 reviewer 对照判断：最终 diff 是否彻底移除了 cursor/orderKey 权威性，并且
  retained fixes 没有偷偷改变公开 cursor、timestamp score 或 MessageStore contract。

## Tradeoff

- 本 PR 明确不修 late-delivery cursor ordering；该问题进入独立 architecture
  design，不在 #1210 里用局部 coordinate 迁移补偿。
- APPEND Lua 比原 MULTI pipeline 更长，但换来 idempotency claim、hash 与所有 index
  的单一原子提交点，消除并发重放产生重复 thread member 或半写状态的窗口。
- 不新增 schema/store，也不扩大到 delivery/cancel/read pagination；现有 timestamp
  score 与 lexical cursor 行为保持基线兼容。

## Architecture Ownership（必填）

Architecture cell: none（既有 `IMessageStore` / `RedisMessageStore` persistence boundary
尚未登记独立 ownership cell）
Map delta: none
Why: 本次只收紧既有 Redis append implementation 的原子性；没有新增或平行化
Store / Queue / Router / Adapter / Dispatcher / Binding，也没有改变 owner、boundary、
extension point 或 canonical anchor。

请 reviewer 检查：

- 3-file 净 diff 是否与 `Map delta: none` 一致；
- APPEND_LUA 的 KEYS/ARGV 顺序、stale winner 回收与 TTL/index 写入是否一一对应；
- 是否仍有 orderKey、typed cursor、producer high-water 或 pagination 语义残留；
- explicit-empty-array 与 replay/onAppend 契约是否在 Redis 首次写入、重放和 hydrate
  三条路径闭合。

## Open Questions

### 技术 OQ（给 reviewer）

1. 两个并发 append 使用同一 idempotency key 时，是否只有一个 hash/thread member，
   loser 是否稳定返回 winner，且 `onAppend` 恰好一次？
2. stale idempotency mapping 的回收是否与新 claim/write 同一原子点，是否存在删掉
   新 winner 或返回 vanished winner 的窗口？
3. `APPEND_LUA` 是否精确保留原来的 timestamp score、TTL=0/TTL>0 与 timeline/thread/
   user/mention index 语义？
4. 反向裁剪是否完整：相对 `upstream/main` 是否确实只剩 atomic append/idempotency/
   TTL 相关的 3 个文件？

### 价值 OQ（给 operator，如有）

无。

## Next Action

请 Fable 对 implementation commit `ebb5392a3` 及本 review note 的最终 HEAD 做独立
窄审，至少复跑 RedisMessageStore focused suite，并审查完整
`upstream/main...HEAD` diff。若无 P1/P2，请明确 `APPROVE`；如需退回，每项 finding
请标 P1/P2/P3、精确文件/行号与一手证据。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f258/fable`
- Start command: `pnpm review:start --web-port=5210 --api-port=3210`
- Ports: `web=5210`, `api=3210`；本次为后端存储审查，不需访问任何运行实例端口或数据。
- 沙盒保持 detached HEAD / read-only；Redis focused suite 使用隔离测试实例。

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## 自检证据

### Spec 合规

- 已执行 maintainer path 1：orderKey/cursor authority 与相应测试、文档全部从最终净
  diff 移除。
- retained implementation 不改 `IMessageStore`、timestamp score、delivery re-score、
  cursor wire format或分页 relation。
- 最终净差异：`RedisMessageStore.ts`、`redis-message-delivery-lua-scripts.ts`、
  `redis-message-store.test.js`。
- 根目录媒体/设计工件闸门：工作树与 `upstream/main...HEAD` 均为 `none`。

### 测试结果

```text
pnpm --filter @cat-cafe/api test:public
  16,733 tests; 16,705 passed; 0 failed; 28 skipped

isolated RedisMessageStore suite
  38 passed; 0 failed

pnpm gate --no-rebase
  exact implementation SHA ebb5392a3
  build passed (23s)
  tsc --noEmit passed (10s)
  public tests passed (723s)
  web lint + repository check passed (46s)
  total 805s

git diff --check upstream/main...ebb5392a3
  passed
```

`--no-rebase` 是有意选择：作者先显式 rebase 到 PR 的真实基线
`upstream/main@7207936a`；gate 脚本硬编码的 fork `origin/main` 与 upstream 已
2/2 分叉，不能作为该 upstream PR 的基线。

### 相关文档

- Issue: https://github.com/zts212653/clowder-ai/issues/1200
- Maintainer review:
  https://github.com/zts212653/clowder-ai/pull/1210#pullrequestreview-4788829366
- Architecture map delta: none
- Implementation commit: `ebb5392a3f229b660aeb7091bc1c83d23d6374a7`

[砚砚/gpt-5.6-sol🐾]
