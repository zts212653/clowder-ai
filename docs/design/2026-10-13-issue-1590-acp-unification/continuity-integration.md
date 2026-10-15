---
feature_ids: [F143, F161]
related_features: [F296]
topics: [acp, continuity, crash, integration-testing]
doc_kind: plan
created: 2026-10-13
---

# V24-C：Continuity Barrier 独立集成验收（R4）

状态：集成测试设计；测试尚未落盘/运行。不是以单元测试代替真实恢复。该单元在 W6 统筹；bridge准备好即执行其所属carrier子集，为W4/W5/G3提供证据；W6再完成跨成员合流与G4产品验收，不造成“必须等W6才证明G3”的循环。

## 真实调用链与不变量

actual native恢复/初始化 → 收集本绑定buffered authoritative compactions → `settle({ evidence, compactions })`恰一次 → 既有epoch owner/context prompt factory/presentation mapper/ledger reservation → 返回最终prompt → 第一个ACP session/prompt。

原生 evidence 不能由配置预测；settle前不能构建/发最终prompt；不能在settle外另更新epoch。每次新invocation自己的settle至多一次；crash未完成的旧invocation应由原owner中断/对账，不能重新消费旧settle导致双写。

源码基线：`services/types.ts` 的 ProviderContinuityPreflight；`agents/invocation/invoke-single-cat.ts` 的 settle closure及 applyProviderCompactions/buildFinalGeneration；原context epoch/presentation/ledger owner。新增集成测试调用实际owner，不另建test-only“正确状态机”代替产品链。

## 环境与取证

fixture层使用可控native backend精确排列消息；真实层使用固定bridge/native版本、测试profile/cwd、授权账号、有界工具、专属Redis测试命名空间/隔离实例，API/Web为本worktree端口。复用已有运行链和浏览器壳，禁止生产3003/3004/6399。

同时采集：native初始化/恢复evidence、compaction ID与顺序、settle输入、epoch/ledger/presentation前后readback、实际host→bridge与bridge→native首prompt、invocation终态、持久历史与浏览器重放。使用同一关联ID和进程内monotonic order，跨进程以协议因果相关，不靠墙钟先后推导顺序。

测试拦截位点只用于故障注入/抓取wire，不修改产品决策。真实压缩需获得真实原生observation；注入compaction fixture只能计L1。无法获得真实压缩时记unknown并阻断所需Gate，不用summary文本/猜epoch补证。

## 集成场景

| 子例 | 流程/故障注入 | 必须证明 |
|---|---|---|
| I01正常恢复 | 新进程恢复已有native session，恢复时buffer压缩更新 | native continuity、压缩被收集并由settle内owner消费；首prompt在返回最终bytes后 |
| I02压缩交错 | 两个真实compaction ID、重复update、foreign binding更新；边界后新增压缩 | 当前barrier仅消费截止点的本绑定observation；重复不双增epoch；后到压缩进入既有后续处理而非漏/抢写 |
| I03恢复前bridge crash | native尚未给verdict时断开，重启桥与host恢复 | 旧invocation无prompt/settle副作用、真实中断可见；新invocation重新获取evidence |
| I04收集后/settle前host crash | 已收集compaction但尚未settle，结束测试host再起全新进程 | durable原owner对账，无提前prompt；恢复后event去重/epoch一致，无双ledger reservation |
| I05settle后/发送前crash | epoch/prompt准备完成但wire尚未发，结束host | 已有durable admission/ledger处理可核；不盲重发旧invocation、保留中断与对账结果 |
| I06发送后/回执前crash | 真实native已收到prompt，host未收terminal时断连 | outcome_unknown/interrupted不伪成功；无重复工具副作用；查询/重放与新任务显式区分 |
| I07非法顺序 | verdict前尝试send、settle第二次、foreign compaction、恢复失败后伪成功 | 产品调用链拒绝/失败closed并有可读原因；不能靠测试脚本不调用非法路径就算通过 |
| I08历史/UI恢复 | I03–I06后浏览器刷新/重连/历史加载，用户再发新任务 | 历史不删除不重复、当前epoch/身份与新session关系可见，旧任务中断和新任务明确 |

bg chain-key/native UUID轮换、PTY cancel/drain/transcript、capacity window/native-L0声明作为V24原有carrier专项回归继续执行；不拿其他carrier的I01通过冒称它们已通过。

## 自动化入口与分层

建议新文件（**尚不存在，不能列为本轮已跑**）：`packages/api/test/acp/acp-continuity-preflight.integration.test.ts`（L1故障注入+真实owner）；独立L2 runner使用固定bridge/native并输出evidence manifest；L3浏览器旅程沿既有replay壳扩展。新增文件按350行上限拆fixture/runner/helpers。

真实运行需明确opt-in、版本检查、隔离数据路径和清理范围。每个故障由测试只结束本测试创建的host/bridge，不结束生产进程；数据保留以便恢复，不通过删除持久数据“复位”。

L1运行验证精确分支与RED→GREEN，L2验证实际原生压缩/恢复/发送因果，L3验证持久与UI。结果按子例分别保存：`caseId/subcase, binding, versions, rawWireRef, nativeEvidenceRef, compactionRefs, settleInputRef, epochLedgerBeforeAfterRefs, persistedRef, UIRef, verdict/reason`。

## 成功与阻断标准

所有本carrier适用子例具备L1和所需L2；I08与用户可见continuity具备L3。首prompt与settle顺序、单次owner更新、crash后对账、epoch/身份/历史一致都成立且非作者reviewer批准此单元；缺一个证据就不记passed。

任何提前prompt、双settle/双epoch、压缩漏接/串binding、crash后重发可能有副作用的旧任务、假恢复或历史重复均为blocker。停止该binding新ACP admission，按README决策树收敛执行/回滚，修复后重跑受影响子例和原生对照。

G2的基础恢复通过不能批准本barrier；G3仅消费该carrier已经完成的子集回执，G4必须再有跨链L3和合流结果，G5还要独立迁移/回滚审查。
