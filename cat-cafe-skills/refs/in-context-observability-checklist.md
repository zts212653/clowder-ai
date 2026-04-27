# In-context Observability Checklist (现场可感知性 / 明厨亮灶自检)

> **核心铁律**：**统计是事后审计，现场可感知性是第一入口。**
>
> 来源：F174 callback auth lifecycle D2b 设计实战（2026-04-25）。
> 类比范式：Cat Café 的 memory entity 自带状态、browser-preview 把页面端上桌——
> entity carries its own state, surface it where it happens.
>
> 反面：Datadog/前 agent 时代的 stats dashboard——出问题了，等用户主动切到 tab 才看到数字 +1。

## 触发范围

任一命中即必过本 checklist：

- agent 状态变化（猫猫的 health / busy / degraded / offline）
- runtime failure（callback auth 401、tool 调用异常、上游断连）
- 后台任务（长 build、批处理、scheduled task 进度）
- auth & degradation（token 过期、降级模式、fallback 触发）
- diagnostics（debug endpoint、trace 采样、错误回溯）
- health & status（service health、dependency 探活）
- 跨猫协作可见性（球权状态、传球链、外部 identity 等待）

不命中则跳过——但请在 Design Gate 讨论里写一句"无 observability 触发，原因：…"。

## 5 个必答问题

1. 这个失败/状态，**谁第一时间需要看到**？（出问题的猫 / 受影响的铲屎官 / 旁观的猫）
2. 第一现场有没有 **in-context 通道**（thread 富块、entity 自带状态、avatar dot、cat status badge）？
3. 类比哪个已有 Cat Café entity 范式？（memory entity 自带状态？browser-preview 端上桌？sigil status dot？）
4. 如果只能保留一个 surface，是 in-context 还是 dashboard？（**默认必须 in-context 优先**）
5. dashboard 是否被定位为"事后审计"而非"日常感知"？

## 必产出决策字段（写入 Design Gate 讨论文档）

回答完 5 问还不够——必须在 Design Gate 讨论文档里产出以下结构化字段，否则 Design Gate **不放行**：

```yaml
in_context_observability:
  primary_surface: "..."        # 第一现场入口：in-context 富块 / entity 状态点 / cat avatar dot / sigil badge / ...
  why_not_dashboard_only: "..." # 一句话解释为什么单纯 dashboard 不够（默认必填，强制反思）
  deep_dive_surface: "..."      # 如果有 dashboard，它的定位是什么？事后审计 / 批量诊断 / 跨周期趋势 / 无
  noise_dedup_policy: "..."     # 同类事件如何聚合？阈值多少？支持隐藏/折叠吗？
```

## 噪音约束（防止"明厨亮灶"退化成"厨房报警器一直响"）

in-context 富块只应该用于**影响当前行动 / 需要用户或猫立即感知**的事件。否则：

- 重复失败必须 **dedup / 聚合**（同一 reason+tool+cat 5 分钟内只发一条）
- 同类消息必须提供"**隐藏类似消息**"入口（让用户主动收起噪音源）
- 非阻塞性的状态漂移走 **entity 自带状态**（avatar dot、status badge）而不是 thread 富块——别每次 token 刷新都发一条系统消息

## 反模式（看到这些直接打回）

- ❌ 把所有失败统计塞进一个 stats card，等用户主动去 tab 看
- ❌ 出问题的现场没有任何提示，只在 dashboard 数字 +1
- ❌ 每次失败都发一条 in-context 富块，没有 dedup/聚合
- ❌ Primary surface 写"dashboard"——这不是 Cat Café 的产品哲学
- ❌ "等以后再做 in-context，现在先把 dashboard 做了"——本末倒置，dashboard 永远比 in-context 好做，先做 in-context

## 三层模型（参考实现）

F174 D2b 收敛出的标准三层结构，新 feature 可以照搬或裁剪：

| 层 | 优先级 | 形态 | 触发条件 |
|---|--------|------|----------|
| **L1 现场（in-context）** | P0 | thread 内系统富块（tinted, 带 reason badge + 快捷动作） | 影响当前行动的失败/状态变化 |
| **L2 实体（entity-self）** | P0 | avatar status dot / sigil badge + hover tooltip | 持续状态（健康度、24h 故障摘要） |
| **L3 深挖（dashboard）** | P2 | HubObservabilityTab 子卡片 | 事后审计、跨周期趋势、批量诊断 |

L1 + L2 是日常感知的硬要求。L3 是给愿意深挖的人/猫准备的，**不能抢日常注意力**。

## 与其他 Gate 的关系

- **在地设计检查**（design-in-context-checklist.md）：管"新 UI 元素往哪放、和已有元素怎么共存"
- **元审美自检**（meta-aesthetics canon）：管"方案是不是坐标变换 vs 多项式堆项"
- **本 checklist**：管"功能该如何被人/猫第一时间感知"——感知层面的设计哲学

三个 gate 互不替代，可观测性相关 feature 必须三个都过。
