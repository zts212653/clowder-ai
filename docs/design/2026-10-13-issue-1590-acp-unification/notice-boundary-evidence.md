---
feature_ids: [F143, F161]
topics: [acp, claude, notice, cancellation, evidence]
doc_kind: report
created: 2026-10-14
---

# W5.P：真人等待、多条 Notice 与取消

本轮补齐了真实 elicitation、多条 Notice、已排队取消及一次 SDK 升级演练。随后追加[native2.1.299升级](evidence/w5-native-upgrade.json)，[W5.P已独立Go](prototype-gates.md)。G3与迁移仍held：这不是生产真人交互UI、完整binding/维护预算或continuity验收。原始轮次机器清单及当时的held保留在[manifest](evidence/w5-notice-boundaries.json)，阶段判定以最新门禁回执为准。

## 发现与修复

固定 v0.70.0 bridge / SDK0.3.232 / native2.1.296。普通公开 `Query.interrupt()` 没有传 native `cancel_queued`：真实 [失败样本](evidence/w5-boundaries-2.json) 中 Notice 在取消后仍 queued→started→completed，主结果出现 aborted_tools。该行为是实际 No-Go，不能用本地 iterator 已结束证明撤销。失败包保留。

隔离补丁在 native 声明 `interrupt_cancel_queued_v1` 且实际 Query 存在 `request` 方法时，调用一次 `request({subtype:"interrupt",cancel_queued:true})`，要求 `still_queued=[]`、合法 `cancelled` UUID 清单。initialize 的 prototype Notice 路由声明不等于某 binding 支持 next；该 binding 缺 seam/native cap 时运行时入场拒绝。非法回执、未确认 SDK ingress 退役旧 query，不推断未执行，也不回退成 preempt。

非作者审查进一步发现并关闭：并发 cancel 提前清 admission、退役丢 active 已知 usage、resume_empty 重试取消误分类。相应反例先 RED；每 session single-flight cancel 在同一 finally 同步释放 promise/barrier，queued-never-ran 无 usage，active 保留已知累计值，重试仍为 cancelled。取消后的新请求不能绕开生产客户端 quarantine。

## 实际验证

| 样本 | 固定环境与结果 | 证据范围 |
|---|---|---|
| [boundaries-5](evidence/w5-boundaries-5.json) | SDK0.3.232 / native2.1.296；34.352秒 | MCP 发出真实 elicitation，固定布尔回答由合成测试 host 延迟3秒；等待期间主请求未结清、两条 Notice 未启动；回答后按序启动，native result 关联两 UUID。取消已 queued Notice 后 native lifecycle 为 cancelled；新原生 prompt 后旧 Notice 仍未启动。 |
| [sdk-upgrade-2](evidence/w5-sdk-upgrade-2.json) | SDK0.3.285 / 同一 native2.1.296；31.917秒 | 对齐依赖/类型后复跑同一实际链路，执行前保存运行器/执行参数/SHA；证明这一次升级兼容，不代表完整版本矩阵或成本预测。前一次升级样本另保留。 |
| [ingress-1](evidence/w5-ingress-1.json) | SDK0.3.232 / 同一 native2.1.296；22.747秒 | 显式测试钩子在真实 SDK 输入泵持有 next 2秒；桥已接收、尚无 native lifecycle。取消退役旧绑定，新 prompt 明确 session ended；实际 native PID 退出，之后8.5秒 Notice 未启动、只读工具未 completed。 |

ingress 的本地 cancelled 回执先于原生退出约7.054秒，不能写成即时静止。回执 usage 只是已观测 session accumulator；未获完整 native result 的新增 usage/cost 保持 unknown，不能把观测0当实际费用0。该故障钩子只用于独立构建的 `claude-ingress-fault`，不是生产功能。

两个普通样本的“新原生 prompt”通过隔离 raw bridge 验证 native 队列；生产 AcpClient 的已取消 session 并未重开。production elicitation handler 尚未实现，测试只确认固定 form 的真实 SDK/bridge 语义；不宣称平台真人审批 UI 通过。

baseline 与 ingress 的实际未改写运行器已在运行后留存并记录SHA；baseline 结果从原执行目录归档到 boundaries-5，路径差异明确记录。历史失败/首个升级样本未在执行前冻结 runner，保留其 raw wire 事实及限制，不能用当前 runner SHA 冒充。最终升级重放在调用前保存实际两份源文件及参数，补齐可追踪链。

受影响检查：原型 cancel/interrupt/usage/steering/next 110通过；回执 schema helper7通过；API 实际构建入口129通过（含恢复重试取消）；旧 Windows print/SDK launch71通过。Windows 测试现在按实际 inline/file MCP 合同读取 JSON、按平台规范化图像路径，未改启动实现、未删功能断言。正式 API build 通过；升级编译及升级的36项检查通过。命令/log hash 在 manifest，未声称全仓测试通过。

## 私有 seam 与维护要求

`Query.request` 是固定 SDK 的非公开实现入口；`cancel_queued` 是 native capability，不能写成 ACP 社区或公开 SDK 已接受的 API。当前扩展/补丁均为本地原型，未发布社区消息。必须同时锁 bridge、SDK、native、schema、依赖和生成 bundle。

这一次 SDK 升级先观察到真实编译失败：旧 `mid_conv_system` 类型已退役，新增 `mcp_tool_listing`，以及 SDK peer 通过 zod@3 的 v4 shim 与桥 zod4.4.3 类型不一致。隔离构建复制实际 SDK artifact、按其支持的 ^4 peer 对齐，并将新增 listing 放入原有不渲染内容分支；这不证明工具发现能力或整个桥在新 SDK 上等价。原 npm lock 只作历史 pin，不冒充新 lock。

后续每次升级必须检查 seam/cap/schema、重复 cancel、pending ingress、已知 usage/unknown cost、所有权及真实同合同样本；缺 seam/cap/schema 时 fail closed 并保持原服务。完整 G3 仍要求维护归属、发行物、至少两次升级演练、真实工时/回归成本和预算。当前只有一次 SDK 升级，不外推月成本。

本轮由 `/root/acp_plan_review` 独立复核，三个取消/计量/分类问题，以及末轮发现的路由声明措辞和未完成样本覆盖问题均已关闭。实际旧 runner 的无网络反例先观察到 trace 被清空；现在首次写入前原子 mkdir 认领目录，已有/未完成尝试直接 EEXIST，保持原 trace 不变且不进入网络。原始/脱敏 SHA、真实故障时序及维护范围已独立核对，无新增实现 P1/P2。该回执只确认本轮代码和有界证据；完整 W5.P/G3 继续 held。旧阶段、Codex W4、正式 W3、V24-C 与迁移各自重新审查，不能借本回执放行。
