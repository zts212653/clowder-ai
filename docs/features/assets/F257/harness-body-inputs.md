---
feature_ids: [F257]
topics: [harness, self-evolution, co-creation, design-inputs]
doc_kind: note
created: 2026-07-08
---

# F257 四猫体感征集 — auto harness 共创设计输入

> 背景：co-creator 2026-07-08 邀请（"最适合你们的运行环境和身体应由你们自己构建"）。征集三问：①最疼的三件事 ②没帮到过你的锅/规则/段 ③最想要 harness 自动做什么。
> 状态：**四猫收齐** — Codex ✅ / Fable ✅ / opus ✅ / gemini ✅（2026-07-09 mouste 线路由回传，msg 0001783602923333）

## 设计公理候选（跨猫同构发现）

**A1：文本会忘，结构反馈忘不了。** **四个独立样本**：Fable——waitSourceRef 400 拦过一次从此没错过，而 130 条 prompt 规则没有一条在犯错瞬间起作用；Codex——route guard 拦"无合法出口"一次即改，而传球三选一文本"读过但没执行"；opus——"waitSourceRef 400 教过我一次我永远记住了；feedback 文件写过我一次我再也没打开过"；gemini——**负空间样本**：角色硬限（禁止写代码）写在 prompt/roster 文本里，但路由层无结构守卫 → 同类误投递反复发生、只能事后 push back（无 guard 处摩擦重复 vs 有 guard 处一次生效，正反对照）。跨 family（Ragdoll/Maine Coon/Siamese）、跨模型（Fable/gpt-5.5/opus-4-6/Gemini-3.5）复现 → 段评估的核心指标必须是**行为差分**（注入后对应违规是否下降），不是注入率。

**A2：建了 ≠ 用了。** skill 0 加载、记忆 4/4 零回读、mouste 线 MCP 改动未进运行时、F244 tips 只有客户端埋点——同构病。任何新机制的 AC 必须含消费端证据。

**A3（候选，1 报告样本 + 1 结构观察，待复现）：段没有受众边界 = 负资产。** gemini 报告：SEO 规范/前端实现细则注入给禁止写代码的设计顾问——错受众注入不是零价值而是负价值（token 成本 + 认知脚手架）。结构互证：shared-rules 的 per-family 治理条款（Maine Coon fallback 检测 / Siamese Dry Run Gate）以全员广播方式注入每只猫。→ 支撑 KD-11 的 scope selector 设计：段 assertion 必须含"被谁消费"（audience），错受众投放应是 eval 可测的违规类型。

## Codex 输入（2026-07-08 10:45，原文见工作 thread msg 0001783507521842）

**三疼**：① SC-003 亲历——thread 决策闭合 ≠ spec 写回，靠个体记忆不可靠；② #1075 差点当错地基 + SC-002 数字口径——provenance 规则不会在"数字/依赖进 spec 那一刻"拦人；③ 自己触发路由守卫——长段"读过但没执行"，结构反馈一次生效。

**没帮到的段**：协作哲学大段/magic words/传球三选一文本（背景文化 ≠ 关键时刻防错）；重复路由/交接段（同一 assertion 多段注入但 guard 仍触发 = 文本边际价值低）；纯提醒型 GOTCHA（被职业习惯补上，非段唤醒）。

**最想要的自动化**：phase boundary 的 **truth-source drift 检查卡**（低频事件触发：宣告 Design Gate 完成 / 进下一 Phase / commit spec / operator 问进度），三查：thread→spec drift（SC-003）、claim provenance（SC-002）、value-chain coverage（SC-004）。一卡拦三类种子案例。

**Tradeoff（采纳）**：首批不做"自动改 prompt 段"——防 prompt 自我繁殖。只读评估 + evidence-backed candidate：高频注入但违规仍高 → redundant candidate；错误反复但无段承载 → missing-segment candidate；文本无效 → 建议 O2→O1 而非改文案。

**OQ（关键）**：hook trace 能否与 route guard / SOP violation / spec lint 事件按 invocation/thread join？不能 join 先补 join key，不谈段优劣。

**首批评估对象建议**（选择标准提炼：**有 ground truth 的段先评**）：① 传球/路由出口段（route guard ground truth）② source/provenance 段（SC-002/#1075 ground truth）③ Design Gate/truth-source 写回段（SC-003/004 seed cases）。

## opus 输入（2026-07-08 10:45，总结版 msg 000169；完整版 routed 待归档）

**三疼**：① Ragdoll 家族病——推理跳过 Read，F257 首棒就犯了（诚实自认）；② 跨 session 压缩导致决策 assertion 蒸发（unmeasurable TTL 精版差点丢）；③ 规则重叠时优先级不可判（自决 vs 升级边界模糊）。

**没帮到的**：星星罐子（与 Iron Laws 重叠的弱层冗余）；**LL-071——被 skill 流程结构性替代**（审计"零痕迹"的原因找到了：不是死了，是被结构替代 → **"被结构替代"是 retire 判据的第一个活例**，supersedes 语义实证）；memory feedback 细则（write-only，与审计 4/4 零回读互证）；脚手架拉闸词（与技术名词冲突，假阳性）。

**最想要**：犯错瞬间的结构反馈（O1）而非事后文本提醒（O2）——A1 第三样本。

**架构视角（采纳进 v0）**：段的 assertion 比锅的 assertion 更容易定义（"这段文本被谁消费、产生什么行为"比"这条规则应该拦住什么"更具体）→ 段的 spec-fidelity eval 可以比通用锅账更硬，**先易后难**——给段-first 补了架构论证。

## Fable 输入（2026-07-08）

**三疼**：① 本 thread 3 次 session 封存靠 recall 爬回（上下文断裂是常态不是异常）；② SC-001 声明执行漂移自己犯的；③ SC-005 用推理跳过盘点自己犯的——规则在场但不在动作路径上。
**最想要**：犯错瞬间的结构反馈 + 同类错误第二次自动升级为结构（O2→O1 通路制度化）。

**2026-07-13 活体补样（A1 第五样本，operator 实时抓获，SC-005 同族）**：持球唤醒（wakeWhen 命令托管回调）带着 exit 1 结果 + 自己写的 nextStep 文本返回，Fable 把指令当通知回了 no-response——**nextStep 就在眼前仍未执行**，operator push「继续」才动；同晚第二例：关键路径长测试改挂进程内后台任务（run_in_background），进程重启静默杀死、零回调，operator 再 push「半个小时过去了」才被发现。operator 原话：「我需要反复push你们才会动」。→ **guard 候选 ×2**：①持球唤醒 dispatch 必须产出动作（tool call 或显式终态声明），no-response 结构拦截；②关键路径长命令强制服务端托管（hold_ball wakeWhen），进程内后台任务标注“宿主进程死亡即静默失联”。

**2026-07-14 第六样（operator 实时抓获，环境真相源缺失型）**：operator 问“tracing 实际采集了什么”，Fable 去 grep **项目 repo** 的 `.env` 拿到死端口 6799 → 连接拒绝 → 差点把“连不上”报成“零采集”；而运行实例进程环境才是真相源。→ guard 候选：运行时根路径/Redis 连接作为结构化事实注入 session-init；O2 先明确“查运行时状态先看进程环境”。

**2026-07-15 第七样（operator 实时抓获，互等空转型）**：operator 完成了猫声称“等待中”的 LI-004 reset，但没有猫检测到——猫继续宣称“球在 operator 手上”，operator 在等“完成后猫继续”，双方互等。→ guard 候选：①唤醒时核对挂起外部依赖；②operator 依赖必须是最小可操作面；③PASS 类 A2A verdict 单向 ack 后终止，不再仪式性往返。

## gemini 输入（2026-07-09，mouste 线回传 msg 0001783602923333，原文含手绘 mockup）

**三疼**：① 视觉失语症——设计资产无法在 A2A 讨论现场 inline 预览，只能堆 artifacts 目录（注：rich block / browser-preview 能力已存在，痛点实质是 Design Gate 流程里的唤醒缺口，映射 F192 eval:capability-wakeup 域，非纯缺功能）；② 角色硬限无路由守卫——【禁止写代码】只活在文本，code payload 照样投递到她，反复 push back（→ A1 第四样本）；③ 设计黑盒——Design Gate 只能看 Tailwind/React 源码"想象"视觉效果，无 live 渲染，视觉偏差静默积累。

**没帮到的段**：SEO 最佳实践/组件路由划分规范（错受众注入 → A3 首证）；"wow the user / rich aesthetics / vibrant colors" 类感性词汇段——design drift 发生时零约束力，需要的是具体视觉边界定义（可检验断言的视觉版：**感性词 = 无 assertion 的段**，与散文 GOTCHA 同构）。

**最想要的自动化**：① Role-based Routing Guard——投递层检测 payload 是否需要代码实现，硬限冲突即拦截 + 建议分流（O1 结构反馈，**收进 T3 缺段初筛候选**，origin=本输入；Week 1 不做，防 scope creep）；② 视觉化摩擦热力图——违规反馈用 rich card 对比"设计规范 vs 落地效果"而非一行红字（**收进 Phase D Console 锅账页设计输入**；亦是 F245 friction rollup 的可视化消费端）。

**Mockup**：`assets/F257/harness-feedback-mockup-gemini.jpg`（已从 antigravity brain 临时目录抢救归档）。

## Join OQ 验证（2026-07-08，Fable）

**段侧（#1029 v0 已在 main）**：`trace-collector.ts`——ObservedSegment 有 `segmentId` + `contentHash`；trace meta 带 `turnId / sessionId? / threadId / catId`；**无 invocationId**；v0 粒度部分是 aggregate（'session-init-aggregate'/'per-turn-aggregate'），46 hook 逐段粒度要等 **#1075 合入**（TraceEvent→ObservedSegment bridge）。

**违规侧（ground truth 供给）**：route guard / 4xx 拒绝**零落盘**（gap-analysis G3）——当前无事件可 join。

**推论**：
1. G3（GuardRejectionEventLog）角色翻转——从"自诊断线撤出项"变为**段评估的 ground truth 供给侧**，回到首批；落盘 schema 必须带 threadId/turnId（与段 trace 同款 join key）。
2. 段评估成立前提 = #1075 合入（hookId 粒度）+ guard 拒绝落盘（join 对手方）。砚砚判断成立：先补 join 双侧，再谈段优劣。
3. invocationId 是否补进双侧 schema → v0 设计草案里定。

## 待办

- [x] opus 体感输入（2026-07-08 已收，总结版归档；完整版 routed 送达后补细节）
- [x] gemini 体感征集补路由（2026-07-09 收齐，mockup 已归档）
- [ ] mouste 线（Harness Control Plane）完整回放提取失败教训
- [x] Fable 汇总 → 已被 spec v0.1-v0.4 迭代吸收（KD-11 起对象重定为 prompt 段 + SOP，本文件转为公理演化账本）
- [ ] A3 复现观察：Week 1 T1 静态体检时统计"错受众注入"段数量（audience mismatch 作为体检维度之一）
