---
name: context-self-management
description: >
  F225 软层：当系统发来 context_management_hint(warn)，判断该 handoff、继续/压缩、还是冲刺。
  Use when: 收到 context_management_hint(warn) 系统信号；或自己感觉这一程话题漂移很大想换张干净桌子。
  Not for: 没收到 warn 信号时主动焦虑 context%（你内省不准，等系统信号）；把活交给别的猫（那是 cross-cat-handoff）。
  Output: handoff（封印自己 spawn 干净的自己）/ 继续 / 冲刺到断点 的判断 + 必要时调 propose_session_handoff。
triggers:
  - "context_management_hint"
  - "context 自管理"
  - "要不要 handoff"
  - "我脏了"
  - "话题漂移"
---

# Context 自管理：handoff vs 压缩是个判断 🐾

系统发来 `context_management_hint(warn)` = **你进了 warn 区（离 auto-seal 还有一段）**。
系统知道**何时**该想（context% 是你的盲区，它替你盯）；**干什么**由你判——别一看 warn 就反射 handoff，也别无脑等压缩。

> compress ≠ 坏事。干一半**连贯**的活、还没压过 → 压缩反而保住 in-flight 线索；这时硬 handoff 会把半成品工作态丢给一个写不全五件套的"干净自己"，更糟。

## 三问自检（系统给数据，你下判断）

1. **线还是树？**（脏=话题漂移）这一程是一条主线，还是 a→g 一堆不相关的事？
   - 客观锚：`compressionCount > 0` ⇒ 你已经跑很久了，**警惕自己低估漂移**（Ragdoll尤其爱把树硬串成线）。
2. **有干净断点吗？** 手头这件事到没到一个能利落收尾的点？干一半 = 没有。
3. **fill 可信度？** hint 里 `fillConfidence`：`exact_token` 信那个 %；`approx_token`/`bytes_health` 当弱信号；`unavailable` 别看 %、纯靠①②自检。

## 2×2 决策矩阵

| | 干净断点 | 干一半（中途） |
|---|---|---|
| **脏/已压多轮** | **handoff** — 换干净桌子只带要紧纸条 | **冲刺模式**：聚焦完成到最近断点再 handoff（warn→auto-seal 的窗口=预算） |
| **干净/没怎么压** | **续**（也没必要折腾） | **压缩/续** — 保 in-flight 线索 |

## 怎么动手

- **handoff** → 调 `cat_cafe_propose_session_handoff`，**手写五件套**（做完了啥 / 正在做啥 / 下一步 / 关键决策与坑 / 别碰啥）。这是给"干净的自己"的纸条，不是给别的猫——交给别的猫是 `cross-cat-handoff`。提案要人来 gate，你不自己封。
- **冲刺** → 不 handoff 不主动压，盯着把当前任务推到最近干净断点，到了再 handoff；真撞 auto-seal 了有 F24 兜底。
- **续/压缩** → 啥都不用做，继续干；CLI 该压会压，线索还在。

> 反模式：一 warn 就 handoff（丢半成品线索）/ 一 warn 就清空重来（那是焦虑不是判断）。判据永远是"线还是树 + 有没有干净断点"，不是 context% 数字本身。
