---
feature_ids: [F143, F161]
topics: [acp, feasibility, review, gates]
doc_kind: report
created: 2026-10-14
tips_exempt: {reason: "隔离原型验证和阶段回执，没有新增产品操作入口"}
---

# W4.P / W5.P 逐条件 Go/No-Go 回执

状态：**W4.P Go、W5.P Go**。非作者 `/root/acp_plan_review` 分别审查 exact HEAD `3d7b89143c22b964ced13b6f249085d4cb681e29`，无未结P0/P1/P2。原型 Gate 只评估固定隔离 binding 的关键技术假设；通过后可以推进 W2/W3 和对应增强实现，G0–G5 及迁移仍分别验收。按 implementation 的依赖顺序，生产 owner、审批 UI、全部控件与完整差分不作为原型的倒置先决条件。

## W4.P：精确原生 Turn

固定 native0.161.0 SHA `a0f89acca07a511734cac7fddee26b2106fab68918717bc90df16104a0760a30`，bridge2.1.1 / `51f78d67`。最终重复与寿命分离均采用 bundle `265a60c7a7f19b3bb2a080198a91b48884846f8c80121598b3d27f46aadc7649`；仅测试禁标题。原生 fence、持久 intent/receipt 没有因标题 guard 改变，可复用未变模块的21项确定性反例与恢复样本；新增真实重复覆盖当前组合。

| 原型通过条件 | 实际证据与样本数 | 独立复核 |
|---|---|---|
| 原生 ID 导出，caller target 原样到 native fence | [初始 fence](evidence/w4-native-fence.json)及[重复](evidence/w4-fence-repeat.json)：A导出→caller→native；当前重复的2次有效原生回执精确匹配 | 满足 |
| A结束、B已启动后 stale A 不改变B | 初始1个已完整 native-correlated A→B；新2个有完整 wire/archive 的A→B，共3个可审样本；stale拒绝3/3，当前B不变，4个新增工具各执行一次 | 满足；不是总体 race 失效率估计 |
| unknown/foreign/idle/cancel target | 初始每类1个真实反例，native nonempty unknown/idle/cancel 拒绝；foreign binding/empty target由桥拒绝 | 满足；取消目标拒绝不证明工具静止 |
| operation重试、丢回执、重连对账 | [恢复](evidence/w4-control-recovery.json)：3个不同operation各native调用1次，冷重连旧operation0重发；21项确定性反例覆盖A/B交错及unknown禁重发；当前重复2次operation replay无native重复 | 满足 |
| caller响应断开时owner中的活动A可控 | [最终 stable-owner-4](evidence/w4-stable-owner.json)：1个审计冻结样本，断开前后exact A接受、工具执行1次、旧op不重发、A完成后target拒绝 | 满足；生产consumer未接线 |
| owner整体退出边界不伪造存活 | [active-drop-1](evidence/w4-active-owner-drop.json)：1个实际退出反例，活动A未存活，历史回执对账不重发，旧target实际native拒绝 | 支持稳定owner路线；没有原服务同条件差分 |

新增重复样本耗时65.003秒：4个ACP prompt、4次native turn/start、0次title、2次有效steer及2次stale拒绝。只读fixture8秒/12次上限、整体180秒；无Codex USD硬限，底层provider轮次与费用unknown。

历史失败与不稳定尝试仍计入调查记录，不能只保留绿样本：最初wire路由未注册为-32601；run2/run3分别因native错误被桥包装成Internal error/Invalid request而不能辨认目标拒绝，补错误message后通过。run4的ACP摘要成功，但没有执行前冻结的同版native/archive索引，因此不加到上述3个可审A→B样本的分母。恢复早期空rollout与二次丢包夹具失败见control-recovery-evidence；stable-owner-1另发title的预算缺陷及后续计数纠正见[codex-budget-audit](evidence/codex-budget-audit.json)。不把这些失败改写成native跨turn误注入，也不隐去。

## W5.P：非打断 Notice

固定bridge v0.70.0 / `d0aafb1c`，SDK0.3.232→0.3.285，native2.1.296→2.1.299。旧next/followup/cancel补丁、真实now/next及pending权限证据可复用未变语义；当前升级使用同一bundle `ce7e4db6de998053497426a658106d9fd14487fe5b83dd63eb8c7b6b9eaf80bf`，native init实报2.1.299及`interrupt_cancel_queued_v1`，未因版本标号推定采用。

| 原型通过条件 | 实际证据与样本数 | 独立复核 |
|---|---|---|
| 主周期不abort、工具完成，Notice在safe boundary执行 | [next-owner-final/now-owner-final](evidence/w5-native-notice.json)：各1个固定真实样本；next工具完成后Notice started；now对照发生后台化，归属修复后正常结清 | 满足；不把now后台化称取消工具 |
| native UUID echo/result、多个Notice/idle，不误结主结果 | [boundaries-5](evidence/w5-boundaries-5.json)、[sdk-upgrade-2](evidence/w5-sdk-upgrade-2.json)、[native-upgrade-2](evidence/w5-native-upgrade.json)：3个定向组合，各2条按序Notice，native result关联两UUID，回答前主prompt未结清 | 满足 |
| pending权限及真实elicitation不抢占/不代答 | 初始权限样本1个及上列3个真实elicitation样本，均由合成host延迟3秒回答；等待时工具/Notice不提前执行 | 满足隔离合同；不是产品真人UI |
| idle/too-late无detached新prompt，queued cancel不再投递 | 初始idle/aftercancel反例；3个最终queued cancel样本，native lifecycle cancelled，新原生prompt后旧Notice仍不started | 满足；raw继续只为检验队列，生产client保持quarantine |
| 未确认SDK-ingress取消 | [ingress-1](evidence/w5-ingress-1.json)：1个真实输入泵故障样本；旧Query退役，native PID约7.054秒后退出，退出后8.5秒Notice未启动、工具未completed | 满足退役路线；不是即时静止或5秒SLO |
| seam的固定版本兼容性 | SDK升级1种，native升级1种；native2.1.299真实复跑28.102秒，不增bridge兼容补丁；升级副本129项受影响反例及9项helper通过 | 满足本次两种定向升级；全矩阵/维护预算留G3 |

普通`interrupt()`撤不掉queued Notice的真实[boundaries-2](evidence/w5-boundaries-2.json) No-Go、now悬挂及第一版owner污染反例均保留，分别以native cancel_queued与精确UUID归属修复。native升级的第一次运行器ESM链接失败发生在认证/模型访问前，修正后再用新样本目录运行；日志/SHA写入新manifest，不覆盖失败记录。

SDK/native升级各为一次定向演练；native新样本实际SDK结果cost字段只覆盖对应result，不外推总账单。SDK升级出现过类型/peer失败，native升级无需新的bridge补丁。运行时/回归耗时有记录，工程工时未预先测量，保留unknown；两次样本不证明月维护成本、长期人员容量或发布支持承诺。

## 独立判定与失效条件

`/root/acp_plan_review` 在上述exact提交分别判定W4.P Go、W5.P Go，blockers=[]；原型的逐条件证据、版本复用、统计分母与保留失败均已核对。同行为非作者独立个体、同家族；没有继承W1/W2.S，也没有用一个原型批准另一个。此前“完整原型held”反映当时的缺证状态；本回执替代该阶段判断，旧样本与当时的限制原样保留。

Go仅适用于这里的固定binary/bridge/SDK/schema、限定认证/只读工具与native能力条件。binary、schema、内部seam、fence/owner/结果归属、权限政策或执行源变更后重审受影响条件；缺cap/seam/合法receipt仍fail closed。未知结果禁盲重发，生产迁移保持关闭。

## 后续阶段仍需完成

- W0/G0：逐成员B/R/E、binding/profile及性能/维护预算的完整冻结。
- W2/W3/G2：生产公共client/能力协商、factory principal/policy/revision、审批/elicitation UI/审计、lease/quarantine和恢复provenance。
- W4/W5/G3：同一稳定owner接现有typed control/freshness，离线事件和最终回执持久；hooks、required controls、continuity、发行/许可/回滚及维护合同。
- W6/G4：原服务同条件差分、真实平台历史/UI、V24-C真实crash/压缩/恢复以及全部required矩阵/性能。
- W7/G5：显式逐binding切换、旧session兼容、回滚演练与迁移决定；当前原服务继续运行。
