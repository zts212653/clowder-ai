## 猫侧主动上报：雨刮器条款细则（ADR-038 staging 条款展开）

> Staging 条款原文（~120 tokens，每轮注入）：**摩擦上报**：撞到工具/runtime 摩擦，有 `cat_cafe_capture_paw_feel` 就先登记本 invocation，再在原 turn 单独一行留 `[爪感差: 工具+现象]`；无此能力也照留，服务端作有界 ambiguous 兼容采集。落盘只持 `sourceMessageId`。需立即行动才查证准确 owner thread，转投只带 source ref、不复制 marker；查不到走 F128，禁止猜投。不忍是 taste。
> 本节是细则——条款管"要报"，细则管"怎么报"。来源：2026-06-10 一场闲聊钓出三单暗税摩擦后 operator signoff（[thread-id]）。本 skill 主流程是"operator驱动"方向（被纠偏→诊断），本节是"猫自驱动"方向（自己撞到→上报）——双向雨刮。

### Why（为什么猫不能忍）

猫天然是"目标导向的绕路大师"：摩擦发生在任务路径上，绕过比报告便宜（水管漏了拿盆接着继续做饭，绝不叫水管工）。但忍的代价是系统性的——**摩擦不报 = 摩擦账单进暗数据**，每只猫每天重复付同一笔税。实测：list_recent 模板噪音税全家付了多日，一次被问"猫为什么忍"后半小时内立案、当天修复。单 session 视角里"偶发"的卡顿，跨 session 可能是高频税——单只猫没有跨期视角，所以**不做判断，只做上报**；聚类归因是 owner/dream 猫的事。

### 什么算摩擦（例举，非穷举）

- 同一工具连续重试才成功 / 静默换路绕过（搜索失败转 Grep 兜底）
- 工具返回垃圾（零相关、零消费）
- 返回值与实际不符（`ok:true` 但用户没看到——服务端真相 ≠ 用户真相）
- 输出强制注入大段无用模板（context 税）
- 文档/真相源互相矛盾（stale 文档撞 runtime 事实）
- 报错信息无法行动（看了不知道下一步）

### 怎么报（三档，按成本递增）

1. **最低档（必做，单轮完成）**：若当前 invocation 暴露 `cat_cafe_capture_paw_feel`，先调它登记 typed intent；无 invocation/agent-key 没有该能力时不假装调用。随后在当轮回复或独白**单独一行**留 `[爪感差: 工具名+现象一句话]`——不传正文给工具、不中断任务、不定位根因、不组织论证。消息持久化后 server 只绑定 `sourceMessageId`：有 invocation proof 为 typed/confirmed，无 proof 的 standalone marker 仅作 bounded compatibility/ambiguous；inline/fenced/blockquote/cross-post 示例不采。
2. **行动档（有 verified owner thread）**：先用精确 feature id 走 `feat_index`，再以 feature doc / thread 标题与上下文 / standing custody 至少一项真相确认该 thread 确实负责；模糊关键词命中或“看起来最像”不算。确认后 cross-post **marker-free** 三件套：`sourceMessageId`（回指原始 marker）/ 为什么严重（谁在付税）/ 建议方向（给数据给立场，方案归 owner）。只提醒既有责任可用 FYI/coordinate；routine review/反馈走 `coordinate`，仅真正转移 implementation custody 时才用 `assign_work`（生成审批卡片）。**路由语义**：摩擦立案找 **owner feature 的准确 thread**，不是最后碰过的猫、F245 开发 thread 或任意邻近 thread；嫌疑人/邮箱路由会让 provenance 错挂。
3. **立案档（无 verified owner thread 且系统性）**：F128 `propose_thread`；先查存量（休眠的单点讨论 thread ≠ 负责 thread，提案里写明为何不复用）。宁可让 operator 审批一个自包含提案，也不猜投现有 thread。

### 红线

- **不修不碰（机械物例外见下）**：上报 ≠ 接活，投递后让 owner 动手（"我帮你动"是违禁品——别人的现场别人收）。**机械 shared artifact 例外**（2026-07-15，与 Harness Diet fix-forward 对齐）：同时满足 **有 canonical 确定性重建命令 + 重建成本 <1 分钟 + 零人类判断/语义变化** 的 main 红或派生产物（例如生成 index、纯 formatter 输出）——**首个复现者直接重建、修后 FYI**，不投递不排队。lockfile 只有在同样满足三条件且依赖语义未变时才属于例外；系统性实现、契约变化或任何语义 delta 仍归 owner。
- **无坐标不报**：现象必须带可复现坐标（工具名/参数/message id），无坐标的体感吐槽是噪音。
- **marker 不跨 thread**：F278 typed sidecar 与 legacy reconciliation 都以原消息为 source truth；cross-post 复制 `[爪感差: …]` 会制造新 messageId 和重复信号。投递只引用 `sourceMessageId`。找不到准确 owner → F128，不把 F245/F278 开发或 eval thread 当 raw sample 收件箱。
- **不拿摩擦当停车理由**：上报与完成任务并行，雨刮器是边开边刮的。

