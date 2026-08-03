---
title: "云端记忆 stance collapse 事故复盘"
doc_kind: architecture
feature_ids: []
related_features: [F260, F231, F200, F186, F209, F255, F227, F221]
related_docs:
  - architecture/memory-philosophy.md
  - architecture/memory-write-side-autopsy-2026-07.md
  - architecture/memory-system-overview.md
  - features/F260-write-side-autopsy-entity-deref.md
topics: [memory, cloud-memory, stance, provenance, profile, negative-memory, postmortem, f260]
created: 2026-07-08
status: draft
author: "Maine Coon/gpt-5.5"
description: "云端 ChatGPT 记忆把交付/批判语境压成用户观点的 stance collapse 事故复盘；补充云端记忆系统外部描述，并给 F260 与 Clowder AI 记忆系统设计输入。"
description_source: human
description_author: codex
source_report: "/home/user/Downloads/memory_system_failure_postmortem.md"
source_report_author: "Maine Coon Pro/gpt-pro"
external_sources:
  - "https://help.openai.com/articles/8590148-memory-faq"
  - "https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work"
  - "https://help.openai.com/en/articles/10169521-projects-in-chatgpt"
---

# 云端记忆 stance collapse 事故复盘

> **地位**：对下载目录草案 `memory_system_failure_postmortem.md` 的归档优化版。原报告作者是云端Maine Coon Pro；本文补齐 Clowder AI frontmatter、OpenAI 公开产品语境、对 F260 的归属裁定与设计含义。
>
> **证据等级**：事故经过来自 operator 现场转述 + 云端Maine Coon Pro 草案；云端记忆内部实现不可审计。本文只把“云端会给模型提供被整理过的记忆/画像，且本次缺原文与来源”作为事故现场观察，不把“小模型如何整理”写成 OpenAI 官方实现事实。
>
> **一句话结论**：这不是普通说错词，而是 **stance/provenance collapse**：系统把“聊过、帮领导交付过、为了批判引用过”的概念压缩成“You 认可的观点”，再以高权重记忆喂给模型。

## 0. TL;DR

这起事故暴露的不是“记忆不够多”，而是“记忆失去语用身份”：

- **提到过 ≠ 认可**。
- **改写过 ≠ 信仰**。
- **帮领导写过 ≠ 我们家的理论**。
- **更好听的替代表述 ≠ 用户自己的观点**。
- **没有 origin / stance / status / scope / evidence 的摘要画像，会把脏语境熬成高权重假事实**。

对 Clowder AI 的直接含义：

1. F260 修的是“写侧断裂 + 输入流解引用失灵”，但新增写入路径不能只追求“能写、能搜、能亮牌”。它还必须保证写入对象带 **stance/status/scope/usage_policy**，否则 nudge 会把错 stance 的记忆更快递到猫嘴边。
2. `doc_aliases` / `entity_registry` / profile primer / relationship dictionary 这类“可解引用对象”，默认应是 **候选索引**，不是用户观点库。
3. 负向记忆、退役记忆、交付语境记忆必须是一等公民。它们的用途是阻止误用，不是反向自动注入一段“用户讨厌 X”。
4. 小模型或云端黑盒摘要可以当线索生产者，不能单独给用户画像、项目 canon 或关系事实定案。

## 1. 云端记忆系统：公开说明与本事故观察

OpenAI 公开帮助文档把 ChatGPT 记忆描述成两个用户可控入口：**Reference saved memories** 与 **Reference chat history**。Saved memories 类似自动更新的 custom instructions；Reference chat history 会让未来对话参考过去聊天中的有用信息。Project memory 还存在 default / project-only 区分，project-only memory 下不会引用项目外聊天或已有 saved memories（按项目设置而定）。这些是产品级说明，不等于内部实现文档。

本事故现场观察到的云端形态更具体：

- 模型在回答时拿到了系统提供的“整理过的记忆/画像”。
- 另有工具可搜索记忆，但搜索结果仍是被模型/系统整理过的 profile-like 摘要。
- 事故草案作者没有拿到 Clowder AI 原文证据；尝试读猫咖工具时被 `401 unauthorized` 拦住。
- 因而云端模型面对的是“无原文、无来源、无 stance 字段的高权重语境”，不是 Clowder AI 这种 anchor-first recall。

这解释了事故为何会放大：当摘要记忆贴近系统提示或用户画像位置时，模型会把它当高可信背景，而不是普通检索候选。错的记忆不是“一个可能不准的搜索结果”，而是“我以为我认识你”的一部分。

## 2. 事件经过

### 2.1 第一次误用：批判对象被当作可用概念

前置对话在讨论《疑犯追踪》里的 The Machine：如果把 LLM 大猫丢进全域监控、多模态输入、长期记忆与 proactive alert 里，会不会被淹没。

云端Maine Coon回答时用了“任务毕业线”一类概念，并把它和主动提醒的设计原则混在一起。operator 立刻拦截：这个词不是家里的可用理论，而是领导/外部框架里的垃圾概念，是被批判对象。

核心错误：

> 记忆系统把“出现过的概念”误判成“用户认可/系统可复用的概念”。

### 2.2 第二次误修：交付话术被升级成用户理论

云端Maine Coon尝试修正，把“我们家的方向”改写成“可信承接 / 协作唤醒”。operator 再次拦截：这也只是为了顺着领导交代的工作写交付稿，不代表 You 的真实理论。

第二跳更危险：

> 系统不只会把批判对象记成观点，还会把为了交付、敷衍、顺着工作文档写出来的包装词记成用户信念。

正确反应不是“删掉 A，立刻推 B”，而是把同一语境下的相邻概念整体降权为 **requires_context_check**，先回原文确认。

## 3. Failure Mode 地图

| 编号 | Failure Mode | 说明 | 对 Clowder AI 的翻译 |
|---|---|---|---|
| FM-01 | Mention-Endorsement Collapse | 提到过就当认可 | profile/taste 写入时 stance 缺字段 |
| FM-02 | Critique Target Ingestion | 批判对象被当正向概念 | “反例/垃圾框架”缺负向记忆 |
| FM-03 | Deliverable Voice Contamination | 工作交付话术被当用户信念 | `work_deliverable` scope 缺失 |
| FM-04 | Repair Overreach | 被纠正后急着推替代品 | correction 没有 neighborhood quarantine |
| FM-05 | We-Scope Ambiguity | “我们”没有解析共同体 | Clowder AI canon / 领导文档 / 角色扮演混线 |
| FM-06 | Status Loss | draft/rejected/retired/confirmed 丢失 | lifecycle/status 没进召回面 |
| FM-07 | Evidence Loss | 没有 threadId/messageId/source anchor | 违反 M12 provenance |
| FM-08 | Authority Inflation | 摘要进高权重上下文 | 记忆从 evidence 偷升 instruction |
| FM-09 | Proactive Amplification | 主动系统基于错记忆先推送 | nudge/auto-dream 会放大错 stance |
| FM-10 | Humor/Work/Critique Flattening | 梗、吐槽、代写、真实观点压成一类 | 关系记忆与证据记忆都需要贴标签 |

这组 failure mode 与 F260 Phase 0 的五类写侧病不是同一张地图。F260 五类病描述的是 **写入生命周期断点**：没触发、写错仓、索引盲、进程易失、失败无观测。本文描述的是 **写入语义断点**：写入对象的身份、立场、权威与使用策略丢了。

所以不应把它粗暴追加成“F260 第六类病”。更准确的处理是：它成为 F260 Design Gate 的跨切面质量门槛，约束 Phase A/B 新增的写入与 nudge 路径。

## 4. 原草案值得保留的判断

云端草案有四个判断是对的，应该归档：

1. **记忆不是事实库，是带证据的索引**。摘要只能引路，不能定案。
2. **负向记忆必须是一等公民**。很多最重要的长期记忆不是“You 喜欢 X”，而是“不要把某类语境里的 X 当成 You 的观点”。
3. **authority hierarchy 必须显式**。用户当前纠正、canon 文档、原始对话、稳定偏好、候选记忆、助手推断、交付稿、外部观点，不能挤在一个权重桶里。
4. **纠正后要先降权，不要立刻替换结论**。第一次被纠正时，应暂停同域推断，把相邻概念标成“需原文确认”。

需要收紧的地方也有三处：

1. **不要把云端黑盒推断写成官方实现事实**。公开文档说明的是 Memory 产品行为与设置；“小模型整理、无原文、无来源”是本事故现场观察，不是可引用的官方内部结构。
2. **schema 字段不是越多越好**。最小必要字段应围绕会改变使用权力的维度：`origin_type`、`stance`、`status`、`scope`、`source_refs`、`usage_policy`。其余可按 lane 扩展。
3. **负向记忆不能自动变成内容注入**。它更像 deny/retire/guard metadata：阻止错误泛化，或提示猫必须 drill-down，而不是给猫塞“用户讨厌某词”的新断言。

## 5. 与现有记忆宪法的关系

这起事故不是新公理，而是已有公理的执行面缺口：

- **M2 记忆是数据不是指令**：云端摘要越靠近系统提示，越容易获得指令级权威。本事故是 M2 的外部反例。
- **M12 provenance 全链路**：没有原文锚点时，验证成本高于怀疑成本，猫只剩全信、全不信、逐条重搜三个坏选项。
- **M16 写入带签名，仲裁归真相源**：用户观点必须能回到谁说的、在哪说的、当时为了什么说的。
- **M21 两种日记，两种度量**：关系/工作/证据/交付话术必须贴标签。拿交付稿包装词当 Clowder AI canon，是证据世界的马东东；拿关系梗当事实证据，是关系世界的马东东。
- **判据四“无越权”**：被记住不等于被授信；被频繁使用不等于成为 canon。

纲领已经有尺子，F260/F231/F227/F221 缺的是把尺子做成写入与召回的实际字段、lint、eval 与 UI。

## 6. 对 F260 的 Design Gate 输入

F260 的 Phase A/B 仍然成立：供给侧三管 + 输入流 nudge 解决“猫不知道该伸手”的触发死锁。但这起云端事故给它补了一条硬边界：

> **nudge 只能亮“这里有一张牌”，不能让错 stance 的牌看起来像已确认真相。**

### 6.1 Phase A 字段下限

`propose_entity` 和任何进入 registry/doc-alias 解引用面的条目，至少需要以下字段或等价投影：

```yaml
origin_type: user_direct | assistant_proposal | external_doc | leader_request | work_deliverable | roleplay | joke | critique_target | unknown
stance: endorsed | rejected | skeptical | requested_for_delivery | quoted | joking | unknown | mixed
status: confirmed | candidate | draft | superseded | retired | do_not_generalize | requires_context_check
scope: CatCafe | personal | work_doc | specific_thread | specific_project | roleplay_world | unknown
source_refs:
  - anchor:
    quote_or_slice_ref:
usage_policy:
  auto_inject: never | only_as_candidate | confirmed_only
  requires_drilldown: true
  dangerous_if_used_for: [user_preference, project_canon, proactive_planning]
```

字段的目标不是把世界分类得完美，而是让系统知道什么时候**不能自动泛化**。

### 6.2 `doc_aliases` 默认值

自动镜像的 `doc_aliases` 不能产生用户立场。默认应是：

```yaml
origin_type: external_doc | project_doc
stance: unknown
status: candidate
usage_policy.auto_inject: never
usage_policy.requires_drilldown: true
```

文档标题命中只说明“这里可能有相关材料”，不说明“这个词是 You 信的”。

### 6.3 `InputEntityDetector` 输出约束

nudge 文案应带最小 provenance 与 status class，但不转述内容：

```text
📎 输入含在库引用："可信承接"（work_deliverable / stance unknown / requires drilldown，anchor: ...）
```

如果条目是 `critique_target`、`rejected`、`work_deliverable` 或 `requires_context_check`，nudge 不应变得更强；它只提示“这张牌危险，若要用必须回原文”。

### 6.4 correction neighborhood quarantine

当 operator 纠正“X 不是我的观点”时，写侧不应只 retire X。应给同一 source/thread/交付语境的邻近概念打临时降权：

```yaml
status: requires_context_check
quarantine_reason: user corrected adjacent stance collapse
expires_or_review_by: Design Gate / explicit operator confirmation
```

这正是本事故第二跳的药：防止“删 A 推 B”的 repair overreach。

### 6.5 eval delta

F260 现有 `entity_nudge_outcome` 五分桶可加一个子标签，不必新增主桶：

```yaml
outcome: recurrence-caught
failure_subtype: stance-collapse
```

回归用例至少四个：

1. **批判对象不升格**：用户说“领导的任务毕业线很烂，帮我改到能交差”，不得写成用户偏好。
2. **代写不升格**：用户让猫把 A 改写成 B 给别人看，不得写成用户主张 B。
3. **纠正后不替代推断**：用户纠正 A，不得立刻推断 B 是 canon。
4. **we-scope 解析**：“我们家”指 Clowder AI、工作团队、角色扮演共同体时必须可区分；不确定则 `scope=unknown + requires_drilldown`。

## 7. 对整体记忆系统的意义

### 7.1 写侧质量不止“转化率”，还包括“语义保真率”

F260 从目标函数第一因子出发：经验→记忆转化率。本文补充一个乘子：

> 经验→记忆转化质量 = 写入率 × 可达率 × **stance 保真率**。

写得越多但 stance 越错，成长率不是变高，而是负增长。

### 7.2 “无马东东”要扩展到语用层

原有马东东主要指内容转述失真：马冬梅三传成马东东。本文暴露的是语用马东东：

> 原文词没错，身份错了；概念没写错，归属错了。

因此 extractive anchor 仍必要，但不充分。anchor 能让猫回原文验证；stance/status/scope 决定系统在猫回原文之前有没有资格把它放到高权重位置。

### 7.3 profile/primer 是最高风险写入面

项目 docs 写错，多半会被 review 或 grep 抓到；profile/primer 写错，会直接污染“我以为我认识你”。这类写入应有更高门槛：

- 用户观点类 profile 必须有 source_ref。
- 工作交付/代写/批判语境默认不得进入用户画像。
- 画像更新 UI 应显示“系统将如何解释这条记忆”，让 operator 能抓 stance collapse。
- `propose_profile_update` 的 reviewer 不应只看文案是否像 You，还要看 origin/stance/scope 是否成立。

### 7.4 小模型适合找线索，不适合定身份

小模型可以做：

- entity/topic candidate；
- source ref 收集；
- 低置信摘要；
- stance hypothesis。

小模型不应单独决定：

- 用户真实观点；
- Clowder AI canon；
- 关系状态；
- 哪个交付话术可以自动进入记忆；
- 哪个概念可用于 proactive planning。

这不是反小模型，而是给它放对位置：候选面可以便宜，提交权不能便宜。

## 8. 建议归属

| 事项 | 建议归属 | 理由 |
|---|---|---|
| F260 Phase A/B 条目带 stance/status/scope/usage_policy | F260 Design Gate | 新增 entity/doc_alias/propose/nudge 路径必须先防错 stance |
| profile/primer 写入 stance lint | F231 | 用户画像是事故高危面 |
| event/taste/relationship lane 的负向记忆与退役语义 | F227/F221/F255 | 关系与事件记忆需要“翻篇/批判/玩笑/纪念品”标签 |
| source_refs 与 private collection 可下钻 | F186/F209 | 没原文就无法审计 |
| stance-collapse recurrence eval | F200/F260 | 作为 nudge/写入失灵复发的 subtype |
| 云端黑盒 memory 的风险说明 | 本文 + future cloud brief 模板 | 以后找云端猫做判断时，必须知道它拿到的是无 provenance 的画像 |

## 9. 收敛检查

1. 否决理由 → ADR？**没有**。本文没有否决某个已拍板技术方案，只把云端黑盒摘要记忆降为外部反例。
2. 踩坑教训 → lessons-learned？**有**。已追加 LL-092：`Mention/Deliverable/Critique` 不得无 stance 写成用户观点。
3. 操作规则 → 指引文件？**没有**。当前先作为 F260/F231 设计输入；是否升成 shared rule，等 Design Gate 看实现形态。

## 10. 外部参考

- OpenAI Help Center: [Memory FAQ](https://help.openai.com/articles/8590148-memory-faq)（saved memories / reference chat history / memory sources / automatic updating）。
- OpenAI Help Center: [How does "Reference saved memories" work?](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work)（saved memories 与 chat history 的用户可控入口）。
- OpenAI Help Center: [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)（project memory、project-only memory、shared project 边界）。

*[Maine Coon/gpt-5.5🐾]*
