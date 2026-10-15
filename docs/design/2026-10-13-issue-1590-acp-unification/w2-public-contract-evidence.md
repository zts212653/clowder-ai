---
feature_ids: [F143, F161]
topics: [acp, contracts, tool-results, telemetry, evidence]
doc_kind: report
created: 2026-10-15
tips_exempt: {reason: "修复既有 ACP 事件与执行合同；新强身份合同仅供隔离验证，尚无新增用户操作入口或默认迁移"}
---

# W2 公共合同实施与验证

本阶段在现有 STDIO/HTTPstream client 内抽出共同叶模块，未另建 client、持久 store 或 UI renderer。原生服务及默认路由保留；W2 公共合同实现不能批准 W3、完整 G2–G5 或整体迁移。

## 实物与边界

| 合同 | 当前实现 | 仍需要的原生证据 |
|---|---|---|
| JSON-RPC/初始化 | numeric/string ID 保持类型；协议版本拒绝；完整声明私有不可变快照；unknown/raw refs保留；公开来源只投影白名单与hash | 每个部署的实际binding与版本仍需各自验收 |
| 会话 | 按声明选择load/resume，无声明不试探；恢复ID不能替换；close与本地进程close区分；close入场同步退役scope、并发请求去重 | W3的replacement provenance、取消后工具静止与完整恢复政策 |
| 内容/工具 | text/resource link基础；image/audio/embedded resource协商；深拷贝输入；native ID、rawInput/content/rawOutput、失败、partial/null、晚到final input、terminal幂等 | 音频/resource的实际模型binding未取得L2；不是所有成员的内容验收 |
| 子执行 | 固定Claude vendor `_meta.claudeCode.parentToolUseId`映射至native parent；内部tuple(parent,id)，持久/UI再按execution范围配对 | 其他桥的child语义与origin/run/principal需要各自合同；不从title猜parent |
| Prompt终态 | 保留完整usage/_meta/unknown result；手动观察generator return；cancelled/refusal/max*不触发空恢复重发；全部尝试的raw receipts保留 | native RPC取消回执不能证明工具/后台进程静止 |
| 模型 | 真有model选项时匹配实际value/显示名及当前alias，设置后必须readback；非法值/采用失败不静默跑default | 无model通道的legacy路径标unknown；强要求阻断；servedModel不能复制requested |
| 可信指令 | required空输入在acquire前拒绝；分离system/developer正文、revision/role/hash/nativeSource applied receipt；恢复/替换同合同 | 当前两fixed桥未协商新namespace；W4/W5需补正向原生通道和行为反例，强身份成员不迁 |
| MCP | required名单缺失或transport不支持，在session请求前拒绝；沿既有resolver/credential owner | 实际requiredTools、skills/hooks和政策应用由W3–W5证明 |
| 执行绑定 | 协商后才读typed binary/account/policy fingerprints；错session/畸形回执拒绝；公开投影排除任意auth字段 | bridge_reported不是native/deployment verified；两fixed桥目前拒绝新execution合同，W4/W5补原生采用 |
| 能力来源/池 | connection/declaration/launch fingerprints分开；launcher/显式文件实物bytes、env/profile/config/policy变化使pool签名失效；公开hash不含env明文 | outer launcher hash不证明inner native executable；实际采用与deployment仍unknown |
| 遥测 | context used不冒充last input；session累计cost保留货币/scope，不填invocation costUsd；prompt scope仅在initialize协商后解释；snapshot替换、带ID delta只加一次；换session清当前投影、旧值留raw receipts；有效标准 used/size 恢复产品上下文 authority 与现有阈值消费 | 实验性prompt usage语义缺声明则unknown；上下文 authority 不等于 native executable/account/deployment verified |

`executionRequirements` 通过factory内部验证入口传入，不改变公开成员配置或默认开启迁移。没有要求的legacy ACP路径明确记录`legacy_user_prefix_unverified`/`legacy_spawn_intent_unverified`；不能把旧正文前缀声称为trusted role。

## RED → GREEN 与独立审查

先观察工具25项RED、prompt终态13项RED、公共合同16项RED、内容3项RED、指纹2项RED，以及production CLI UI最终输入2项RED。逐项修复后跑全部受影响ACP/Claude检查，未用模型或mock结果冒充L2。

独立审查者 `/root/acp_plan_review` 在`4a63c227fab8710691746854117e17c2347a46e8`发现父scope/空必需指令两P1、close并发/usage协商两P2；7项及4项失败检查均已留存。在`236a22574653f56c8adca34819bfe523da960638`复审确认上述闭环，又发现跨session/partial snapshot的用量混合，5项RED复现后修复。作者没有把修完当成通过；最终复审目标/结果由下方manifest记录。

完整原始日志留私有`.cat-cafe/tmp/`；公开索引只含统计、hash、来源/范围与脱敏结果，见[证据manifest](evidence/w2-public-contract.json)。完整PR使用真实base `449134fed1b08e5cf2a05a72817b84f163baf180`检查LF格式；既有Windows POSIX路径断言的9项失败独立列为基线，不称全仓绿色。

zts 后续指出 `eab5082c` 把标准 context authority 与原生身份验证混为一谈。真实消费反例确认统一 false 会阻断 `resolveAuthoritativeContextUsage`、context health/continuity；该提交的旧窄审不覆盖这个新发现。已用六项 STDIO/HTTP RED 复现，再在 `652ff67fe78fc0d71018e45a1338b39aac5f1f3b` 恢复有效标准 used/size 的消费；下一 invocation、无效/缺字段不会继承证据。14 项检查越过 service 到真实容量 snapshot 与策略 API，验证 handoff 从 unavailable→active→无新证据时 unavailable。

Kimi 的窗口控制只由 factory 的实际 `KIMI_MODEL_MAX_CONTEXT_SIZE` 与解析窗口一致时启用；保留原进程配置及 pool 退役行为。OpenCode 现有配置明确不生成 model limit，旧按 provider 名宣称 setter 属过度声明；标准报告容量与阈值仍可用。143 项相关 API 检查及 84 项现有成员编辑组件检查通过，包含真实 `/api/config/session-strategy` 与 `/cats` 投影的本地集成；没有将夹具当成 Kimi/OpenCode 正式绑定的 L2 验收。该两绑定的真实采用仍需 W6，不能宣称整体不退化已经证明。

独立审查者随后对精确 `652ff67fe78fc0d71018e45a1338b39aac5f1f3b` 给出 approve、无未结 P1/P2，确认编译产物和上述消费链一致。该结论限公共 consumer 与本次 context 修复；不批准完整 G2–G5、原生采用或迁移。

## 真实桥支持判定（L2边界）

有界[运行器](../../../scripts/acp-spikes/run-public-contract.mts)在调用前冻结执行源、桥/native artifact hash，使用已授权的隔离profile与合成fixture；不读真实认证，不发送ACP prompt。实际Claude/Codex均能initialize、读当前模型value并确认、按声明调用原生session/close。两者的新namespace未协商，required instructions在session前阻断，execution read不发试探请求。该真实结果支持“判定和拒绝正确”，不能证明新的正向原生增强已采用。

guard固定安全选项的Claude样本只证明该隔离binding；不证明生产principal/policy/审批或L0注入。native executable/profile/account选择事实、固定pins和旧增强原型证据继续沿既有manifest，不把agentInfo当安装事实。

## 原始需求、质量与下一门

用户要求沿#1590统一方案实施、每阶段真实证据和独立审查、既有能力不下降。本阶段修的是实测合同缺口；不删除未知能力，不将scope、精确取消/计量或served model从协议表达推断为可用。CodeAgentCLI/MiniMax由用户明确暂时跳过，状态为未验证，不能记PASS。

Architecture cell：既有ACP provider/client及tool/transcript/MessageStore/UI投影；Map delta：none；Why：共同叶模块，不新增持久owner或第二套审批路由。

Fallback扫描触发阈值的原因含标准/legacy字段、可选能力及错误分类。工具raw标准字段优先、name null、空值替换均有逐字段合同；模型/必需指令/MCP未采用直接拒绝，未继续堆“默认成功”分支。旧resume empty replacement属于W3仍需明示的历史行为，本次只防native负终态错误重发；未借此批准恢复政策。

产品图片 UI 证据独立见[产品链回执](product-image-ui-evidence.md)。#1598 已按维护者意见拆到 [PR #1599](https://github.com/zts212653/clowder-ai/pull/1599)；本次运行只归属 #1596/eab5082c，不能充当 #1599 exact HEAD 的验收，产品错误/取消 UI 也尚未验证。后续W3完整政策/真人交互/静止、W4/W5原生增强、W6真实差分及V24-C、W7回滚/迁移分别审查；G2通过也不能代替G3–G5。
