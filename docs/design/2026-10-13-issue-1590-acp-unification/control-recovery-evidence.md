---
feature_ids: [F143, F161]
topics: [acp, control, recovery, evidence]
doc_kind: report
created: 2026-10-14
---

# W4.P：控制回执的恢复与对账

最新判定：恢复、活动寿命分离及追加A→B重复已在[原型门禁回执](prototype-gates.md)分别核对，W4.P Go。本报告保留各轮样本与当时的held边界；生产W4/G3与迁移仍未通过。

原本的桥内 Map 会在 owner 重启后再次调用 native；五个新反例均先 RED。现在隔离原型在 native 调用前以 operation/binding/session 为键持久认领 intent，写明 caller target、输入 hash 和稳定 native clientUserMessageId；原生接受后先持久写回执，再返回 ACP。相同 operation 的不同 target/content 拒绝，跨 binding 拒绝，缺记录/损坏记录/无法核实结果都不能重新注入。

receipt 查询先复用经校验的持久原生回执；丢 native 回执时，调用实际 CodexAcpClient 的 native thread/read 历史，要求同 native session、原 target turn、唯一 clientId、完整文本输入 hash 全部匹配。只有准确原生证明能收敛为 injected；不存在、读取失败、歧义等保持 outcome_unknown，不能以未查到推断未执行。injected 仍不等于模型已采用或任务完成。

21 项确定性检查包含：可控 A→B fence、冷 owner 去重、并发 claim、丢回执、未知结果不重发、外国 binding、输入修改、持久写失败、空 claim、合法 JSON 缺证明/错误 target/clientID、返回对象污染。独立审查实际复现两个 P2：对账后活 owner 仍保留 rejected Promise，以及坏原生证明被 accepted。分别留存 RED→GREEN，已将确认终态写回缓存、严格校验两种原生证明并隔离返回对象。

真实固定 bridge 2.1.1 / native 0.161.0 在同一个受限只读回合中发送三个不同 operation：

1. host 丢弃一个真实 ACP steer 响应，持久查询恢复原回执。
2. native 真正接受后，测试钩子在桥写回执前抛错；仍存活的 owner 从原生历史对账，重复请求返回确认终态。
3. 同样丢 native 回执，关闭桥进程并创建新的桥/native 连接；session/load 恢复已执行回合，查询精确原生历史后确认，并且重复请求不再次执行 native。

最终约 20.044 秒，三个 native steer 各一次；原 target 原值、三个不同 client ID 与原生历史证明可核。测试钩子是明确的接受后丢回执故障注入，不称为实际网络事故。确认与 raw wire hash 见 [机器证据](evidence/w4-control-recovery.json)。hooks/仓库指令/shell/apps/skills 禁用，只访问合成哨兵；本样本一个ACP workload prompt，观察native turn/start一次/title零次，底层provider轮次和费用未知。限制为90秒prompt、工具8秒/12次，没有native USD硬上限，历史预算字段解释见预算纠正。

早期失败保留：从未执行 prompt 的空 session 没有 rollout，不能跨进程冷恢复（无模型调用）；第二次丢包夹具把查询响应也丢掉，修正夹具后通过。不能把这些运行器失败当作 native fence 失效，也不能删掉失败记录。

持久性证据覆盖桥进程退出/重启。临时文件 fsync 与 rename 没有证明 OS 崩溃或断电目录落盘；生产不得采用该隔离文件 journal 代替现有 durable operation owner。原子 claim 的孤儿不能靠超时偷取，数据损坏会 fail closed。真实测试在回合终态后重连，未验证活动回合在网络断线期间持续存活。

非作者 `/root/acp_plan_review` 复审确认两项 P2 闭环，并核对实际 primary/restored wire 分别3/0次 steer。该回执补齐已明确的丢回执/冷恢复缺口；完整 W4.P/W4 和整体迁移仍保持 held，待全部验收条件确认。Claude 的 W5.P、正式 W3 审批、V24-C 和回滚不由该结果自动放行。

## 追加：活动 STDIO owner 退出

真实固定环境追加一次只读回合。fixture started后约123ms，native 接受一个 caller A 的 exact steer；随即结束 bridge 的 STDIO 输入。bridge 约2.020秒后exit0，主请求报进程退出，fixture仅started，两侧均未记录turn/completed。本次总耗时11.972秒；退出后新bridge session/load 恢复同一会话，drop后约2.746秒取得原回执且没有重发旧operation；snapshot 的当前turn为空，新operation携旧A target被实际native拒绝 `no active turn to steer`。原始wire和哈希见[追加证据](evidence/w4-active-owner-drop.json)。

这里的通过只指历史对账、无重复和旧目标拒绝；**活动turn并未跨owner退出存活**。上游 index.ts 的 ACP stdin close 会结束 native stdin 并设2秒终止后备，这个生命周期需要在统一方案中明确承接。测试没有模拟socket丢失而owner仍存活，也没有与原Codex服务做同条件差分；因此不称已证明原服务能力退化或ACP协议不可行。

后续应将可重连consumer与原生/bridge owner寿命分开，复用既有runtime/lease/durable owner，再实测活动A跨断连、有效A/stale A以及重复工具/控制副作用。owner已退出的旧injected回执只保留历史接受事实，不能投影为现在仍可控制的turn，不可隐式启动新turn“恢复”。完整W4.P和迁移继续held，新增范围经非作者定向复核。

## 追加：分离 owner 寿命的实际原型

已公开专用只读 test owner 与运行器。bridge/native STDIO 由同一 owner 持有，临时 loopback HTTP 只承接调用方请求。实际中断一个进行中的 HTTP prompt response 后，新 HTTP 请求仍看到原生A；断线前后各一次有效 steer 原样把caller A交给native，均接受A。重复旧operation没有额外注入，fixture只started/completed各一次，A结束后旧target被native拒绝。原prompt的end_turn确实丢给已关闭consumer，不冒充已经持久保存。

最终 stable-owner-4 总耗时17.977秒，native initialize一次、turn/start一次、steer三次（两次接受、一次完成后拒绝），标题turn零次；改变initialize capability参数的409拒绝也实测。只对同一冻结initialize参数重放先前接受的结果，这不是再初始化native，也不是生产会话恢复。caller仍是同一测试进程的新HTTP请求，未验证整个host进程crash；生产AcpHttpStreamClient、runtime/principal/lease/persistence owner尚未接线。[机器回执](evidence/w4-stable-owner.json)明确这些限制。

原型证明了寿命分离这条技术路线；生产实现仍需接现有owner而非发行临时test gateway。必须区分consumer detach和用户cancel，审计principal/lease转移、持续保存离线事件/最终回执；调用方失联不能丢done或以盲重发补偿。正式差分/连续性与独立Gate继续执行。

预算计数审查发现原首轮fence实际为3个工作load turn加1个自动title turn；stable-owner-1也有额外title。历史“modelTurns”字段并非所有模型请求的硬上限，已按[预算纠正](evidence/codex-budget-audit.json)分别记录，保留原始失败预算样本。后续独立no-title原型仅在测试flag启用时跳过自动title，默认标题行为保持；test owner拒绝第二个ACP prompt并有90秒watchdog/3秒退出grace。一次native turn可能包含多轮provider推理，底层请求数/费用未知，没有native USD硬限，不能写成总共一次模型请求。
