---
topics: [message, a2a, presentation, timeline]
doc_kind: plan
created: 2026-11-06
---

# Issue #1890：补充输入后的接续正文

来源：[Issue #1890](https://github.com/zts212653/clowder-ai/issues/1890)。用户消息 `0001793962764826-000213-0e0ae9de` 授权共同设计、独立 worktree 实施和目标 next 的 PR，并邀请 zts212653 / mindfn 审查。Task：`0001793962844408-000215-2ffb0d41`。

基线 `upstream/next@43c1c3cb7e4e2ba0285c993d5cc5bd016824a663`。工位 `G:/AIwork/clowder-ai/cat-cafe-issue1890-causal-replies`。砚砚负责 Web、整体验证与 PR；鲸鲸实现 API/shared，砚砚独立审这部分；鲸鲸审 Web 与集成。作者不审批自己的代码。

Architecture cell：现有 bubble-pipeline / lifecycle admission。Map delta：none；Queue、MessageStore、TurnExecution、正文与执行终态的 owner 不变。

## 问题与完成条件

旧 #1082 在完成时新写回复却插入开始时间的旧位置；当前模型在开始时预建 R、处理中接入 S、累计正文原位更新。A2A 已成功，固定排序契约造成后续正文留在 S 上方。不能恢复 completedAt 排序，也不能把整个 R 移到最后。

可见结果是：R 的前文与执行记录 → S 原文与回执 → 同一 R 的接续正文。实时接入、最终完成和刷新应一致。原 R 的 ID、orderKey、完整正文、未读计数、复制/转发/删除身份继续唯一；接续是显示引用，不创建 History 消息或第二套事件存储。

## 讨论后采用的方案

鲸鲸反例 `0001793963432171-000236-4aaddefd` 证明 run 级首次 observedAt 切不开同一 native run 中途继续增长；因此撤掉初稿的 observedAt/speechRanges 与派生顶层行。逐 delta 保存范围增加体积，也不是本 issue 所需。

正式 R.content 完成前可能为空；DraftStore 按时间/字符阈值异步写入。不能读取这两者猜当前切点。采用现有 InvocationTracker 的 exact-run getter：

1. route 收到 invocation_created、已有 canonical R 后，登记读取当前 textContent 的闭包。正文累积仍归现有 output projection，不逐 delta 复制正文或计算 hash。
2. 公开补充输入被采用时读取 getter，对 `textContent.trimStart()` 计算 UTF-16 长度和 SHA-256；切点来自此时 Host 已观察的正文，不从 S 发送时间推算生成因果。
3. 现有 append admission 的同一 lifecycle CAS 随 inputMessageIds 写可选 `appendBoundaries: [{inputMessageId, contentOffset, prefixSha256}]`。重复 admission 不覆盖原切点，私有输入不向公开 R 暴露身份。普通 message_wake 的 projected wake coverage 事务也必须传入同一证据。
4. 未登记准确 getter 时不猜 0；展示证据缺失或超上限不能阻止合法 A2A 投递。切点不完整时保留全文。
5. getter 按 thread/cat/invocation/response 绑定并随执行清理。已持久化切点供刷新恢复；重启的旧 run 按既有规则中断，新 run 只读取自己的正文，不建立另一份 cursor 恢复仓库。

使用 trimStart 坐标兼容流式前导空白与最终 trim，Web 加回当下正文的前导长度得到绝对源坐标。replace、rich/concierge 清洗若改变前缀，hash 校验失败就保持完整正文。字段不分类 native phase，不修改 outputLayout。

## 界面与引用

墨墨一次形状校准 `0001793963288599-000231-6598d6cb` 推荐保留原执行锚点，后续正文以同猫接续呈现，复用名牌与左色边。布偶猫首次调用因 provider 403 中止，不记作设计通过。

- R 原位保留前文、完整执行/工具/状态/作品及“查看完整原文”。S 后只显示已验证正文范围；没有前文时保留执行壳。
- 接续块挂在 S 行之后，不新增顶层消息 ID，不参与 viewport 排序、分页 cursor、未读或批量选择。批量选择模式恢复 canonical 全文。
- 接续块使用自己的 MessageActions，绑定原 R，位于 S 动作树之外；不需要扩展 TextSelectionAction.sourceMessageId。NativeReplyText 的绝对 UTF-16 坐标继续映射 R 正文；全条操作仍操作 R。
- 同一 provider run 跨 S 也按 offset 精确切。切进代码围栏/行内 Markdown 时按字面原文呈现，避免解析吞字；原执行可展开完整格式化原文，不猜段落或把整段搬走。
- S 的“看回复”在有已验证接续时聚焦接续块，接续可回到原执行。源的 exact dispatchRef 必须仍指向 R；接收未确认、明确拒绝、改绑其他响应、撤回、源/目标不在当前可读页、私有响应、证据不完整、body 替换或 socket 尚未追上时保持原呈现与导航。
- 工具留在原执行记录。接续无新增正文时显示真实等待/无新增事实并提供原执行入口；不声称重排工具，不伪造确认话术。
- 原生 `outputLayout` 经完整正文校验后，复用既有 `projectReplyOutput` / `ReplyOutputBody` 并裁剪对应范围；保留过程/最终回答与个人 process-talk 选择。完整工具与过程记录仍归 R。连续输入具有相同切点时，回复入口跳过空范围，定位后继正文。
- “查看完整原文”明确查看 canonical 累计原文，包含过程文字与最终回答；这与默认正文的 native 分层用途不同。内部追加执行 `incomplete` 时不推导接续，保留完整正文；exact read 回执可覆盖 pending 或晚到拒绝，但不覆盖已知 incomplete 的执行结果。

## 验证与限制

独立 fixture 与 worktree 使用开发依赖，不连接生产 Redis，不修改安装版或真实用户历史，不通过模型调用制造输出。

- RED：同一累计 run 跨输入、连续 adoption、source 不可见/前缀替换；行为断言先失败，再实现通过。
- API/shared：exact-run getter、实时正文而非正式空 body、幂等 CAS、whisper、legacy、terminal 保留、缺失/超上限切点不影响投递、full MCP read 的 message_wake coverage 入口。
- Web：单 run、多个/相同切点、UTF16/前导 trim、取消后已输出文本、滞后 snapshot、替换、现有 native reply 与行渲染回归。
- 浏览器：实际 ThreadChatSurface、MessageActions、NativeReplyText 和真实样式，隔离 API/socket 数据；运行中接入→续写→完成→展开全文→刷新，引用落到 R，回复跳到接续，classic/v2 与窄屏。
- shared/API 编译、Web tsc、Biome、diff check。浏览器 fixture 验证前端，不冒充真实 provider 或部署验收。

当前实际验证回执（2026-11-06 至 11-07，隔离工位）：

- `node --import tsx --test test/issue1890-append-boundary.test.ts test/f322-message-output-accumulator.test.ts`：46 通过。
- API 的 callback-context-adoption-exposure、route-parallel-parent-invocation-id、1398-history-append-ownership、1398-append-read-observation 四套编译后测试：33 通过。含真实 Fastify 全文读取采用，以及串行/并行实时 getter 和释放断言。并行新增断言修改前以 `undefined != qwen body` 失败，修改后通过。
- Web 八套受影响回归：40 通过，随后新增 incomplete/真实读取优先级 2 项并复跑受影响投影与导航 11/11 通过；其余 31 项无实质变更、沿用前述回执。包含原输出分层、选择映射、聊天行隔离/导航、撤回和 ThreadChatSurface，以及实际 deferred owner 同步挂载和同切点导航。
- 审查修正 RED：恢复旧导航逻辑后，S1/S2 同切点测试实际聚焦 S1、预期 S2；禁用原生投影后，真实浏览器无法找到原生分层正文。恢复修正后分别验证新行为。屏外挂载已有 MOUNT + flushSync，组件反例验证成立；异步 proof 的滚动重排仅保留观察项，沿用既有 reading-anchor owner，不新建滚动控制器。
- 鲸鲸对 `98244797a` 的最终非作者审查 `0001793981711588-000074-2f0e31ac` 无 P1。两个补充点：完整原文作为刻意的全量视图，已补 native 展开浏览器断言；incomplete 的投影用例实际 RED（预期 0、实际 1），增加限制后 GREEN。exact read 优先于 pending/晚到拒绝的现有共享契约也补测通过。
- `pnpm --filter @cat-cafe/api exec tsc`、Web `tsc --noEmit --incremental false` 均通过；鲸鲸回执 `0001793965701735-000288-b00c58d1` 确认完整 API build 通过。同步 `next@132dfa8d37c3cc48f84799d6c02d9d9072d723c8` 后再次通过 Web 类型和浏览器验证。
- 浏览器实际 ThreadChatSurface：实时接入/完成/展开全文/刷新/390px/classic/v2/引用/回复聚焦通过。新增原生 commentary 留在原执行记录、final 出现在接续，以及 S1/S2 同切点跳到 S2 的断言通过。选区引用绑定 R，源范围 13–31；canonical R 只有一条，pageerror 为 0。证据见 `artifacts/issue1890`，其 API/socket 都是隔离 fixture。
- 额外 `1398-private-append-projection.test.js` 的 5 项被本机环境挡住：`spawn redis-server ENOENT`，夹具还要求 Unix socket。没有连接运行中的 Redis，没有把这 5 项计作通过；新增 whisper 单测通过。
- 本机完整 `pnpm check` 在既有 F290 产品文案扫描测试遇到 Windows 路径分隔符断言差异，未计作通过；Linux 首轮 CI 已通过该段，只在新增 JSON/MessageStore 格式报错，已按同一 Biome 规则修正。
- 本机全仓 `biome check .` 因 Windows checkout 的 CRLF（含未改动的 `biome.json` / `tsconfig.json`）产生格式失败；不批量重写基线文件。只格式化本 PR 变更文件，最终以这些文件的检查与 Linux CI 核对。

旧历史没有可靠切点，保留全文，不推算或迁移。工具时间线继续由原执行承载。搜索结果仍定位 canonical R，R 提供完整原文入口。API 中断/取消沿用现有正文保留规则。

## 回退与交付

字段可选；撤本 PR 即回到完整正文展示，不删除或重置历史。最终 PR base=next，在正文点名维护者讨论数据契约和呈现，并取得非作者范围审查。用户未授权本轮 merge/deploy。
