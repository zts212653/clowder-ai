---
feature_ids: [F088]
doc_kind: reference
created: 2026-03-09
---

# F088 平台选型参考

> 此文件从 `F088-multi-platform-chat-gateway.md` 拆出，保留选型决策细节。

## 全球主要聊天平台对比

| 平台 | MAU | 主要市场 | Bot API 成熟度 | 接入难度 | 适合场景 |
|------|-----|---------|---------------|---------|---------|
| **飞书/Lark** | ~1000万+ | 中国企业 | 中-高 | 中 | 国内工作协作 |
| **Telegram** | **~10亿** | 全球（中东/东欧/东南亚/开发者圈） | **极高（最开放）** | **低** | 海外开发者/个人 |
| Slack | ~4000万 DAU | 北美/欧洲企业 | 高 | 中 | 海外企业团队 |
| Discord | ~2亿 | 北美/欧洲社区 | 高 | 低 | 开源社区/游戏 |
| WhatsApp | ~30亿 | 全球 | 中（Business API 付费） | 高 | 个人通讯 |
| 钉钉 | ~7亿注册 | 中国企业 | 中 | 中 | 国内大企业 |
| Teams | ~3.2亿 | 全球企业 | 中（Bot Framework 重） | 高 | 微软生态企业 |

## MVP 选型决策：飞书（国内）+ Telegram（海外）

**飞书**：铲屎官日常工作用，国内企业标配。

**Telegram**：
- 10 亿 MAU，海外开发者浓度最高
- Bot API 是所有平台里**最开放最简单的**——`grammY` 库几十行就能跑起来
- OpenClaw 最重度维护的也是 Telegram（450+ 文件，核心 channel），说明 AI bot 需求最强
- 不需要公网 webhook（支持 long polling），本地开发即可测试

**为什么不选 Slack**：Slack 用户量（4000万）远小于 Telegram（10亿），且偏企业场景。MVP 先覆盖最大用户池，Slack 作为后续企业场景补充。

## 工期评估

### 与 OpenClaw 的核心差异

OpenClaw 用了 ~98.5K LOC 做 25+ 平台，但其中一半以上是 AI agent 基础设施（我们已有）。真正的 channel adapter 层，每个平台 ~1000-2000 LOC。

### 初始评估收敛

- **Ragdoll初始估 3-4 天** → 低估了 outbound 改造 + thread mapping 新真相源
- **Maine Coon初始估 6-10 周** → 口径按 OpenClaw 级产品化，scope 偏大
- **收敛共识：双平台 MVP 7-9 天，全量 3-4 周**

Outbound 不是挂 callback 就完事——需要基于现有 streaming pipeline 挂 final-only hook，这是首个平台最难的 50%。但第二个平台边际成本低，因为共享基座。
