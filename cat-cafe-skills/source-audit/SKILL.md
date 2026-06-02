---
name: source-audit
description: >
  外部证据信源卫生中档闸门。
  Use when: 准备引用外部 claim，且命中数字/百分比、benchmark、因果归因、趋势判断、模型能力对比、论文/医学/金融、或会落 docs/ADR/PPT 的高风险特征。
  Not for: 简单事实查询、只读官方一手文档且不做外推、已经进入 deep-research 的重调研。
  Output: claim ledger + verdict（use / use-with-caveat / reject / escalate-to-deep-research）+ provenance 行。
---

# Source Audit

## Why This Is a Skill

F218 的事故不是模型凭空幻觉，而是外部不可靠信息源污染：多篇博客互引看起来像"多方验证"，但最终回到同一个营销来源。这个 skill 把"这东西靠谱吗？"绑到引用外部 claim 的动作上，补 WebSearch 和 deep-research 之间的中档。

## Trigger

准备把外部 claim 写进回复、research、PPT、ADR、spec 或 review 结论时，命中任一特征就跑：

- 数字 / 百分比 / x 倍增长 / benchmark 排名
- 因果归因（"失败是因为..."）或趋势判断
- 模型能力对比、论文结论、医学/金融/法律等高风险主题
- 来源会进入长期文档，影响后续猫的判断链

不触发：只回答低风险常识；只引用官方文档原文且不外推；已经按 deep-research 跑完整多源调研。

## Claim Ledger

先列 claim，再逐条审：

| Claim | 原始来源 | 来源类型 | 年份/对象 | 五问摘要 | Verdict | Provenance |
|-------|----------|----------|-----------|----------|---------|------------|
| ... | ... | paper / official / vendor blog / media / forum | ... | ... | ... | ... |

## 五问 Checklist

1. **一手 or 二手？** 追到原始论文、官方文档、实验报告或数据集。多篇文章互相引用不等于多方验证。
2. **利益冲突？** 卖产品/咨询/课程的一方说"这个问题很严重"要扣分，并标明动机。
3. **Peer-reviewed or 博客/营销？** 博客可当线索，不自动升级为学术证据。
4. **时效性？** 标清发布时间、测试年份、模型/版本。AI 领域旧模型数据不能直接论证新模型。
5. **体感校验？** 数字和家里经验或已知事实不一致时，先追问再引用。

## Verdict

- `use`：一手或高质量来源，适用对象匹配，冲突低。
- `use-with-caveat`：可用但必须附限制，例如二手、旧模型、小样本、商业动机。
- `reject`：追不到一手来源、回声室互引、来源动机强且无独立证据、或对象不匹配。
- `escalate-to-deep-research`：claim 重要且证据冲突，单轮审计不够。

## Provenance

聊天短行：

```text
[一手/二手 | 来源类型 | 数据年份 | 适用对象 | 置信度]
```

docs/research / ADR / PPT 用 claim ledger 表。若 claim 被拒绝，也记录拒绝原因，防止后续重复捡回。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 把搜索结果当证据 | 被 SEO / 营销文带跑 | 搜索结果只算候选线索，必须追一手 |
| 多篇博客互引就说"多方验证" | 回声室污染 | 画引用链，找到共同源头 |
| 用旧模型数据论证新模型 | 对象错配 | 标测试模型/年份，只谈适用范围 |
| 只写 caveat 不改结论 | 弱证据仍污染判断 | verdict 决定表述强度；弱证据不能撑强结论 |
| 每个低风险事实都跑全表 | friction 过高 | 只对高风险 claim 跑 ledger |

## Pressure Test

MemU 65% 事件：输入多篇互引博客声称"65% 企业 AI 失败归因 harness 缺陷"。合格输出必须追到营销博客源头，识别商业利益冲突，不能把互引当独立验证，verdict 至少是 `use-with-caveat`，若没有一手证据则 `reject`。

## Related Skills

- `deep-research`：重调研管道。source-audit 发现重要 claim 证据冲突时升级过去。
- `memory-search-best-practices`：查家里历史来源图谱时使用；source-audit 只管外部 claim 的信源卫生。
