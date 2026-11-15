---
feature_ids: [F337]
related_features: [F048, F293, F300, F317, F334]
topics: [stop-reason, host-sleep, restart-recovery, routing-context, cancellation, self-sensing]
doc_kind: spec
created: 2026-11-13
tips_exempt: "Automatic stop-reason evidence and bounded host-sleep recovery add no separate user command or setting. F337 remains in-progress and real full-wake acceptance is pending; this implementation record must not advertise rollout completion or weaken the manual-cancellation boundary."
description: "猫知道队友是怎么停的：合盖睡眠打断能被认出并在开盖后接着干，派活前看得见对方最近怎么停的，不再把已经停了的猫喊醒。"
description_source: model
description_author: opus55
description_updated_at: 2026-11-13T14:30:00Z
---

# F337: 停止原因感知 — 合盖接续、派活前看见怎么停的

> **Status**: in-progress | **Owner**: Ragdoll (@opus55) | **Priority**: P1
>
> **现状（2026-11-13 13:26 PST）**：Phase A（#7038，`05458c6b51`）已随 boot 88 加载：启动日志 `[F337] sleep continuations recovered at startup` owed=0，`turnexec:member-started:*` 已有写入。等一次「有猫在跑时合盖再开盖」的真实样本验收 AC-A2/AC-A5。

## Why

You 2026-11-13 在 `[thread-id]` 消息 `private-source-id`：

> 我感觉我们对于给你们猫猫的状态感知是不是应该感知更多东西？比如说我的电脑是不是合盖了才导致了这个的打断？……很多时候我已经先点了墨墨的取消，但是其实你是没有感知到我手动点了它的取消，反而又去把它给喊起来了。我在想我们自己的感知是不是还能再优化增强？

猫现在只知道队友「停了」，不知道「怎么停的」。结果是三种浪费 You 注意力的事：合盖上个厕所回来，猫的活断了也没人接；猫看见队友没回话就换人或重试，不知道其实是电脑睡了；You 已经手动取消了一只猫，另一只猫为了「告诉它别做了」又 @ 它，反而把它叫醒。

要的结果：You 合盖、取消、重启之后不用再替猫们记账和收拾；猫在决定喊谁、要不要叫停谁之前，看得见对方是怎么停的。

## Current State / 现状基线

- **合盖打断没人认出来**（2026-11-13 实例）：墨墨（kimi31-pro）的一轮 04:40:06 PST 开始，6 秒后 `pmset` 记下 `Entering Sleep state due to 'Clamshell Sleep'`（04:40:12）；04:55:13 暗唤醒 90 秒期间，他的 ACP 流以 `empty_response` 结束；05:10:41 开盖。系统把这一轮记成 `failed / provider_execution_failed`，派活的猫只收到「上游未提供失败原因」，于是我（opus55）换了Siamese。`turnexec` 记录里没有任何睡眠信息。
- **哪只猫跨睡眠会断**（2026-11-13 用 `pmset -g log` 与 `cat-cafe:turnexec` 结束记录对照；电源日志只留到 11-06，共 103 段超过 1 分钟的睡眠，其中 10 段是合盖）：睡着那一刻正在跑的轮，大约 95 轮里 8 轮断了，各家都有，不只是墨墨。按猫计：小星星 24 成 / 2 断，小太阳 6.1 35 成 / 2 断，小太阳 5.6 3 成 / 1 断，小团团 0 成 / 1 断，墨墨 6 成 / 1 断（就是 11-13 这次），Carbon 2 成 / 1 断，Siamese 5 成 / 0 断，Ragdoll 7 成 / 0 断，Sonnet 2 成 / 0 断（另有 4 轮在睡眠前后被 You 手动取消）。断掉的都被记成 `provider_execution_failed` 或 `execution_owner_lost`，没有一条写明是睡眠。这是重叠统计，不等于每次失败都由睡眠造成。
- **睡眠打断是反复发生的**：F317 记录过插件租约在 950 秒合盖睡眠、6754 秒低电量睡眠后失效（`docs/features/F317-coactive-companion.md` 第 74、78 行）。
- **现成零件**：`runtime/process-observation/mac-power-evidence.mjs` 的 `readMacSleepEvidence` 已能读出确认的睡眠区间和醒来方式（`dark` / `full`），当前只被 durable managed gate 用（`packages/api/src/domains/ball-custody/durable-managed-gate-power-evidence.ts`）。F048 Phase C 的 `continueRestartInterruptedCats` 已能给被打断的猫在原线程投递续做消息，并带幂等与防循环。
- **停止原因记了一部分，但派活时看不到**：最近 300 轮结束记录里，`terminalReason` 有 `user_cancel`、`process_restart`、`provider_execution_failed` 等，但每轮注入的派活提示（`RoutingContextPromptProjector.ts`）的 `anomalies` 只收「不可用或画像无效」的候选，猫可用时这一栏总是空的。
- **吴浪（@mindfn）A2A 生命周期重构的现行设计**（公共 clowder-ai #1398，2026-10-15 经 #5576 回家；家里与公共 F117 原文一致：「正常 completed／canceled／interrupted 不自动重启 caller。exact A2A failed …唤醒 exact caller 读取原结果」）：
  - 被派活的猫**失败**时，派活的猫会被叫醒（`a2a-failure-callers.ts`）。11-13 墨墨被合盖掐断后我就是这样被叫醒的，所以「看见失败」这条路是通的，只是不知道原因。
  - **取消、中断、完成**不叫醒派活的猫，只在它下一次自然被叫起时附一行 `[Outbound Dispatch Status]`，形如 `→ kimi31-pro: canceled; response=…`（`caller-dispatch-observation-reader.ts`）。这一行不写是谁停的、为什么停；只覆盖自己派出去的活；重启后这份观察清空。
  - 结论：不是被改坏了，是这套设计只管到「状态」，没管到「原因」和「派活之外的队友」。

## What

一个 feature，一个 PR，两块一起交付（KD-1、KD-3）。

### Phase A: 停止原因感知与接续

1. **认出合盖睡眠打断，开盖后接着干。** 一轮执行以 provider 失败结束、且这段时间里有确认的睡眠区间时，把停止原因记成「电脑睡眠」，不再记成笼统的上游失败。等电脑真正醒来（`full` wake，不是暗唤醒）后，复用 F048 Phase C 的续做投递，给它在原线程发一条「刚才电脑睡着了，你上一轮被打断了……」并叫醒它；幂等键、`queued_work` 跳过、连续两次被打断不再叫，沿用 Phase C 的做法。
2. **派活前看见对方最近怎么停的。** 每轮派活提示里，对本线程最近停下的队友给一条短说明：被 You 手动取消、被重启打断、被电脑睡眠打断、上游失败，以及时间。猫可用也照样显示；没有最近停止的不显示。
   派活回执那一行（`[Outbound Dispatch Status]`）和失败叫醒也带上同样的原因：`canceled` 写明是 You 手动取消，失败写明是否被电脑睡眠打断、开盖后会自动接着。

**叫停不新增动作**（KD-3）：要让在跑的猫停下，照常给它发消息；对已经停了的猫，靠第 2 块看得见，不再发消息把它叫醒。

## User Journey

### Primary Journey: 合盖去上个厕所，回来猫自己接着干
- **Scope unit**: thread
- **Actor**: operator
- **Entry**: 有猫正在干活时合上电脑
- **Flow**:
  1. You 合盖离开，猫这一轮被睡眠掐断。
  2. You 开盖回来 → 被打断的猫在原线程收到「刚才电脑睡着了……」，接着干。
  3. 其他猫看那只猫的状态，看到的是「被电脑睡眠打断」，不是「上游失败」，不会换人重做。
- **Success evidence**: 一次真实合盖：pmset 睡眠记录、该轮停止原因为睡眠、开盖后原线程出现接续消息且猫接着干。
- **Non-goals**: 不让电脑不睡；不在睡眠前提醒或保存；不管插件租约（F317）。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread | operator → 猫 | You 点了墨墨的取消 → 跟Ragdoll说「别找墨墨了」→ Ragdoll的派活提示里写着「墨墨 X 分钟前被 You 手动取消」→ Ragdoll不 @ 墨墨，回一句已经停了 | 线程里没有新的发给墨墨的消息，墨墨没有新一轮 |
| S2 | thread | operator → 猫 | You 说「让墨墨停下」，墨墨还在跑 → Ragdoll照常给墨墨发消息让他停 | 墨墨停下；墨墨已停时Ragdoll不发 |
| S3 | thread | 猫 | Ragdoll派给墨墨的活失败了 → 派活提示/回执说明是「电脑睡眠打断」→ Ragdoll等开盖后的自动接续，不换人 | 停止原因与接续消息 |

## Acceptance Criteria

- [x] AC-A1: 合盖睡眠期间被掐断的那一轮，停止原因记为电脑睡眠；用 2026-11-13 04:40–04:55 的真实 pmset 片段做测试数据，结果不再是 `provider_execution_failed`。（#7038：`host_sleep`，读不到电源日志时保持原失败原因；已合入，未加载）
- [ ] AC-A2: 被睡眠打断的猫，在电脑真正醒来后，在原线程收到接续消息并接着干；暗唤醒期间不发；同一只猫连续两次被打断，第二次不再自动叫回。（逻辑与测试已在 #7038：等开盖、欠账持久化与重启找回、更新的一轮优先、读不到不销账；「接着干」待真实样本，随 AC-A5 验）
- [x] AC-A3: 猫准备喊人时，派活提示里能看到本线程每个最近停下的队友是怎么停的、什么时候停的；猫可用时也显示。（#7038：导航「最近停下的成员」，读满一页时写明没核对完；已合入，未加载）
- [x] AC-A4: 派活回执和失败叫醒带上停止原因：`canceled` 标明是 You 手动取消；睡眠打断的失败标明「被电脑睡眠打断，开盖后会自动接着」，派活的猫不再换人重做。（#7038：回执行 `reason=…（说明）`、失败回复正文补说明、睡眠打断不计入派活健康度；已合入，未加载）
- [ ] AC-A5: 真实验收：① 有猫在跑时 You 合盖、过几分钟开盖，那只猫自己接着干；② You 手动取消一只猫后，跟另一只猫说别找它了，后者不再把它喊醒。You 只做合盖和点取消，不需要别的操作。

## Tips Contribution（F244）

计划新增 1 条：「合盖离开不用担心：电脑睡着时被打断的猫，开盖后会自己在原对话接着干。」指向本文 Primary Journey。

## Architecture

```markdown
Architecture cell: dispatch（停止原因与续做投递）, routing-context（派活提示投影）
Map delta: none
Why: 只在已有的执行终态、F048 续做投递和 F293 派活提示上扩展，不新建 Store/Queue/Router。
```

## Non-goals（不做的事，防钛合金内裤）

- 不加审批、确认弹窗或二次确认；不加设置开关或环境变量。
- 不拦消息、不冻结准入、不改重启权限（ADR-039 照旧）、不改 F048 已有行为。
- 不让电脑不睡，不在睡前提醒或抢存；不做 Windows/Linux 的睡眠识别（读不到睡眠就保持原样，不猜）。
- 不接管 F293 的取消后接球（AC-E8 的 disposition 仍归 F293）；本 feature 只让派活的猫看得见。
- 不修插件租约跨睡眠（F317 自己的线）。

## Dependencies

- **Evolved from**: F048（Phase C 重启后自动叫回，本 feature 复用其续做投递）
- **Related**: F293（派活提示投影与取消后接球 AC-E8，边界见 Non-goals）、F300（自我感知 umbrella）、F317（插件跨睡眠可靠性）、F334（合盖机器上的家）

## Risk

| 风险 | 缓解 |
|------|------|
| 睡眠判定误伤：真正的上游失败碰巧和一次睡眠重叠 | 只在睡眠区间与该轮执行时间重叠且失败发生在睡眠中或醒来后时才判；判错的代价是多一次接续，猫看完上下文会说「不用再做了」 |
| 暗唤醒里发出接续又被掐断 | 只在 `full` wake 后投递；连续两次被打断不再叫 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 三块放进一个新 feature、一个 PR 交付 | You：「我其实比较倾向一个new feat 装着三个 避免拆散能一个pr别好几个 好几个pr你们能容易功能改的不完整 以及给我制造钛合金内裤」（`private-source-id`） | 2026-11-13 |
| KD-2 | 不新建状态存储或路由，只扩展执行终态、F048 续做投递、F293 派活提示和 #1398 的派活回执 | 已有零件够用（Current State），也避免和 F293 / F300 出现第二份真相 | 2026-11-13 |
| KD-3 | 不做猫的停止动作；要停在跑的猫就照常发消息，对已停的猫不发 | You：「其实我觉得你们可以停止别的猫，不过如果要你们停止，完全可以直接给人发消息啊，如果他们在running，然后他们会停止的」（`private-source-id`） | 2026-11-13 |

## Review Gate

- Phase A: 方向已由 You 定（KD-1、KD-3）；代码 review 找一只非作者Maine Coon。
