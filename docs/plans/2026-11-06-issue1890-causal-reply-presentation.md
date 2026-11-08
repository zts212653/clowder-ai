---
topics: [message, a2a, presentation, timeline]
doc_kind: plan
created: 2026-11-06
updated: 2026-11-09
---

# Issue #1890：关联输入与回复的可恢复阅读

来源：[Issue #1890](https://github.com/zts212653/clowder-ai/issues/1890)、[PR #1892](https://github.com/zts212653/clowder-ai/pull/1892)。维护者的[产品与契约反馈](https://github.com/zts212653/clowder-ai/pull/1892#issuecomment-6690349434)是本次修订的验收依据。

## 问题与边界

当前执行模型在开始时预建回复 R，后来输入 S 可接入同一执行。R 的累计正文原位更新，因此后来生成的文字可能仍出现在 S 上方。它与旧 #1082 的“完成时新增消息，却插回开始时间”机制不同；不能恢复按 completedAt 排序，也不能把整轮 R 移到最后。

History 的 messageId、orderKey、单份累计正文及执行记录仍由原 owner 管理。Web 显示同一 R 的范围引用，不创建 History 消息、未读条目或第二套持久正文。显示范围的先后不声称等同于 Agent 逐句生成、读取输入或业务完成的先后。

## 切点只作显示证据

公开输入接入时，Host 从 InvocationTracker 中绑定 exact run 的 getter 读取当时已观察的 `textContent.trimStart()`。正式 R.content 完成前可能为空，DraftStore 又按阈值写入，二者都不能代替实时快照。

- 在现有 append admission / projected wake coverage 事务中随 inputMessageIds 原子写可选 appendBoundaries：inputMessageId、UTF-16 contentOffset、前缀 UTF-8 SHA-256。
- hash 只证明当前前缀与采样时一致；不证明 native 当时已读 S、后文专门回答 S，或 S 的工作已完成。读取、投递与执行结果分别沿用各自真实回执。
- 同一 native run 可跨越 S；多个输入可以具有相同切点并共享后续范围。保留 admission 顺序，重复 admission 不覆盖原切点。
- getter 按 thread/cat/invocation/response 绑定并随执行清理。已写切点随 R 持久化恢复，不建立额外 cursor 恢复仓库。
- 缺 getter、切点不完整或超上限时保留整轮正文，不阻止合法投递；旧历史不猜切点、不迁移。
- 正文替换、前缀失配、未知/拒绝/未完成的追加执行不推导精确范围。exact read 可覆盖 pending 或晚到拒绝，不能覆盖已知 incomplete 的内部执行结果。
- 私有输入身份不进入公开 R 的显示证据。

## 阅读与操作

有完整证据且相关消息已在窗口时，R 保留前文与执行记录，S 下方显示接续范围。同切点的回复入口跳到后继实际文字。原生 outputLayout 继续采用既有过程/最终回答分层和个人 process-talk 选择；工具记录留在 R。切进 Markdown 语法的范围按字面原文显示，完整格式化原文仍可读取。

精确范围失效只能撤去分段，不能撤掉 S 的整轮结果入口：

- 沿 S 的 exact dispatchRef 提供整轮原文读取，即使 R 在旧页、缺另一条 S、没有切点或 hash 失配。
- 复用受权的 History HTTP 投影，按 exact anchor 作一次有界读取；不遍历整段历史，不改变主时间线的分页 cursor/hasMore。
- 展开的原文只是读取期间的引用视图，不写回 History。关闭回到 S；刷新和重连重新读取服务端结果。关联输入不在窗口时也可按已记录的 ID 读取。
- 读取中、不可用、撤回都按实际状态显示；不可用不区分泄露“已删除”与“无权读取”。R 的执行结束不标成 S 的业务完成。
- 部分正文和缺页文字引用只保留绑定 R 绝对坐标的选区操作。整轮播放、转发、删除等保留在原执行记录，并明确作用于整轮回复。文字引用不冒充工具、附件与轨迹的完整投影。
- 新切点或校验晚到时，若现有阅读锚点位于该回复或其接续，先保留已提交的显示范围，正文仍继续更新；读者离开后，后续投影更新可采用新切点。只保留切点数量，不保存另一份正文或滚动状态。
- 明确点击原文入口由现有阅读 owner 定位展开区域；自动刷新不重复定位。沿页面现有连接接收删除、撤回、恢复事件；撤回会中止旧读取，旧 HTTP 结果不能重新显示正文。

## 可复验验证

所有实验使用隔离数据，不修改运行实例或用户历史。前端组件 fixture、真实 HTTP/存储链与原报告现场分别记录，不把模拟 socket/hydrate 当作真实 provider 验收。

历史基线 `d5ec358b31ed85126c4fa2731ba385e10f928455` 的[CI](https://github.com/zts212653/clowder-ai/actions/runs/42251417711)已通过；API 46+33、Web 40 与新增 2 项、[浏览器回执](../../artifacts/issue1890/browser-results.json)可复用其确实覆盖的部分。浏览器证据包含真实 ThreadChatSurface/样式、R 的绝对选区 13–31、刷新、两种 shell、390px、native 分层与同切点导航；API/socket 为 fixture。

初始基线是 next@132dfa8d；后续实际合流 next@c14eed1c4，再合流 next@39b5fd89b。当前修订需要在实际合流上验证以下新增路径，不能用旧基线全绿替代：

1. getter → 两类 admission → 存储重读 → HTTP / 成员 full payload；失败事务不写入半截 boundary/ref，完整 R 只读一次，不复制 Web 分段或重排 cursor。
2. S 在窗口而 R / 中间 S 不在窗口；同切点、多目标、正文变化和无可靠切点时，仍能读实际结果并回 S。
3. 刷新、重连和服务端持久重读；精确 anchor 请求有界且遵循原可见性/授权，跨 owner/thread 不泄露数据。
4. 延迟 proof 不抢读者滚动；native 分层暂态与原 useReplyOutput 对照。阅读位置继续归现有 reading owner。
5. 部分正文没有整轮操作入口，选区引用仍指向 R 的正确坐标。

原本机 Redis 夹具因缺 redis-server/Unix socket 受阻，未计作通过；Windows 路径/CRLF 导致的全仓检查限制也保留。当前修订须以隔离环境或对应 CI 的实际测试记录补证。

新增 `issue1890-append-boundary-redis.test.js` 通过隔离 Redis、两类 callback admission、新 client/store 重读、History anchor 与成员 full/drill 验证存储链；这不等同于 Redis 服务进程重启或真实 provider 验收。旧切点/accumulator 共 46 项已转为 `.test.js` 读取编译产物，以进入现有公共 shard，不修改公共发现规则。

浏览器使用真实 ThreadChatSurface、样式、消息动作及 callback getter/admission/MemoryStore/History handler；浏览器会话和 provider/socket 为隔离 fixture。回归包含两种 shell、390px、绝对选区、缺页与分页保持、重载、校验延迟时 0px 阅读漂移及离开后启用已验证范围。HTTP 权限拒绝由独立 route 用例验证，Redis 由对应 CI 实际执行。

## 回退

appendBoundaries 可选；撤销本改动即恢复整轮正文显示，不删除、重置或改写历史。合入 next 与安装版部署分别验收。
