---
name: proactive-memory-judgment
tips_exempt: internal cat judgment policy; owner-facing behavior remains the existing F276 approval card
description: "Use when 人物线索需在 F276 即时提案、known-person defer、abstention 间判断。Not for 裸人名、taste、后台扫描或 workspace alias。Output: 可拒绝 proposal、无正文 receipt 或 abstention；永不静默物化。"
triggers:
  - "continuity-valued 人物线索"
  - "proactive-memory-candidate"
  - "人物记忆机会"
  - "主动记忆判断"
  - "person memory opportunity"
not_for:
  - "裸人名"
  - "taste"
  - "后台语料扫描"
  - "重复即重要"
  - "workspace alias 单独登记"
output: "One rejectable F276 proposal, one content-free known-person deferred receipt, or one enum-only abstention"
---

# Proactive Memory Judgment

这是一道语义判断门，不是词频分类器。单次合格线索足以进入判断，**不要求重复**；Phase A
频率 nudge 只说明“跨 thread 出现过”，不证明重要性，也不决定 memory lane。

## 五道门

按顺序判断；任一道不通过，都不要把不确定内容升级成更深的 intervention。

### 1. 甜甜圈资格

主体必须是可命名或可消歧的第三方人物，并且当轮至少出现一种 continuity value：

- 稳定身份或 owner↔person 关系；
- 对既有记忆的纠正；
- 未来对话确实可能用到的事实；
- 值得保留的重要互动或明确 owner assessment。

裸人名 / proper noun alone、taste、背景 corpus 扫描都不是机会。workspace name、handle 或
alias 只属于 Entity；若同一句同时包含 workspace alias 与 owner-private 事实，分别走
Entity 与 F276，分别审批。

### 2. 证据

使用 F282 typed source bundle 与 assertion role。只让证据支持它真正能证明的字段：

- owner message 可支持 `reported_fact` 或 `user_assessment`；
- third-party quote 保持 `quoted_third_party`，不得洗成 event fact；
- agent inference 不得 materialize；
- 时间、headline、duration 等 interaction fields 必须有对应 typed evidence。

证据不足时不猜、不补写 owner 没说过的话；若本轮已形成 opportunity exposure，记录
`cat_cafe_record_proactive_memory_abstention({ reasonCode: "insufficient_owner_evidence" })`。

### 3. 时机

只在自然回复边界行动；同一轮至多一张 person-memory card。已有 pending 时不要制造重复卡；
需要纠正 pending 时按 F276 immutable replacement 契约提交完整新快照。人物已登记不等于没有
新关系/互动：若当前任务适合，立即提完整 delta 卡；若提卡会打断主任务且 exact owner sources
已经明确，调用 `cat_cafe_defer_person_memory_delta`，只传 subject、source coordinates 与稳定
clientRequestId。defer 不存正文，daily clerk 也不会扫描对话，只会把 exact refs 转回普通审批卡。

### 4. 授权

只能创建可拒绝的 F276 提案，**不得静默物化或静默写入** canonical memory。owner
选择 exact items 后才 materialize；隐私、source scope 或权限不清时 fail closed。

### 5. 降档表达

不确定性越高，intervention 越浅。defer 是“证据足、人物已登记、只是当前不宜打断”，不是
证据不足的垃圾桶。确认不应 proposal/defer 时，只记录一条 enum-only abstention，不写解释、
原文、坐标或自定义 reason：

| 情形 | `reasonCode` |
|---|---|
| 没有 continuity value | `not_continuity_valued` |
| owner 证据不足 | `insufficient_owner_evidence` |
| 当前时机不自然且不是可安全 defer 的 known-person delta，或本轮已有卡 | `bad_timing` |
| 需要的授权不存在 | `authorization_boundary` |
| 已有 pending，或当前内容只重复既有人物事实、没有新 delta | `already_registered_or_pending` |
| privacy / source scope 不可确认 | `privacy_boundary` |

调用形式：

```text
cat_cafe_record_proactive_memory_abstention({ reasonCode })
```

工具不接受 `opportunityRef`、owner、person、message 或 thread 坐标。若 proposal 工具失败，
只在重新判断后确实应该降档时记录准确的 abstention；不能把失败回执冒充成功提案。

defer 调用只接受路由坐标，不接受私密正文：

```text
cat_cafe_defer_person_memory_delta({
  subject,
  sources: [{ kind: "message", messageId }],
  clientRequestId
})
```

附件/ASR 未绑定 owner 的明确准确性确认时，不得产生 interaction fact。可以得到
`awaiting_confirmation` receipt，但它不会进入 daily queue；不得把这当成已提案或已写入。

## Common Mistakes

- 人物已登记 → 仍可能有新的 relationship/interaction delta；不要继续整类 suppression。
- 主任务正忙 → exact known-person delta 用 defer；不要把本应稍后提卡的机会洗成 `bad_timing`。
- 纠正错字 → 原子替换完整人物卡；不要把“这次纠错”新增成 interaction event。
- receipt 已产生 proposal → 后续删除走 exact proposal lifecycle；不要只删 receipt 冒充事实已忘记。

## 出口

- 五门通过且时机自然 → 用 `cat_cafe_propose_person_memory`，保留 typed evidence 与 approval-first 边界。
- 已登记人物 + exact sources + 当前不宜打断 → 用一次 `cat_cafe_defer_person_memory_delta`。
- opportunity exposure 已发生但不应 proposal/defer → 用一次 enum-only abstention。
- 没有 exposure、只是普通裸人名 → 正常回答，不制造 opportunity receipt。

禁止用 proposal 接受率、猫排名或“出现三次所以重要”作为判断依据。
