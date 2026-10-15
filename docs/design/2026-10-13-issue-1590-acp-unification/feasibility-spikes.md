---
feature_ids: [F143, F161]
topics: [acp, feasibility, steering, bridge-maintenance]
doc_kind: plan
created: 2026-10-13
---

# 两条 P0 原型与桥维护决策

状态：固定隔离binding的W4.P/W5.P已分别独立Go，逐条件证据、版本与失效条件见[原型门禁回执](prototype-gates.md)。通过原型只允许推进后续实现，不等于G0–G5或迁移通过。

2026-10-14 追加：[Codex 丢回执/冷恢复](control-recovery-evidence.md)与[Claude elicitation/多 Notice/queued 取消/SDK 升级](notice-boundary-evidence.md)已有实际回执。普通 interrupt 不能撤销 queued Notice 的真实 No-Go 已通过本地私有 seam 补丁修复；社区接受与生产维护合同仍未知，不因本地通过改写上游状态。

## W4.P：Codex native fence 能否经 ACP 完整承接（R1）

问题分成两个可证伪步骤，不能先假定 ID 可获得：

1. 固定 Codex bridge 的 native notification/turn-start result 中能否得到真实 `nativeSessionId/nativeTurnId`，并在 ACP 事件/协商扩展中有序导出给 caller？
2. caller 经 ACP 提交 expectedTurnId 后，bridge 是否将**caller 原值**送进同一个 native binding 的 turn/steer，而非换成“当前 turn”或仅本地比较？

源码基础：固定 `CodexAcpClient.steerTurn` 已调用 native `expectedTurnId`；public steering 无 caller target。原型改动限于 native ID export、显式目标扩展与回执，不先搬全部 goal/review/fork。

### 原型步骤与观测

- 锁 native binary、bridge upstream/patch SHA、schema、模型/账号/profile/cwd；起带显式权限政策的最小 ACP host，保持同一原生连接/绑定。
- 先用可控 fake native backend 调度 A→B 的竞态，记录 caller/ACP/native 三层请求和回执；反例中故意延迟 ACP 消息、结束 A、启动 B。
- 再用真实固定 native runtime/bridge 的 read-only任务建立 A，导出 A 的真实 ID；发送有效 target 并确认原生采用，随后向已结束 A 发送 stale target，检查 B/后续任务未被改变。
- fake backend 精确控制 race；真实 runtime 用事件驱动的边界重复场景，记录不稳定样本与统计。不能以“没复现”单独证明无 race。
- 取消、turn-ID未知、foreign session、断线/重连丢回执、operation重复均纳入；未知结果对账，不盲目 resend。

| 条件 | Go | No-Go / unknown |
|---|---|---|
| ID export | native response/notification、ACP导出、caller读到的真实 ID 一致 | 只能生成host ID、猜current turn、无原生来源 |
| fence | wire证实caller target原样到native expectedTurnId；原生有效/过期回执相关 | host-only比较、桥替换target、退成startedNewTurn |
| race反例 | 可控A/B交错全部无越界/重复副作用；真实回执与因果一致 | stale A影响B，或只看模型文本/客户端拒绝 |
| 接受依据 | L1反例 + L2真实bridge/native证据 + 非作者定向审查 | 仅源码可表达/仅mock/缺版本或scope证据 |

**通过标准**：上表全部 Go，且没有未结 P0/P1，记录 raw wireRef/nativeReceiptRef、ID mapping、反例结果与固定版本。否则暂停 Codex 全面增强和整体统一迁移，形成可复现失败包，重新评估 bridge 的可扩展性；保留 exact_active_turn 原服务。

## W5.P：Claude 非打断输入的具体路线（R2）

2026-10-13 只读核实：上游 [#1175](https://github.com/agentclientprotocol/claude-agent-acp/pull/1175) HEAD `bcddee2eda74cf64c8f714813a6693cb45d6d22f` 为 OPEN、未合入、读取的 reviews=[]；候选在 `_session/steering` 增加 `_meta.steering.delivery:"next"`，将 SDK priority 设置为 next。相关 [#871](https://github.com/agentclientprotocol/claude-agent-acp/issues/871) 仍 OPEN。前者只有候选代码和mock测试证据，不证明上游承诺或真实 notice 语义。

先评估候选最小 patch 与固定 v0.70.0/所选 SDK 的兼容性，再决定复用/贡献/自维护，不从零另造无关输入队列。priority="next" 只是实现入口；它是否保留 F254/F318 的安全边界、UUID/结果消费与主周期，需要本原型证明。

### 原型步骤与观测

- 锁 upstream/patch/SDK/CLI 版本；协商显式 next delivery，旧桥未声明时返回 unsupported，禁止退成now/preempt。
- fake SDK 生成 primary/notice echo、多个 result与idle、tool等待和pending权限/elicitation，检查UUID与主turn关联。
- #1175候选diff中delivery="next"分支先于pendingUserInputCount保护选择，必须实测pending真人交互是否仍安全；不能仅保留原later分支存在就宣称其行为未变。
- pending 时入队不等于提前执行。旧合成 `pendingUserInputCount=1 → 禁止入队` 判据过强，已按独立审查改为不抢占、不代答、回答前不执行、回答后正确结清；原 RED 留档，不把修正测量判据说成修好原生审批 bug。
- 真正起固定 bridge/native SDK，以有界只读工具/测试工具制造当前周期；在边界前送 notice，核native cycle/abort/tool completion、输入UUID、notice消费和主invocation最终结果。
- active/idle/too-late 明确：idle 返回 host-owned promptRequired/too_late，不自行新建 detached turn；取消不再投递pending notice；并发多个notice有序可核。
- 普通preempt mode作为对照，证明两种模式的原生执行差异，不能只看最后答案都出现notice文本。

**通过标准**：L1上述反例全部通过；L2记录当前周期未abort、工具未中断、notice确在原生安全边界进入、UUID echo/结果有唯一正确关联、主结果不提前结清；pending人类交互未被取消/代答；idle/取消无隐式新turn；非作者审查确认没有仅靠priority赋值证明语义。

**No-Go**：任何非打断请求实际preempt、SDK result错结主任务、pending权限丢失、没有真实关联回执，或仅有mock/源码证据。暂停Claude增强和整体迁移，保持原SDK/freshness路线并重评桥补丁；不能用queue-after或取消重启降级通过。

## 长期补丁成本与路线选择

| 路线 | 现有依据 | 长期成本与选择 |
|---|---|---|
| 复用/贡献 #1175 | 候选改2个文件，已有 next delivery mock | 最先验证；仍需补业务回执/结果边界和真实验收。少量diff不证明维护廉价，合入前由本实现线承担补丁兼容 |
| 自维护 narrow patch | 尚无本项目发行物 | 控制面/turn owner/SDK优先级变化会增加rebase与回归；仅保留必要delta、固定发行物，禁止长期复制整桥实现 |
| 保持原服务、暂缓迁移 | 当前原生能力可作为对照 | 无新增桥补丁支持承诺，但统一仍未完成；P0原型失败/成本不可持续时采用 |

成本量尺在 W0 冻结，W5.P/W5 填真实测量：patch触及模块/上游内部API、SDK依赖范围、测试覆盖、每次升级rebase/修复工时、全矩阵CI/真实运行工时、发布/平台签名工作、事故恢复时间、上游响应/合入证据与人员维护容量。

月维护估算公式：`H = N_bridge × H_rebase + N_sdk/native × H_compat + H_regression + H_release + H_incident`。当前各输入未知，不宣称成本更低。按实际升级频率和至少两次升级演练测量后给区间及样本限制，成本属于工程预测而非运行证据。

G3放行还须：明确维护归属（沿现有实现责任，不替社区分配owner）、发行物/许可/回滚记录、预算和响应窗口已冻结、升级演练满足预算且运行回归通过。维护人/预算缺失、无法小范围重放补丁或持续超预算 → No-Go并重新决策，不以“已能运行”跳过可持续性。

上游接受的充分记录是对应公开PR/commit/发布物及语义回执；本地测试通过不等于社区接受。当前仅做只读核实，未联系社区、未提交外部消息；可在需要公开推进时准备审查材料后沿获授权渠道提交。

## 原型共同回执与全局决定

每个原型独立记录：目标假设、fixed versions/patch SHA、caller→ACP→native证据、反例、有效/失效条件、独立reviewer与verdict。一个通过不能代替另一个，也不能抵消安全或continuity失败。

两条均Go才继续全面统一实现；任一No-Go/unknown暂停整体迁移，原型可定向补证后重审。复核若失败的是补丁语义或版本兼容，要区分 bridge 问题与 ACP wire 表达能力，不笼统宣布协议不可行。
