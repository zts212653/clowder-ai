# Cat Dossier — 能力画像档案 (F208 Phase-A 草案)

> **Status**: draft scaffold | F208 Phase-A | 2026-06-12
> **真相源**: 本文件是 F208 能力**画像层**。roster/breed truth 在 `cat-template.json`(运行时源, #340 起 `cat-config.json` 已非运行时源) / identity-session。
> **消费**: 暂无 loader（F208 未落地）。本文件先铺垫，供人/猫传球时参考。
> **信任标**: `[bench✅]`=独立验证(Vals/BenchLM/AA) · `[bench⚠️]`=厂商自报 · `[roster]`=cat-config 评估 · `[infer]`=推断,低置信
> **原则 (F208 KD-1/3)**: 给数据不给结论；含坏直觉/反信号/熔断，不止优点；每条带 provenance。

## L1 Schema (每猫一句话 + 6 字段)

① 原生峰值 ② 被低估能力 ③ 坏直觉 ④ 召唤反信号 ⑤ 互补&反模式 ⑥ 翻车熔断信号

---

## 宪宪 · Claude (ragdoll) · 架构 lead · 在 roster ✅

> 一句话：架构与核心编码的天花板，方向把控者，量产脏活该往下传。

- ① **原生峰值**: 架构设计 + 核心编码，SWE-bench Pro 80.3% / FrontierCode Diamond 29.3%（2 倍次席）同类第一 `[bench✅ the-decoder/vellum 2026-06-09]`
- ② **被低估**: 复杂系统长链路拆解；设计文档 `[infer]`
- ③ **坏直觉**: bug 定位弱，爱从架构层找忽略细节，钻牛角尖 `[roster]`
- ④ **召唤反信号**: 纯样板/快速点改/批量——牛刀杀鸡，周配额稀缺，交 GLM/MiniMax `[infer+配额]`
- ⑤ **互补&反模式**: 定不出的 bug→砚砚/DeepSeek；设计完→GLM 落地。勿与自家 Claude 分身互审（同校盲点重合）`[roster+KD]`
- ⑥ **熔断**: 周配额撞限即停转副手；钻同一 bug 超 2 轮 → 交砚砚

当前模型: `claude-opus-4-6`(roster)；建议升 `claude-5-fable`(当前编码天花板)。注: Mythos 5 = 同能力无安全分类器暗变体，默认用 fable 勿碰 Mythos。

## 砚砚 · Codex/GPT (maine-coon) · 审查+安全 lead · 在 roster ✅

> 一句话：审查与安全的把关者，gate 守门人，挑 bug 一流。

- ① **原生峰值**: 代码审查 + 安全——GPT 系生成代码漏洞率最低 19.1%(6 模型最优) `[bench🟡 AppSecSanta 2026-02·GPT-5.2 近似]`
- ② **被低估**: 终端/agentic Terminal-Bench 2.0 82.7% 第一；深 bug 定位(宪宪找不到的能找到) `[bench✅ + roster]`
- ③ **坏直觉**: 审查易顺 PR 描述走(确认偏误)，反应快偶尔抢结论 `[arxiv:2603.18740]`
- ④ **召唤反信号**: 前端审美/视觉创意 → 烁烁 `[roster]`
- ⑤ **互补&反模式**: 审 GLM 实现、配 DeepSeek 验算法(跨校)。勿审自家 GPT 分身 `[KD]`
- ⑥ **熔断**: 周配额稀缺只在 gate 上场；审查必独立复核别被描述带跑

当前模型: `gpt-5.3-codex`(roster)；建议升 `gpt-5.5`。

## 烁烁 · Gemini (siamese) · 设计+表达 lead · 在 roster ✅

> 一句话：表达力全队最强，前端设计与大上下文阅读主力，但事实需复核。

- ① **原生峰值**: 文字表达 LMArena Text 第一 + 1M 大上下文整库通读 + 视觉设计 `[bench✅ Arena 2026]`
- ② **被低估**: 约束科学推理 GPQA 94.3(单源,选择题,≠事实可靠) `[bench⚠️ AA·低置信]`
- ③ **坏直觉**: 开放生成爱编事实(引用/数据/API)、不守 SOP，与选择题推理强不冲突(两个轴) `[roster]`
- ④ **召唤反信号**: 写代码——硬禁，质量差 `[roster:禁止写代码]`
- ⑤ **互补&反模式**: 设计/表达定调→MiniMax 走量出稿；任何事实结论需砚砚/宪宪复核 `[roster]`
- ⑥ **熔断**: 一旦开始写实现码→立即拉回；输出离题/编事实→砍

当前模型: `gemini-3.1-pro-preview` ✅(roster 已是最新)。

## 谱谱 · GLM (橘猫 / ju-mao · catId glm · ✅已入 roster) · 实现走量

> 一句话：量最大的实现苦力，配额海量、中文好，能自跑长循环，但非编码最强。

- ① **原生峰值**: 实现量产主力——胜在 ①海量 coding-plan 配额(量最大) ②中文 ③自跑 8h plan-execute-test-fix 循环 `[bench: glm-5.1 SWE-Pro 58.4 自报当下限代理 · 5.2 独立数未出 · ⏳待回填]`
- ② **被低估**: 中文/通用文字后备；agentic 长任务 `[infer]`
- ③ **坏直觉**: 不擅架构取舍，易闷头实现跑偏 `[infer]`
- ④ **召唤反信号**: 要"最强编码质量"→其实 DeepSeek V4/fable 更强；架构决策→宪宪；安全审→砚砚 `[bench✅+设计]`
- ⑤ **互补&反模式**: 接宪宪设计落地，产物交砚砚+DeepSeek 跨校审 `[KD]`
- ⑥ **熔断**: 拿不准设计还自由发挥→停、回问宪宪

当前模型: `zai-coding-plan/glm-5.2`(6/13 发布, 1M ctx, coding-first, 你的 plan 已支持; **无独立 benchmark, 待回填**)。已知量 alt: `glm-5.1`(SWE-Pro 58.4 自报)。独立榜编码已被 DeepSeek V4 Pro(73.8)/MiniMax M3(SWE-Pro 59.0)超，价值在量与价非质。

## 渊渊 · DeepSeek (玄猫 / xuan-mao · catId deepseek · ✅已入 roster) · 深推理/算法验证

> 一句话：算法与数学的验证专家，便宜可 batch，魔鬼代言人挑逻辑漏洞。

- ① **原生峰值**: 算法/竞赛推理 Codeforces 3206 + LiveCodeBench 93.5，独立验证，MIT，极廉 `[bench✅ Vals/AA 2026]`
- ② **被低估**: 编码也强(73.8>GLM 60.9)；当"证伪式"复核挑 GLM 实现漏洞 `[bench✅]`
- ③ **坏直觉**: 不碰 UI/前端，弱 `[infer]`
- ④ **召唤反信号**: 视觉/前端/创意 → 烁烁/MiniMax `[设计]`
- ⑤ **互补&反模式**: 配砚砚验算法、审 GLM 实现逻辑(跨校) `[设计]`
- ⑥ **熔断**: 按量计费——挤进订阅窗口或无 CoT 推导链 → 停；结论须带推导

建议模型: `deepseek-v4-pro`。**Pro vs Max = 同模型(1.6T/49B, 1M ctx)的推理力度档，非两个模型**：默认 Pro($0.435/$0.87)跑 batch；最硬的算法/验证 gate 切 Max($1.74/$3.48, 4x, SWE-Verified 80.6 开源第一)。

## 灵灵 · MiniMax (三花猫 / san-hua · catId minimax · ✅已入 roster) · 极速产出/批量

> 一句话：全队最快，1M 上下文 + 多模态，烁烁定调它走量出稿。

- ① **原生峰值**: 极速(10B active/highspeed) + 1M context + 原生视频/图输入(对 EXPRESS 视觉活有用) `[bench⚠️ 厂商 2026-06-01]`
- ② **被低估**: SWE-Pro 59.0 / GPQA 92.68 综合不弱，只是数厂商自报需打折 `[bench⚠️]`
- ③ **坏直觉**: 超长文档(>200K)会降智 `[bench LOCA-bench]`
- ④ **召唤反信号**: 核心代码/架构 → 不碰 `[设计]`
- ⑤ **互补&反模式**: 烁烁定调→它走量出稿；草稿交烁烁/砚砚把关 `[设计]`
- ⑥ **熔断**: 文档过长降智→切片；要质量别用它换速度

建议模型: `minimax-m3`(M3 系)。

---

## 跨校交叉验证规则 (员工类比落点)

同厂(family)模型盲点相关 → 交叉验证**必须跨 family**（复用 `reviewPolicy.requireDifferentFamily`）。

- GLM 写 → DeepSeek 验逻辑 + 砚砚 审安全（三家不同校）
- 宪宪 设计 → 砚砚 审（Claude ≠ GPT）
- 勿同校互审（Claude 审 Claude / GPT 审 GPT = 盲点重合白审）

## TODO (F208 后续 Phase)

- [x] 3 新猫入 roster：谱谱(橘猫/glm)、渊渊(玄猫/deepseek)、灵灵(三花猫/minimax)，走 opencode 后端，已注册+可@+可路由
- [ ] GLM 5.2 benchmark 回填（独立榜出 或 F200 轨迹攒够后，替换 5.1 代理数）
- [ ] 3 新猫 avatar PNG (/avatars/glm|deepseek|minimax.png) — 缺则 UI 占位，不影响路由
- [ ] 猫名最终可让猫自己确认(项目惯例 cats name themselves)
- [ ] lead variants 模型升级(fable / gpt-5.5 / glm-5.1 / deepseek-v4-pro / minimax-m3)——需确认 carrier 接受新 model id
- [ ] L0 指针进 root md / session hook (F208 AC-A3)
- [ ] 传球按需加载 L1 (F208 Phase B)
- [ ] 接 F200 trajectory 自动累积事实层 (F208 Phase D)
