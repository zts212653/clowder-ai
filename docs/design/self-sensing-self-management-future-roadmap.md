---
related_features: [F153, F220, F223, F233, F283, F293, F296, F298, F299, F300]
topics: [self-sensing, self-management, capability, availability, user-friction, interaction-adaptation, plugin-management, feedback-loop]
doc_kind: discussion
created: 2026-08-25
description: "Future Self-Sensing / Self-Management product roadmap: grounded capability awareness, user-friction sensing, authority-bounded capability construction, interaction adaptation, and feedback"
description_source: human
description_author: lang
description_updated_at: 2026-08-25T03:07:00Z
---

# Self-Sensing / Self-Management — Future Product Roadmap

> **Status**: discussion / future feature identity pending CVO signoff
>
> **No implementation authority**: 本文保存完整产品愿景、边界和候选阶段，不注册新 Feature，不改变现有 owner，也不授权 runtime 实现。

## Numbering and authority decision

F300 保持已经审核通过的 **Home-State Awareness** 合同：它只负责把 custody、route、quota、plugin/limb readiness 等 canonical 家况送到猫的判断点，以 M1 authoritative preflight、M2 relevant delta 和 M3 typed snapshot 验证“不是黑盒”。

完整 Self-Sensing / Self-Management journey 不再覆盖 F300。它需要一个独立的 future feature identity；编号、owner 与 implementation phase 均等待 CVO signoff。该边界由 [PR #1391 maintainer decision](https://github.com/zts212653/clowder-ai/pull/1391#issuecomment-5404535324) 冻结。

因此本文与相邻工作的关系是：

- **F300** 是第一条 sensing substrate 纵切，不是总体 feature，也不拥有完整 Interaction Episode。
- **F293** 提供带 freshness 的 route/preflight truth，是 Self-Availability 的一个判断点来源，不承担 capability management 或 friction-to-proposal policy。
- 未来总体 feature 可以消费 F300/F293 等 owner 的 facts 与 receipts，但不能把这些 feature 合并或重写成一个中心状态机。

## 一句话愿景

**Self-Sensing** 是 Agent 对“我能做什么、此刻是否真的能做、当前协作哪里产生了摩擦”的有依据认知；**Self-Management** 是把这份认知转化为可解释提案、用户决定、受权执行、交互适配与结果反馈的治理闭环。

它不是人格化的自我意识，不是 Agent 自己给自己扩权，也不是一个更大的 Plugin Manager。

## Why：能力增长正在超过用户的认知带宽

Agent 产品可以持续增加插件、工具、连接器和运行节点，但用户对能力的发现、理解、启用和掌控不会自动增长。当前事实又分散在多个层面：

- capability registry 知道入口与验证面；
- plugin/runtime 知道安装、配置、授权和健康；
- route/custody/execution 知道谁能接、什么仍在执行、什么已经取消；
- interaction evidence 记录失败、重试、取消和显式反馈；
- surface 只显示它被要求显示的局部投影。

如果 Agent 只能在动作失败以后拼凑这些线索，它最多是“拥有很多工具”，还不是能管理自身能力的产品。完整愿景要解决的是：

> Agent 如何在恰当判断点获得可信、足够新鲜的自我与环境事实，识别真实协作摩擦，在不越过用户权限的前提下构建能力、适配交互，并从实际使用结果继续校准？

## 1. Self-Sensing：三类感知

| 感知维度 | 回答的问题 | 典型事实来源 | 不能充当证据的替代物 |
|----------|------------|--------------|----------------------|
| **Self-Capability Management** | 我具备哪些能力？边界、输入输出、风险、provider 是什么？ | capability contract、F223 surface registry、builtin/plugin/tool provider manifest | “界面上有按钮”“工具名存在” |
| **Self-Availability Management** | 这项能力此刻是否已安装、配置、授权、可达、健康？ | plugin lifecycle/runtime、Host Broker、limb readiness、F293 route/quota、F153 health | 安装成功、manifest 声明或旧缓存单独充当 ready |
| **User-Friction Sense** | 用户此刻在哪个任务、动作或交互上遇到了可观察阻力？ | 当前对话、失败/重试/取消、显式反馈、范围受控的 interaction evidence | 持续监视、人格画像、跨场景臆测意图 |

三类感知都必须携带 canonical source、观察时间、新鲜度、scope 与不确定性。`unknown`、`stale`、`conflicted` 是一等状态；系统不能为了显得聪明，把缺失事实补成确定结论。

Self-Sensing 也不等于把全家的全部状态广播给每只猫。只在当前 obligation、下一次副作用或用户明确查看时，投影与该判断相关的最小事实。

## 2. Self-Management：两个结果，一条受权闭环

Self-Management 同时产生两个彼此耦合的结果：

- **能力构建与管理**：发现、匹配、组合、安装或启用、配置、授权、验证、停用与恢复能力。
- **交互适配**：决定怎样解释、呈现、调用和管理这项能力；必要时改变 Dynamic UI、CLI、语音或其他 surface。

候选闭环为：

```text
FRICTION
  → SENSE
  → MATCH
  → PROPOSE
  → USER DECISION
  → ACTIVATE / CONFIGURE
  → INTERACTION ADAPTATION
  → IMMEDIATE USE
  → FEEDBACK
  → RETAIN / EDIT / DISMISS / REVERT
```

闭环的硬边界：

1. Agent 可以感知、匹配、解释和提出建议，但不能把推断当成用户授权。
2. 安装、授权、外部副作用及高风险配置仍由各 authority owner 执行，并返回可验证 receipt。
3. “能力可用了”不是终点；第一次真实动作成功且后续摩擦确实降低，才是保留变化的证据。
4. 用户始终拥有拒绝、编辑、撤回授权和恢复原状的权利。

## 3. Interaction Episode：未来最小可追责单元

未来总体 feature 若获准，不应以“发出一条建议”作为成功。一个 episode 至少包含：

```text
friction-evidence
  → hypothesis
  → capability-match
  → proposal
  → user-decision
  → capability-and-interaction-ready
  → first-successful-action
  → friction-feedback
  → retained | edited | dismissed | reverted
```

每个阶段都必须指回 evidence、authority decision 或 execution receipt。没有用户决定，不得越过 `proposal`；没有成功动作，不能把 `activated` 或 `rendered` 记成效果成立。

`Interaction Episode` 目前只是 discussion-level semantic candidate。它还没有 feature owner、architecture cell、schema、store 或 runtime controller。

## 4. Capability state 不能压成 `enabled`

| 维度 | 示例问题 |
|------|----------|
| Identity | 这是哪一种稳定能力？provider 从 builtin 迁到 plugin 后是否仍是同一用户能力？ |
| Provider | 当前由 builtin、plugin、generated、local limb、remote connector 还是组合提供？ |
| Provisioning | provider 是否存在、已安装或可取得？ |
| Configuration | 必填配置是否完整、版本是否兼容？ |
| Authority | 用户是否授权当前 scope、数据与副作用？授权是否仍有效？ |
| Runtime readiness | 依赖是否可达、健康、未熔断且满足资源/额度约束？ |
| Context applicability | 这项能力是否适用于当前任务、主体和时刻？ |
| Effectiveness | 是否发生过成功动作？真实使用后摩擦降低了吗？ |

所以 `installed ≠ configured ≠ authorized ≠ ready ≠ applicable ≠ effective`。Dynamic UI 可见、plugin manifest 声明、tool 被注册，也都不能单独证明能力此刻可用。

## 5. Ownership boundaries

本文不建立新的 canonical owner；它只记录未来 feature 立项时必须保持的边界。

| 层 | 已有/候选职责 | 当前 owner | Future feature 只能怎样使用 |
|----|---------------|------------|------------------------------|
| 能力与运行事实 | plugin/package discovery、install、config、grants、Host Broker/runtime；capability surface contract | `plugin` cell、F223、limb/runtime owners | 查询 canonical fact/command/receipt，不复制 inventory、权限或运行账本 |
| 家况与判断点 | custody/execution/route/health/readiness 的 relevant preflight、delta、snapshot | F300、F293、F233、F220、F153 | 消费带 source/freshness 的投影，不吸收源状态机 |
| 上下文送达 | context epoch、presentation、dedupe、provider-minted receipt | F296 | 使用统一 delivery，不建立第二 channel，不把 persist 当成 model-visible |
| 轨迹与诊断 | provider-bound request evidence、invocation trajectory、下钻 | F299 | 引用 evidence，不建立第二 transcript |
| 未来 episode coordination | match、proposal、decision、owner command/receipt、first use、feedback | **未立项；owner pending CVO signoff** | 只有立项后才能决定 architecture cell 与 persistence contract |
| 交互投影 | Hub action surfaces；F283 的 object-driven experience hypothesis | F223 / `hub-action-surface`；F283 frozen | 投影同一 truth；surface 不拥有 capability、authority 或 outcome |

### 与 Plugin Manager 的重合边界

Plugin Manager 是 Self-Management 的重要执行域，但两者不等价：

| 问题 | Plugin Manager / plugin cell | Future Self-Management feature |
|------|------------------------------|--------------------------------|
| 哪些插件可发现、已安装、启用、需升级？ | 拥有 canonical lifecycle truth | 只读取与当前 episode 有关的事实 |
| 配置、权限、Host Broker、runtime 是否健康？ | 拥有状态、命令、审计与 receipt | 动作前校验；`unknown/stale` 不冒充 ready |
| 什么时候值得建议新增或调整能力？ | 提供候选与约束，不决定用户需要 | 基于 friction + capability match 形成 proposal |
| 谁能安装、启用、授权或回滚插件？ | 在用户授权和系统策略内执行 | 只能提交带 authority envelope 的 intent |
| 安装后怎样进入交互？ | 提供 UI contribution/contract 候选 | 结合任务选择对话、UI、CLI 或 voice 投影 |
| 实际效果是否值得保留？ | 提供运行与审计证据 | 关联 first successful action 与 friction feedback |

硬边界：不建第二个 plugin catalog、installer、grant store 或 runtime supervisor；Plugin Manager 也不因 catalog 中存在某插件就推断用户需求或自行定义完整 episode。

### Dynamic UI 的位置

Dynamic UI 是 interaction adaptation 的一种视觉实现，不是 Self-Sensing 的同义词，也不是未来 feature 的先决条件。

- 没有 Dynamic UI，episode 仍可以通过对话、CLI 或语音完成。
- 有 Dynamic UI，也不能仅凭组件出现就宣称 capability ready 或 authorized。
- UI 只能投影相同的 capability、authority、receipt 与 episode refs，不能建立 surface-local 平行状态机。
- F283 仍保持 frozen / research hypothesis；本文不解冻其生产 Experience Design Gate。

## 6. Latest-main baseline（`origin/main@dd86a802`）

| 能力块 | 当前真实状态 | 对未来愿景意味着什么 |
|--------|--------------|----------------------|
| F298 promise durability | 已有基础 | 能让 principal/admission/result/wake 承诺活着，但不会自动产生 sensing policy |
| F296 context delivery | 部分落地 | 可承载未来 relevant fact；producer/relevance 与完整 delivery 仍有未完成 AC |
| F299 trajectory/evidence | A–D 已有明确交付，Phase E 仍开放 | 能解释 provider 看见什么，不是 capability/episode controller |
| Plugin management runtime | 已有实质基础并持续演进 | 提供 lifecycle/runtime truth；尚无跨 provider capability-state graph |
| F223 capability surface registry | registry 基础已完成 | 描述入口与验证面，不等于 readiness/effectiveness ontology |
| F293/F233/F220/F153 facts | 分散存在且各有 owner | 是 F300 与未来 sensing 的输入，不应被复制到中心账本 |
| F300 Home-State Awareness | spec，尚未实现 | 第一条候选 sensing substrate；不证明总体愿景已经开始实现 |
| Full Self-Management episode | 未立项、未实现 | 无 feature ID、owner、architecture cell、schema、store 或 controller |

结论：现有代码已有必要底座，但距离完整 Self-Sensing / Self-Management 仍很远。当前准确表述不是“已经具备，只差 UI”，而是“多个 canonical source 和 delivery substrate 正在形成，总体协调 policy 尚未立项”。

## 7. Candidate phased roadmap（不构成排期）

### Foundation — 先完成 F300 Home-State Awareness

- 用取消例验证 relevant delta 与 authoritative preflight 的互补关系。
- 扩展到 quota topology 与 plugin/limb readiness，证明“调用前可知”。
- 保持 source refs、freshness、typed `unknown` 和 provider receipt。

### Candidate Phase A — Capability Graph

- 以稳定 capability identity 关联 builtin、plugin、generated、local/remote provider。
- 把 provisioning、configuration、authority、readiness、applicability、effectiveness 分轴建模。
- 冻结每个字段的 canonical owner，禁止 shadow state。
- 先完成 owner/consumer census 与 claim guard，再讨论 store 或 service。

### Candidate Phase B — Grounded Proposal

- 只从有 provenance 的 interaction evidence 形成 friction hypothesis。
- 显示“为什么现在建议、需要什么权限、会改变什么、如何撤回”。
- 支持 accept / edit / dismiss；沉默、打开卡片和重复使用都不是授权。
- 对误报、噪音和错误归因建立 episode-level evaluation contract。

### Candidate Phase C — Capability Activation + Interaction Adaptation

- 把 approved intent 交给 Plugin Manager、Host Broker 或对应 authority owner。
- 以 canonical receipt 推进 installed/configured/authorized/ready；失败可解释、可恢复。
- 在同一 episode 中选择合适的对话、Dynamic UI、CLI 或 voice surface，并尝试第一个真实动作。
- surface 只投影 owner truth；安装完成、组件渲染和工具注册不等于 first successful action。

### Candidate Phase D — Feedback-Governed Self-Management

- 关联真实动作结果与后续 friction evidence，决定 retained / edited / dismissed / reverted。
- 保存用户可见、可追责、可恢复的 episode 历史，不保存无界用户画像。
- 支持权限撤回、provider 迁移、能力降级和交互恢复。
- 评价任务成功、摩擦变化、误报与可恢复性，不优化 proposal、install 或 UI 生成数量。

## 8. Admission gates for a future feature

只有 CVO 明确签署新的 feature identity 后，后续 owner 才能：

1. 在 ROADMAP 注册编号、owner、status 与与 F293/F300 的关系。
2. 依据 F191/F303 完成 architecture owner/consumer census，决定是新 cell 还是更新已有 cell。
3. 给每个新增 claim 写 Canonical source、Consumer evidence 与 Claim guard。
4. 选择一条端到端 Aha journey，而不是一次建设 capability ontology、proposal engine、Dynamic UI runtime 和 feedback platform。
5. 把实现 AC 与本文 discussion 假设分离；未过 gate 的候选 phase 不得被勾成 committed scope。

## 9. Non-goals and safety rails

- 不让 Agent 静默安装、启用、授权、扩大 scope 或产生外部副作用。
- 不做无界后台扫描、持续用户监控、人格画像或跨场景隐式意图推断。
- 不以 Dynamic UI、插件安装、tool registration、点击或 dwell time 代理 readiness/effectiveness。
- 不新建第二个 capability registry、Plugin Manager、permission store、delivery channel、transcript 或 telemetry platform。
- 不把 F300、F293、F296、F299 或 F283 改名成总体 feature 的子模块；它们保持独立 owner 与既有验收。
- 不在 future feature ID/owner 未签署前创建 runtime code、schema、store 或 architecture cell。

## 10. Provenance

- Product direction: operator 2026-08-25 要求完整描述 Self-Sensing / Self-Management、允许分阶段实现，并澄清与 Plugin Manager 的重合。
- Numbering/ownership decision: [PR #1391 maintainer decision](https://github.com/zts212653/clowder-ai/pull/1391#issuecomment-5404535324) 要求 F300 保留 Home-State contract，总体 journey 独立编号且等待 CVO signoff。
- Publishing lineage（非规范源）: external archive `longform-008-self-sensing-agent-interaction-v3.md` + `assets/dynamic-ui/agent-proposal-loop.svg` at content commit `ffc81c4b8b10abb6059eb3572d7ffb3f99f46c17`。该 archive 无 remote URL；本文是仓内可访问的 discussion source，不把本机路径当成链接。
- Current F300 truth: [`F300-self-sensing-home-state-awareness.md`](../features/F300-self-sensing-home-state-awareness.md)。
