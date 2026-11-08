---
tips_exempt: "修复既有会话收敛；没有新增用户操作、配置或产品入口。"
---

# #1287 quiet 收敛补片的固定夹具

本目录对应 [PR #1906](https://github.com/zts212653/clowder-ai/pull/1906)。验收源版本、命令与结果以该 PR 最新审查包所列的完整 SHA 为准；复跑前先 checkout 那个 SHA，不能用移动中的分支名替代它。#1287 继续开放。

维护者在 `5d024c24de2b710117a8d9e024da74e6f822c54e` 的[正式审查](https://github.com/zts212653/clowder-ai/pull/1906#pullrequestreview-5809698337)复现了两个 P1 和一个 P2。本轮测试覆盖这些原反例，以及修正所影响的翻页、响应重试和身份可见性。

## 可复跑入口

从仓库根目录执行，使用锁文件依赖和项目要求的 Node 版本：

```sh
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/api build
node --test --test-concurrency=1 packages/api/test/messages-watermark.test.js packages/api/test/messages-watermark-contract.test.js
pnpm --filter @cat-cafe/web exec vitest run src/hooks/__tests__/thread-history-watermark-api.test.tsx src/hooks/__tests__/thread-history-watermark.test.tsx src/hooks/__tests__/useSocket-stale-watchdog.test.ts
```

Redis contract 的运行条件是 `REDIS_URL` 指向自行启动的隔离实例，同时设置 `CAT_CAFE_REDIS_TEST_ISOLATED=1`。未提供隔离实例时测试会明确跳过 Redis，不能把 skip 报成通过。本轮使用 `redis://127.0.0.1:6398/15`，随机 key prefix，不 flush、不删除测试数据。

固定夹具与断言：

| 入口 | 输入与验收 |
|---|---|
| `packages/api/test/messages-watermark.test.js` | 两条 processing R 经真实 admission writer 创建，之后追加 60 条更新消息，保存基线，再原位完成 R；增量响应必须包含两条 R，确认依据覆盖实际恢复的记录。包含隐藏-only 响应逐字不变、丢响应重试、同 cursor 第二客户端与静止区间跨 10 分钟不重扫。 |
| `packages/api/test/messages-watermark-contract.test.js` | 同一套真实 Fastify route 对接 Memory/Redis；覆盖 queued speech/input、seen recall、删除回退、非法 legacy source、旧位置 final；额外验证 legacy 同分时间线迁移到唯一发布位置，以及下面的 Redis 命令预算。 |
| `packages/web/src/hooks/__tests__/thread-history-watermark-api.test.tsx` | 原生加载上述真实 API，响应送进实际 `useChatHistory`、quiet hook 和 chatStore。32 秒内两条 R 各一条；继续翻页后中间 60 条消息均可达；再过 90 秒不重复 catch-up。另一条通过真实 Socket handler/store writer 注入 processing，然后一次 `/queue` 503，验证无 slot 忙态能退出并补读。Socket 传输和 provider 不连接外部服务。 |
| `packages/web/test/browser/issue1287-quiet-recovery.mjs` | Chromium 中渲染真实聊天组件，使用真实 HTTP、Socket.IO、Queue、Redis 与可控 provider；原 12 场景，包括切回缓存、前台 32 秒、实时、stream lost、断线前后台、F5、重入房、序号缺口和 visibility 恢复。验证全文、rich、toolEvents、replyTo、同一个 durable ID、唯一气泡及重复终态。 |

浏览器夹具另需本机 Playwright Chromium 与 Redis 可执行文件。环境变量 `ISSUE1287_EXPECT_HEAD` 必须等于检出的完整 SHA；`ISSUE1287_REDIS_SERVER` 可指定 Redis 路径（默认 PATH 中的 `redis-server`），非标准名称时用 `ISSUE1287_REDIS_CLI` 指定对应 CLI。可选 `ISSUE1287_CASE` 是场景名逗号列表；不设置即运行全部 12 条。

```sh
node --import tsx packages/web/test/browser/issue1287-quiet-recovery.mjs
```

夹具拒绝有未提交 tracked 修改的树，并在监听前检查专属端口 12874/6398。输出默认位于 `artifacts/issue1287-browser-<time>`，可用 `ISSUE1287_EVIDENCE` 指定新目录。`results.json`、截图、实例台账及隔离 RDB/AOF 均保留；任何场景失败时进程非零退出。产物只含构造会话，不需要用户历史或私有目录。

当前 next 在 `4020d9c65` 已带入 PR-3b 的“只订阅前台房间”约定。两条后台旅程因此断言退房，在当前前台房间断开同一 Socket，验证重连后产生后台 catch-up、回前台后应用；不再要求后台工作常驻 room。旧名 `background-joined-quiet` 对应当前 `background-active-quiet`。首轮 10 PASS / 2 join-precondition failures 的证据保留，不能把旧契约的超时冒充产品失败或直接算成通过。

## 确认语义与查询预算

首次 History 页捕获发布前沿作为“开始观察变化”的基线；它不声称已加载整个历史。已有基线时，最新页不能自行确认线程前沿：`afterVisibility` 只恢复其后的已发布记录，每批最多检查 **50 个原始位置**，确认只推进到实际返回并成功应用的可见记录。旧 R 的时间线位置不影响这种恢复。普通向上翻页使用独立的真实页边界，不会被补回的旧 R 跳过中间区间。

原始扫描位置仅在服务端保存，key 包含 thread、viewer 和 applied cursor。连续隐藏区间可以跳过；可见记录不会推进旧 key。新 key 只跳过其最后返回记录之后已判不可见的后缀。缓存最多 512 条，无 TTL；丢失或淘汰时重建，每次仍最多 50 个位置，不能假确认。隐藏-only 探测不返回 raw head、hidden ID、扫描位置或 pending 标记。

Redis 断言使用 500 条其他 owner 的 4 KiB 消息：基线建好后的不变探测只有一次 head `ZREVRANGE` 和既有 migration no-op，**0 条消息 HGETALL/HMGET**。新增 100 条隐藏记录后，每批 50 HMGET、0 HGETALL，两批推进完后再次回到 0 hash。只对通过可见性判定的增量加载全文；managed-hold 仅额外读取其判定确实需要的 scheduler metadata。线程归属读取单独计费，不能算进“0 条消息 hash”。Memory 遍历受已有保留量限制，按分配顺序选取增量，不全局排序。

周期探测仅覆盖可见、空闲的前台集合。积压分批在后续 tick 继续；没有新发布时不补读。新分配 seq 的变化是本轮保证范围；不分配 seq 的删除、restore、recall 等继续由原事件和显式 History 读取处理。后台实时缓存从未建立 History 基线、同页 owner/session 生命周期、真实 provider 与发行包仍不作为本轮已验收承诺。

实现继续复用 History 映射、ID 合并、重试与现有 Queue liveness；没有改身份、终态写链、Socket ACK 或新增持久化索引。架构归属仍是既有 History/MessageStore 与前台恢复入口，ownership map 无变化。

本轮提交前：API 反例与真实 Redis 13/13，Web 定向 159/159，标准隔离入口的 API 消息路由回归 414 pass / 4 skip，API/Web 类型检查及 Biome/diff 检查通过。4 skip 包含默认未运行的 Redis contract；它们已在上述独立 Redis 单独执行。Windows 无法运行的 6 个既有 Unix-socket Queue 用例未包含在该定向命令内。原 12 场景浏览器旅程将在冻结提交后复跑，结果与 exact HEAD 回填 PR 审查包，不将提交前状态当作本轮浏览器结果。

客户端按既有 semantic suppress 规则处理的记录也可以被确认；这里的前沿属于浏览器 History publication 集合，不是“用户实际画出的最后一条消息”。
