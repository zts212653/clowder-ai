---
feature_ids: [F143, F161]
topics: [acp, initialization, capability, evidence]
doc_kind: report
created: 2026-10-14
tips_exempt: {reason: "修正现有ACP传输握手声明，没有新增产品操作入口"}
---

# W2 首个接线：公共初始化合同

两条P0原型分别Go后，继续现有client的公共合同。STDIO/HTTPstream原本只发`protocolVersion:1`，没有clientInfo或clientCapabilities；两条实际构建入口的wire断言先观察到2项RED。

现在两者共用15行的`acp-initialize.ts`，发送client信息及真实host能力。`clientInfo.version="1"`标记这套ACP传输实现的合同修订，不是Clowder产品发行版本、模型/provider版本或成员/账号身份。当前host只处理permission request，fs/terminal返回method-not-found，故显式声明read/write/terminal=false；尚未实现的elicitation/session扩展不声明。原来省略能力同样表示未提供，未删除现有文件/终端方法；后续能力必须在实际handler/政策接线后再协商。

正式API build与61项构建入口回归通过，覆盖两个consumer、权限wire及factory。两个真实固定bridge进程各接受该initialize请求：Codex2.1.1/no-title、Claude v0.70.0/SDK0.3.285。只验证握手兼容，没有建立会话、发送prompt、工具或模型执行；Claude native未启动，HTTPconsumer仍使用随机测试端口的协议夹具，不能称已通过真实HTTP桥/生产审批。机器证据、schema/模块/日志与执行前留存source hash见[manifest](evidence/w2-initialize.json)。

这里没有新增配置、身份选项、存储、队列或路由。Architecture cell沿F161现有client，Map delta=none；抽出共用能力声明，transport/lifecycle保持原owner。完整dispatcher拆分、扩展协商、trusted instruction/model采用、北向capability provenance、W3.P及G2继续实施，当前窄接线不替代完整W2。

原型桥的fence/Notice/归属代码和bundle没有变化。本次只改变生产consumer握手，兼容smoke加受影响consumer/permission回归支撑连续性；W4.P/W5.P的Go只沿原fixed pins保留，不外推新能力。非作者 `/root/acp_plan_review` 在exact HEAD `160a02218e793b6b990c576eda52eb07030abfd3` 独立窄复核通过，无P1/P2；没有放行完整W2/G2或迁移。

完整PR的fallback诊断阈值也已回读：新模式主要是malformed输入/缺原生ID的拒绝、cap/owner校验和明确unknown，不增加供应商降级路径。parser结果提取在新叶模块，以parent/native ID配对，不借FIFO或默认成功补未知；journal异常转unknown/禁止重发。保留这些拒绝是当前合同的必要边界，不能以删除guard“过指标”。

作者检查：完整PR的Linux LF变更快照95个可检查文件通过；capability-tips13项测试通过，实际PR基线`449134fed`检查ok=true/无error，既有库存17条warning保留。默认本地origin/main比PR基线旧，首次默认检查把无关上游Feature纳入，未用它作当前PR结论。F143仅追加本轮阶段记录，因此明确限定tips_exempt，不宣告整个Feature完成。本repo没有skill提到的architecture-ownership命令/脚本，作为warning记录，以上Map delta说明供review核对。
