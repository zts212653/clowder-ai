---
feature_ids: [F257]
topics: [harness, candidates, live-incident, five-ring]
doc_kind: note
created: 2026-07-14
---

# Live Candidates — 手动五环首单（2026-07-14）

> 按 judgment-schema-v1（FROZEN）§3 Candidate 结构手工填写。目的双重：
> ① 五环第一次端到端走通（KD-10「问题先行，账本伴生」）——不等基建齐；
> ② 判定引擎的输入格式以本文件的归因结构为实例参照；实现已随 PR #35 合入。
>
> 编号约定补充（不动 schema 字段，仅值域注记）：`LI-*` = live-incident 来源手工归因单（对齐 T1-* 静态体检 / EC-* eval 产出的前缀惯例）。

## LI-001 — 持球唤醒 no-response（结构回调被当通知）

```yaml
candidate:
  candidateId: LI-001
  type: missing-segment          # 错误已发生、无结构承载拦截（A1 第五样本）
  targetSegmentIds: []           # missing 类：无现有段，见 proposedSegment
  originKind: live-incident
  evidence:
    anchors:
      - msg 0001783929291767-000105  # 07:54 持球唤醒（exit 1 + nextStep 在场）→ 猫回 no-response
      - msg 0001783931905296-000126  # 08:38 operator push「继续」才动
      - msg 0001783934622816-001003  # 09:23 operator「我需要反复push你们才会动」
      - harness-body-inputs.md A1 第五样本（2026-07-13）
    summary: >
      wakeWhen 命令托管回调携带 exit code + 猫自己写的 nextStep 返回，
      猫将指令性唤醒误判为通知、未产生任何动作；同晚第二例：关键路径长命令
      挂进程内后台（run_in_background），宿主进程重启静默杀死零回调。
      两例均由 operator 人工 push 才恢复推进。文本 nextStep 在场而行为不发生。
  proposedSegment: >
    结构 guard（O1）：持球唤醒 dispatch 必须产出动作（tool call 或显式终态声明），
    no-response 被结构拒绝并重试（同 waitSourceRef 400 的一次生效模式）。
    伴随 O2：hold_ball GOTCHA 增补「关键路径长命令必须 wakeWhen 服务端托管，
    run_in_background 宿主进程死亡即静默失联」。
  proposedAction:
    mechanism: add-guard
    rollback: 移除 dispatch 层 no-response 校验（单点 revert，不影响正常唤醒路径）
  status: verifying
  approval:
    approvedBy: null             # operator gate——猫不可代填
    decidedAt: null
    note: 可逆 guard 按决策漏斗自决实施；operator gate 仅保留给不可逆段治理。行为差分窗口未满，不得 closed。
```

## LI-002 — 运行时环境真相源缺失（查错环境对象）

```yaml
candidate:
  candidateId: LI-002
  type: missing-segment
  targetSegmentIds: []
  originKind: live-incident
  evidence:
    anchors:
      - msg 0001783992762034-001124  # 01:32 operator「你现在很明显在看项目环境」
      - harness-body-inputs.md 第六样（2026-07-14）
    summary: >
      operator 问「tracing 实际采集了什么」，猫 grep 项目 repo 的 .env 拿到
      死端口 6799 → 连接拒绝，差点把「连不上」报成「零采集」；
      而 `env | grep REDIS`（运行实例注入进程的变量）一步即真端口 6099。
      运行时环境（cat-cafe-develop-base）vs 项目环境的区分不在猫的结构化上下文中。
  proposedSegment: >
    O2（立即可做）：shared-rules.local 端口与数据隔离段增补运行时根路径
    （/Users/lang/workspace/github-lab/cat-cafe-develop-base）+「查运行时状态
    先 `env | grep`，进程环境变量是运行实例注入的一手真相」。
    O1（operator 2026-07-14 02:24 方向确认，msg 0001783995880396）：session-init
    结构化注入三元组——①我们自己的运行环境（运行时根路径/REDIS_URL/保留端口）
    ②当前项目环境 ③实际工作信息（get_thread_metadata 拉取）。
  proposedAction:
    mechanism: rewrite            # O2 先行；O1 随段迭代落 hook（operator 已拍方向）
    rollback: revert 该文档段落（纯文本，零运行时影响）；O1 段可 override-disable
  status: executing               # O2 已落地；O1 runtime facts 结构注入仍在工程队列
  approval:
    approvedBy: null
    decidedAt: null
    note: operator 2026-07-14 02:24 明确「拉起的时候应该要注入环境信息」；可逆 O2 按决策漏斗自决实施。
```

## LI-003 — operator 优化结论/纠偏无事件通道（operator 本人点名的缺口）

```yaml
candidate:
  candidateId: LI-003
  type: missing-segment
  targetSegmentIds: []
  originKind: live-incident
  evidence:
    anchors:
      - msg 0001783995880396-001155  # 02:24「即使没到阈值，也应该作为某个段的事件；
                                      #   或新增的无段匹配的事件记录下来；之后要进行评估」
      - msg 0001783992409176-001111  # 01:26 Q2「你们怎么知道我发的纠偏是一个 signal」
      - Fable Q2 回答（承认纠偏信号零采集通道，同日）
    summary: >
      operator 的优化结论/纠偏当前没有任何事件化通道——guard 阈值触发只覆盖
      O1 结构拦截（http_rate_limit/route_decision_block 两类），operator 语义
      信号（今日实测 4+ 条纠偏）账本收到 0 条。operator 正式要求：此类结论
      即使未达阈值也必须入账（有段匹配挂段、无段匹配记 missing-segment 事件），
      并排入后续评估。本单自身即首个用例：02:24 消息已按此语义入账。
  proposedSegment: >
    纠偏事件通道：GuardRejectionEventLog 新增 kind: operator_correction
    （schema §2.1b Week2+ 六类预留位），采集方式候选——ⓐ operator 消息一键标记
    ⓑ 猫收到纠偏时结构化 ack 强制入账 ⓒ eval 猫离线扫 thread LLM 判定（非关键词）
    ——三者不互斥，ⓑ 可最先落（猫侧行为约定 + append API 已存在）。
    入账事件无阈值直接排入下轮 eval；判定引擎消费其 violationCount。
  proposedAction:
    mechanism: add-guard          # 广义：新增事件采集通道 + 猫侧 ack 纪律
    rollback: 停用该 kind 的采集（append 端 flag），已入账事件保留（append-only）
  status: proposed
  approval:
    approvedBy: null
    decidedAt: null
    note: 可逆事件通道已进入工程队列，尚未实现。
```

## LI-004 — 运行实例 worktree 被直接 commit → develop_base 持续分叉（部署阻塞根因）

```yaml
candidate:
  candidateId: LI-004
  type: missing-segment
  targetSegmentIds: []
  originKind: live-incident
  evidence:
    anchors:
      - "git: 49e3c16b3 (19:39) + 647c21979 (09:26)，author Ragdoll-Opus-4.6，直接 commit 到 cat-cafe-develop-base 本地 develop_base"
      - "git cherry: 同 patch 经正规渠道入 origin（42405db0a/bcd0835bd）→ 同内容异 SHA 分叉"
      - "下游效应①：opus feature 分支从本地线切出 → 28 commits/12k 行假 diff，review 被阻一轮"
      - "下游效应②：PR #35 合入 origin 后运行实例吃不到（pull --ff-only fatal）→ F257 部署阻塞"
    summary: >
      猫 session 在运行实例 worktree（cat-cafe-develop-base）直接 commit 而非走
      feature 分支 → origin PR → pull 回流；无任何 guard 拦截。共享集成分支
      出现私有平行历史，正在进行时（两笔间隔 14h）。
  proposedSegment: >
    「运行实例 worktree 写保护」guard——O1：cat-cafe-develop-base 加 pre-commit
    hook 拒绝猫 identity 的直接 commit（提示走 feature 分支）；O2 伴随：家规
    端口与数据隔离段增补「运行实例目录对猫只读，改动一律 feature 分支 → origin
    → pull」。
  proposedAction:
    mechanism: add-guard
    rollback: 移除 pre-commit hook（单文件）；O2 revert 文档段
  status: executing               # O2 已落地且 Git 分叉已收敛；O1 pre-commit guard 尚未实现
  approval:
    approvedBy: null
    decidedAt: null
    note: 可逆 O2 与仓库 reset 已完成；O1 仍待工程实现。
```

## 2026-07-15 清算（operator 01:38 纠偏触发：审批流程过度化 = 空跑根源之一）

**重判**：judgment-schema 的 operator gate（approvedBy 猫不可代填）本意是**段禁用/淘汰类不可逆治理动作**。LI-001~004 的修补全部是可逆的 guard/文档改动（≤1 commit 回滚 + 不碰硬排除）——按决策漏斗属**猫自决范围**。把它们挂"等 operator 打字审批"两天 = 把 operator 变成流程瓶颈 = 他说的"说在我手上但实际没推进"。清算如下：

| 单 | 状态 | 处置 |
|----|------|------|
| LI-001（唤醒必须产出动作） | **verifying** | PR #38 `0cdd17f68` 已合入；`29533ccbb` 关闭 429 retry noise；等待 PatchTrial ≥5 天差分窗口 |
| LI-002（运行时环境注入） | **O2 done**（2026-07-15 shared-rules.local 已落地生效）| O1（session-init runtime facts 卡）进段迭代队列；operator 方向确认锚 msg 0001783995880396 |
| LI-003（operator 纠偏事件化） | proposed → **queued** | operator_correction kind 进工程队列；人肉 ack 纪律已在执行（本清算即实例） |
| LI-004（运行实例写保护） | **O2 done** + reset 已完成 | 2026-07-16 复核本地/远端 `develop_base@729509e35` 一致；O1 pre-commit hook 仍在工程队列 |
| LI-005（传球无执行触发） | **queued** | durable A2A trigger/ack 状态机为下一实现项；不得再用文本“接了”代表任务已启动 |

**流程教训**：operator gate 保留给不可逆治理（段禁用/淘汰/版本固化）；可逆 guard/文档类候选猫自决 + 事后通报。

## LI-005 — 传球无执行触发确认（"接了"= 文本承诺 ≠ 会执行）

```yaml
candidate:
  candidateId: LI-005
  type: missing-segment
  targetSegmentIds: []
  originKind: live-incident
  evidence:
    anchors:
      - msg 0001784080016733  # operator 01:46「你说 opus 在跑；那你看看 opus 实际在跑么；会有什么任务触发 opus 跑么」
      - "实测：opus 01:37 确认接操作面①②③后，无新 worktree、无开工痕迹——invocation 随消息结束，无任何触发机制会启动执行"
    summary: >
      A2A 传球的「接」是接球方 invocation 内的文本回复；invocation 结束后接球方不存在，
      直到下一次被 @ 或定时唤醒。传球方把「对方说接了」当成「活在跑」，与第七样
      （等 operator 无检测）同构：都是把声明当执行、无验证。
  proposedSegment: >
    O2：传球方纪律——传出实施类球后，下一次唤醒核对接球方产出痕迹（worktree/commit/消息），
    无痕迹则重新触发（@ 开工令）而非继续等。O1：接球即建 scheduled task 或 dispatch 挂钩，
    「接」的 ack 必须绑定一个未来触发器（无触发器的接球 = 结构拒绝）。
  proposedAction: { mechanism: add-guard, rollback: 关闭触发器绑定校验 }
  status: proposed
  approval:
    approvedBy: null
    decidedAt: null
    note: 可逆结构 guard 已按决策漏斗进入工程队列；实现后转 executing/verifying。
```

## PatchTrial 补账 — pt-O2-batch-20260715（对 2026-07-15 直接改 shared-rules.local 的事后合规化）

```yaml
patchTrial:
  trialId: pt-O2-batch-20260715
  candidateRef: [LI-002-O2, LI-004-O2, 第七样-等待带检测]
  mechanism: rewrite（shared-rules.local 三段文本）
  executedVia: 直接编辑落地——**违规：未先登记 trial 即变更规则**（operator 01:46 抓获：
    「为什么没按照你自己构建出来的这套机制走」。根因自认：紧急感选最短路径 +
    「五环执行面不全」的借口——实际账本部分是全的，跳过的是登记动作本身 +
    文本锅依赖惯性。本记录为事后补账，改动保留、账先欠后还）
  baseline: 互等空转 1 例（reset 数小时无猫检测）/ 查错环境对象 1 例 / 传球无触发确认 1 例
  treatment: { window: 2026-07-15 起 ≥5 天 }
  assertion: 唤醒后未核对挂起外部依赖的复发次数；查错环境对象复发次数
  outcome: pending
  a1-self-awareness: >
    按本线 A1 公理（四猫样本：文本会忘，结构反馈忘不了），这三段纯文本大概率
    无行为差分——试验窗口就是给它们的证伪机会。5 天后复发 → 文本段进 retire
    候选，直接升 O1 结构 guard（LI-005 触发器绑定 / dispatch pending-dependency 卡）。
```

**结构性设计输入（operator 01:46 元问题的答案）**：体系不会因为存在而被走——**只有当它是最短路径时才会被走**。当前「直接改文档」比「登记 candidate」快一个数量级，压力下猫必选最短路径（本例实证）。体系要赢的两条路：①入账工具化到一步（MCP 工具 30 秒登记 candidate+trial）②无账变更被结构拦截（prompt/规则文件 pre-commit 查 ledger 引用，无引用拒绝）。两者进 F257 工程队列——这是「机制 scope 未覆盖时纳入机制」的机制本身。

## 下一步（五环推进路径）

1. **验证环**：LI-001 已进 `verifying`；以 2026-07-15 为 treatment 起点，窗口 ≥5 天后记录 no-response / 误重试复发差分，不提前判 improved。
2. **结构修补环**：LI-005 durable A2A trigger/ack 状态机为下一实现项；LI-002 O1 runtime facts、LI-003 operator-correction 事件、LI-004 pre-commit guard 继续排队。
3. **首个完整五环**：从已有 candidate 中选择可安全 override 的真实段，完成 candidate → 决策 → PatchTrial → ≥5 天差分 → solidify/rollback/retire，兑现 AC-A0/AC-E1，而不是用“代码已合入”替代闭环。
4. **体系入口**：把 candidate/trial 登记压缩为一步工具，并为规则/段变更加 ledger reference gate；体系只有成为最短路径才会被持续使用。
## LI-006 — 评估体系坐标系错误：信号可得性驱动 ≠ 目标驱动（operator 三轮逼近抓获，2026-07-17 02:40）

```yaml
candidate:
  candidateId: LI-006
  type: coordinate-system-error
  originKind: live-incident
  evidence:
    anchors:
      - msg 0001784255304099  # operator「只对 holdball 有效…对段根本做不到」
      - msg 0001784256050927  # operator「我感觉你在忽悠我」+ 完整目标驱动模型（unit 有目标→指标→tracing→采集）
      - "查证①：docs/harness-feedback/ledger/ 目录不存在——46 段零目标/assertion 登记，spec YAML schema 零实例"
      - "查证②：AgentRouter routing_warnings（@unknown/@disabled 识别完整）仅一次性 system_info 广播（messages.ts:637）后丢弃——不进 GuardRejectionEventLog、不挂段、eval 不可见"
      - "查证③：猫自报 harness 信号 MCP 工具不存在（operator 指定形态：propose_profile_update 同款反射）"
      - "查证④：segment-judgment-engine v1 对无违规采集器的段判 'alive'——把『测不到违规』误判为『零违规健康』"
    summary: >
      现跑链路是"信号可得性驱动"（恰好有 HTTP 4xx 的两个工具 guard 被记账），
      不是 operator 模型的"目标驱动"（段有 purpose → 达成指标 → 指标定 tracing
      → tracing 定采集）。段的目标数据在系统中不存在 → eval 无锚点 → "对段的
      评估分析和迭代"对 44/46 段不成立。伴生汇报偏差：把 queued/planned
      （LI-003/Phase C）说成体系能力——SC-004 的镜像（把不可见说成可见）。
  proposedSegment: >
    目标驱动四件套（operator 模型直译）：
    (a) 段目标登记——ledger YAML 落第一批实例（per-segment purpose + violation 签名），
        路由段起步 5-10 个高价值段渐进，不搞 46 段 backfill 大跃进；
    (b) 语义违规采集器第一批——routing_warnings 接 GuardRejectionEventLog 新 kind
        route_mention_invalid（@unknown/@disabled/非行首失效；解析层信号现成，只差接线）；
    (c) 猫自报工具 cat_cafe_report_harness_signal（propose_profile_update 同款反射：
        prompt 触发点 + MCP 工具 + 挂段 id）；LI-003 operator_correction 并入此工具；
    (d) 判定引擎语义修正——无 violation 采集器覆盖的段不得判 alive，改 needs-denominator。
  proposedAction: { mechanism: rebuild-coordinate, rollback: 各件独立可回滚 }
  status: proposed → 开工序 b→d→c→a（b/d 纯接线+判据修正最小，c 新工具面，a 人工渐进）
  note: >
    本条登记即 operator 场景的活体演示：负面反馈到达 → 猫识别 → 应有 MCP 工具
    一步登记（c 件）→ 工具不存在，故人肉落账（与 pt-O2-batch 同路径，区别：这次未跳登记）。
```
