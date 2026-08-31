---
feature_ids: [F257]
topics: [harness, prompt-segments, eval, self-evolution, design-draft]
doc_kind: design
created: 2026-07-08
---

# 段 Harness v0 设计草案（首个试验品：prompt 段 + SOP）

> 输入：capability-gap-analysis.md（基建盘点+方向重定）、harness-body-inputs.md（三猫体感+A1 公理+join 验证）、seed-cases SC-001~005、co-creator 约束（事件驱动/不轮询/不自动改段/approve 边界）。
> 状态：**draft-v0.4**（v0.4 = tracing 关联模型修正 + stage-adjust 维度 + override store 必做 + dogfood 验收路径）；v0.3——v0.1 = codex 落地 review（4P1+6P2+3 残留）修入 + spec 对齐；v0.2 = 迭代面 override-first 重写（KD-12）；v0.3 = **开发前五问深化**（§9：tracing 双侧最小充分集 / 三档事件触发 / 净价值指标 / 三层判定+停止条件 / 消融优先的三种改法）。架构定调：#1075 = 基础层，F257 = 其上的 auto harness 层。待 co-creator 对齐开工。

## 0. 一句话定义

对全量 prompt 段（含 SOP 段；口径双轨见 §6——pre-#1075 = 50 template id，post-#1075 = 46 hook.yaml）建立**只读评估 → evidence-backed candidate → 分通道迭代 → 版本差分验证**的事件驱动闭环，回答"哪些段多余 / 内容不合理 / 缺什么段"，并让每次修补的效果可测。

**v0 不做**：自动改段（防 prompt 自我繁殖）、skill（deferred，overlay 共识已记录）、全量锅账 backfill、新 eval 机制（全复用 F192）。

## 1. 运转模型：四层频率，零轮询

| 层 | 触发方式 | 频率 | 动作 |
|----|---------|------|------|
| 信号 | **事件驱动**（拒绝/注入发生即 append） | 随时·被动 | 段注入 trace 落盘（已有）+ guard 拒绝落盘（新） |
| 归因 | **阈值触发**（默认 3 次/7d，per-guard/ledger 可配置覆盖） | 事件累积 | 自动开归因 task，附 evidence 包（拒绝序列 + 当时注入的段 + correlation trace） |
| 评估 | **低频批**（复用 eval cron） | weekly | `eval:harness-ledger` 域（sourceRefs selector `{scope: 'prompt-segments'}`，**不新增域名**，避免撞域）产 verdict + candidate 报告 |
| 治理 | **报告驱动**（operator 看到 candidate 才动） | 无固定周期 | approve 结构升级 / 批退役 / intentional-keep |

> 这直接回答"基于事件具体怎么设计"：信号被动记，归因攒够才动，评估搭已有周车，治理跟着报告走。任何一层都不主动打扰任何人。

## 2. 数据面

### 2.1 correlation 模型（v0.1 重写，codex P1-2）

**事实前提（codex 核码）**：`turnId` 是 route-serial 在猫启动前生成的 random UUID；`ownInvocationId` 要等 stream `invocation_created` 到达后才捕获；hold_ball route 有 callback-auth invocationId 但 trace 侧无桥；A2A route guard 在 generator 内部（非 HTTP 通道）。→ **精确三元组 join 当前不可得，"小改"表述作废**。

两档 correlation：
- **Week 1 默认（半精确）**：`threadId + catId + timestamp window + guardId`，事件带 `correlationConfidence: 'window'`——T2a 差分在窗口置信度上就能算（版本前后违规率对比不需要逐 turn 精确归属）
- **后续增强（精确）**：trace summary 持久化 invocationId 或建 `traceTurnId ↔ invocationId` bridge；guard event 统一带可用 invocationId；confidence 升 `'exact'`。作为独立小工作项，不阻塞 Week 1

段侧粒度（**2026-07-09 合入后重验**）：#1075 已合入 main（`ebffcd8e5`），46 hook.yaml 就位，**段口径正式切换为 hook manifest（46）**。但重验证实 codex 预判：合入版 route-serial 仍 `drainCapturedTraces()`（L698/804/893），持久化仍走 v0 `collectTrace`（L879）——**逐 hook TraceEvent 已生成但被丢弃**。粒度从 aggregate 升逐段还差一个「trace 持久化桥」工作项（把 drain 掉的 TraceEvent[] 接入持久化），归属随 PR3 一并与 F237 线对齐（KD-13）。Week 1 设计不受影响（窗口 correlation + aggregate 本就够 T2a）。

### 2.1b GuardRejectionEventLog（v0.1 重写，codex P1-3）

**接口先于存储**：`append(event)` + `queryWindow({since, until, guardId?, threadId?, catId?})`。归因阈值和 weekly eval 都是窗口扫描——F254 的 per-invocation LIST 形态**不可发现**（不知道扫哪些 invocation），不照抄。

存储：global ZSET by timestamp（index）+ detail key；raw payload 不落盘（只存 normalized 字段 + anchor 引用）；**fail-open**——观测层故障绝不阻塞业务调用。

事件 union 按来源分型（codex P1-4，"4 处各加几行"表述作废）：

| 事件类型 | 实例 | emit 位置 | 测试方式 | Week 1 |
|---------|------|----------|---------|--------|
| `http_schema_reject` | waitSourceRef 400 | HTTP route handler | route 单测 | 后续 |
| `http_policy_reject` | gate-keeping 400 | HTTP route handler | route 单测 | 后续 |
| `http_rate_limit` | hold_ball 429 | HTTP route handler | route 单测 | ✅ |
| `publish_policy_reject` | publish_verdict 403 | eval-hub route（HandlerError → reply.status） | route 单测 | 后续 |
| `route_decision_skip` | A2A guard skip | route-serial generator 内 `continue` | generator 集成测试 | 后续 |
| `route_decision_block` | block_pingpong | generator yield system_info | generator 集成测试 | ✅ |

Week 1 Line B 只上 2 类（`http_rate_limit` + `route_decision_block`）：一个 HTTP 面一个 generator 面，把两种工程面的 emit 通道都走通，其余 4 类扩面是机械推广。route guard 类**单独估算工作量**，不按"微改"计。

第三 ground truth 源：eval:sop 的 violation 产出（已有，KD-8 边界维持——SOP 段的行为证据委托 eval:sop，不重建）。

### 2.2 留存

热层 7d（Redis，与既有 log 一致）→ weekly eval 拉取时聚合快照进 verdict bundle（git，永久）——借 F237 summary/detail 双层思路，解决 30d 窗口问题且零新存储系统。

## 3. 评估面：三层判定（按成本升序）

| 层 | 判定 | 需要什么 | 何时可跑 |
|----|------|---------|---------|
| **T1 静态** | ①跨层冗余：O2 段断言已被 O1 结构承载（星星罐子型）②段间矛盾：同 context 反向断言（规则不 compose 型）③语义撞词：拉闸词与技术名词冲突（脚手架型） | 只需段内容 + 结构 guard 清单 | **day-0**（全量段一轮体检，口径见 §6） |
| **T2a 差分·自动** | guard ground truth：段 fired 且对应违规仍发生 → low-evidence；版本切换前后违规率对比（窗口置信度即可算） | correlation 双侧事件（§2.1） | Line B 落地后 |
| **T2b 差分·半自动** | provenance / truth-source drift 类：ground truth 由 eval/review 标注（无结构 guard 可依） | 标注流程 | 与 T2a 同期，吞吐更低 |
| **T3 缺段** | 同类纠正/摩擦反复出现但无段承载 | Week 1 用 friction rollup 现有产物半自动初筛；正式第五 source adapter（含 FrictionChannel union/composition/tests 扩展）**放 Phase B 不压 Week 1** | day-0 可半自动 |

**核心指标 = 行为差分，不是注入率**（公理 A1，三猫三模型实证）。

### verdict 词表（段专用 v0）

`alive` / `redundant-candidate(cross-layer | duplicate)` / `conflict` / `false-positive-noise` / `low-evidence` / `missing-segment` / `superseded`（LL-071 型：被结构替代，光荣退役）/ `unmeasurable(+observabilityDeadline)`。通用锅账词表（spec 既有）在泛化阶段合并。

## 4. 迭代面（v0.2 重写——override-first，co-creator 2026-07-08 12:32 迭代模型）

> **v0.1 的"段文本迭代走 git PR"通道被否，理由成立**：①改了不知道有没有效，未验证的改动不能直接固化为基线；②可能只需 rollback / 启禁用，PR 通道太重且慢；③安装包用户无法改随包分发文件，该通道只对源码开发者存在。**试验在 override 层，基线沉淀要证据。**

**迭代生命周期**（段/skill 类资产统一模型）：

```
tracing（持续，永不撤）
  → eval 发现问题（candidate 报告）
  → override 层改动（禁用 / 内容调整——不动 base 文件）
  → 效果确认（contentHash/override 版本差分，下一 eval 周期自动产出）
  → 继续迭代（可随时 rollback = 撤销 override）
  → eval 进入相对稳定波动 → 停止改进（tracing + eval 保留）
  → 迭代记录 + 证据链在手
  → 基线沉淀：源码环境 → 上游 PR 入库；安装包用户 → 主动触发提 issue（附迭代证据）
```

**三类对象三种通道**（co-creator 分类）：

| 对象 | 通道 | 迭代层前提 |
|------|------|-----------|
| 代码功能问题 | 收集 → 归因 → issue（蓝色通道）；源码环境可改，安装包用户提 issue 即止 | 无（现有流程） |
| 段（prompt hooks） | override 迭代（启禁用/调整）→ eval 稳定 → 带证据入库 | **`HookOverrideStore`（#1075 PR3）** |
| skill | 同段模型（overlay：base 随包不可变 + overlay 迭代 + 版本自见），deferred | 段走通后复用同基建 |

**operator gate 位置**：O2→O1 结构升级与段退役仍走 approve（硬边界不变）；override 试验本身低风险可逆（随时撤销），其审批粒度（逐个 approve vs 批量授权试验窗口）→ Design Gate 补充对齐。

**依赖关系修正（取代 v0.1 表述）**：
- **观测 + 评估**（线 A / 线 B / weekly eval / candidate 报告）：不依赖 #1075——tracing 和 eval 是永久基建，先行建设，这部分本来就"要保留"
- **迭代环（override 试验）：以 #1075 + PR3 `HookOverrideStore` 为前提**——"要基于 1075"的准确含义。PR3 目前尚未存在（F237 Phase 2 的 deferred scope），需与 F237 线对齐：PR3 优先级提升 or F257 承接实现
- override 层就绪前：评估只产 candidate 报告（只读），**不动任何段**

**账本伴生**：每次 override 试验与基线沉淀登记 ledger YAML（spec 既有 schema），registry 从真实迭代里长出来（KD-10 不变）。

## 5. 首批评估对象（有 ground truth 的段先评）

1. **路由/传球出口段** — ground truth: route guard 拒绝（GuardRejectionEventLog 首批覆盖）
2. **provenance/source 段** — ground truth: SC-002/#1075 型事件（v0 承认半自动：review 发现人工标注）
3. **truth-source 写回段** — ground truth: seed cases + spec diff 检查

phase-boundary drift 检查卡（砚砚最想要，一卡拦 SC-002/003/004）：**第二批**——主线闭环走通后做，实现是 lint/checklist 级，其判据已被 seed cases 固化，不会丢。

## 6. 开工顺序（"怎么继续"）

**Week 1 双线并行**：
- **线 A（第一个可交付，零新基建）**：T1 静态体检 + T3 缺段初筛 → **第一份 candidate 报告**给 operator。**段口径 source-of-truth（codex P2-4）**：pre-#1075 按 current template registry（**50 个 template id，含 D7/D15 变体**；how_counted: `TEMPLATE_FILES` 常量计数 @ 当前分支）；#1075 合入后切 hook manifest 口径（46 hook.yaml @ PR diff）。两口径差异在报告中显式声明
- **线 B（基建）**：GuardRejectionEventLog（queryWindow 接口 + ZSET 索引）+ **2 类事件 emit**（`http_rate_limit` + `route_decision_block`，一 HTTP 面一 generator 面）→ codex review。精确 correlation bridge 为独立后续项

**Week 2+**：`eval:harness-ledger` 域注册（selector `{scope: 'prompt-segments'}`，weekly）→ T2a 差分进周期 → candidate 报告持续产出 → 其余 4 类事件扩面 → drift 检查卡。

**迭代环开动条件（v0.2）**：override 层就绪（#1075 + PR3 `HookOverrideStore`）。就绪前评估只读不动段；PR3 的归属与优先级与 F237 线对齐，作为开工后并行协调事项，不阻塞观测评估建设。

**v0.4 升级（2026-07-09 co-creator 拍板）**：`HookOverrideStore` 从"前提"升为**必做项、优先级提前**——"否则没法做 auto harness"；直改段原文除未验证固化外还有两个问题：与上游数据不一致 + 同步代码冲突。

**验收路径（co-creator 定调，取代泛化时间线）**：
```
改动 → 合入本地集成分支 → co-creator 真实开发使用（dogfood）
→ 自动发现问题 + 优化通知 + 审批 → 审批后迭代
→ 至少 2~3 轮自动优化迭代 → 实证「自动生效 + 优化有效」
→ 带自动迭代证据链往上游提 PR（证明可推广）
→ 而后才扩展其他 harness unit（基础功能 / MCP / skill）
```
段是第一个 harness unit；上游 PR 的说服力 = 我们自己家 2-3 轮迭代的证据链。触发入口形态开放（skill 只是候选之一，不锁定）。

**F237 scope 综合（进行中）**：F237 下阶段 = 段的完整评估处理（不止 Console UI）；F257 向其输送审计证据 / A1 公理 / 判定设计 / 收敛模型，分工沟通中（见工作 thread）。

**里程碑判据**（对齐 AC-A0 精神）：≥1 个段完成完整五环（评估 candidate → approve → 修补 → 版本差分显示违规下降 or 证伪）。走不通 = 设计证伪，停下重议，沉没成本 = 一个 event log + 一份静态报告。

## 7. 改动范围

| 改动 | 位置 | 量级 |
|------|------|------|
| GuardRejectionEventLog | packages/api 新文件（queryWindow + ZSET 索引，**非** F254 LIST 形态） | ~200 行 + 测试 |
| Week 1 emit ×2 | `http_rate_limit`（HTTP route，route 单测）+ `route_decision_block`（generator，集成测试） | 两种工程面各一，**route guard 类单独估算** |
| 其余 4 类 emit 扩面 | 见 §2.1b 分型表 | Week 2+，机械推广 |
| 精确 correlation bridge | trace summary 持久化 invocationId 或 traceTurnId↔invocationId 桥 | 独立后续项，不阻塞 Week 1 |
| eval 域 selector | eval:harness-ledger 域配置加 `{scope: 'prompt-segments'}`（不新增域名） | 配置 |
| T1 静态体检 | 脚本 or eval cat 执行（不进运行时） | 只读 |
| **不碰** | 段内容本身（评估只读）、eval 机制、运行时主链路行为、skill | — |

## 8. 体系自身防腐

- seed-cases 持续记录本体系开发偏差（自举条款不变）
- sunset signal：`eval:harness-ledger` 的 prompt-segments scope 连续 4 周期无 actionable verdict → scope 降频/并入 eval:friction（防第 131 口锅）
- 所有报告数字带 `how_counted`（SC-002 纪律）

## 9. 开发前五问（2026-07-08 co-creator gate，v0.3）

> "开发之前，你需要先好好想想：怎么 tracing / 怎么触发 / 怎么 eval / eval 什么 / 怎么改（启禁用段还是修改段内容）"。架构关系定调：#1075 是基础层，F257 是其上的 auto harness 层。

### 10.1 怎么 tracing —— 双侧最小充分集（v0.4 修正：关联模型）

> **2026-07-09 co-creator 修正**：console manifest API 只是静态清单/预览面，**不是评估数据源**——"直接根据 console 接口看到的来评估脱离实际"。评估需要**运行时关联数据**：
> - **turn 维度**：该 turn 注入的段列表 × 实际用户输入 × 实际结果（锚点引用 events.jsonl，不复制原文）
> - **session 维度**：session 级注入 + turn 索引聚合
>
> 这解锁一个此前缺失的评估维度——**注入频率/stage 优化**（正好映射 hook 的 S/D stage 结构）：
> - 某段每 turn 注入 → 数据显示 session 一次即可 → **降频**（省 token）
> - 某段 session 注入 → 多轮后注意力衰减（行为违规随 turn 深度上升）→ **升频到 turn**
>
> verdict 词表增补：`stage-adjust-candidate(session→turn | turn→session)`。

段的价值只能用行为差分证明（公理 A1），所以 tracing 必须**双侧**：
- **供给侧**（段进了没有）：hookId / 版本（base contentHash + **override 版本**）/ fired|skipped + skip 原因 / token 长度。来源：#1029 现有 + #1075 逐段增强 + override 层版本标注（PR3 就绪后）
- **效果侧**（行为变了没有）：结构化信号 = GuardRejectionEventLog（线 B）；非结构化信号 = eval/review 标注（T2b）
- 最小充分集 = `(段, 版本, 注入与否) × (违规类型, 时间)` 可按窗口 correlation join（§2.1）

### 10.2 怎么触发 —— 三档事件驱动（零轮询不变）

| 档 | 触发事件 | 动作 |
|----|---------|------|
| **变更驱动**（最密集） | 某段 override 变更（启禁用/调整）→ 该段进入观察期 | 观察期满（累积 N session 或 7d，取先到）自动触发**该段**差分评估 |
| **阈值驱动**（即时） | 同 guard 拒绝达阈值（per-guard 配置，默认 3/7d） | 即时归因评估**关联段**，不等周期 |
| **周期兜底**（全量） | weekly eval cron（已有基建） | 全段扫描，抓慢性病（dormant / 冗余 / 缺段） |

核心原则：**评估密度跟着变更走**——改了才密集评估，没改的段只被周期兜底扫到，不平摊评估资源。

### 10.3 eval 什么 —— 段的净价值 = 行为改善 − 注意力成本

每段五个指标：①成本 = 注入频率 × token 长度（全段 day-0 可算）②效果 = 关联违规率（有 guard ground truth 自动 / 无则 T2b 标注）③**差分 = override 变更前后关联违规率变化**（"改了有没有效"的直接答案）④关系 = 跨层冗余/矛盾/撞词（T1）⑤缺口 = 无段承载的重复纠正（T3）。

### 10.4 怎么 eval —— 三层判定 + 停止条件

T1 脚本判定（确定性，CI 可跑）/ T2a 窗口差分（统计——**初期样本量小，报告标注"方向性证据"，不冒充统计显著**）/ T2b predicate 抽样（借 eval:sop 的 predicate 形态给段 assertion 写判定）。汇总进 `eval:harness-ledger` weekly verdict。
**停止条件**（co-creator 模型）：段指标进入相对稳定波动 → 停止主动改进 → 转低频监控（**tracing 与 eval 永久保留**，不随改进停止而撤）。

### 10.5 怎么改 —— 消融优先，内容其次，条件第三

| 优先级 | 改法 | 适用 | 为什么 |
|--------|------|------|--------|
| 1 | **启禁用（消融试验）** | 疑似冗余 / low-evidence 段 | **单变量因果验证最干净**：禁用只改"存在与否"一个变量。违规率升 = 段有用，一键恢复（撤 override）；无变化 = retire 的证据基础（base 删除仍走 operator approve）。禁用是 retire 的前置实验 |
| 2 | **内容调整** | 确认有用但效果差的段（fired 了违规照发——段在场没起作用） | 变量多（措辞/长度/结构），验证靠 override 版本差分；初期只做**单变量修改**（如高违规段的措辞强化），不重写 |
| 3 | **fire 条件调整** | 全场景注入但只在部分场景相关的段 | 改 resolver 注入条件不改内容——降低无关场景的注意力稀释（#1075 resolver 纯函数天然支持 override） |

顺序逻辑：**先禁用验证存在价值 → 再内容优化有价值的段 → 后条件收窄注入面**。三种改法全部发生在 override 层（KD-12），全部可即时 rollback。

### 9.6 执行模型四答（2026-07-09 co-creator 追问）

**Q1 tracing 数据放哪**：三层——热层 Redis（注入 trace：InjectionTraceStore 族，summary 永久 + detail 7d；guard/反馈事件：GuardRejectionEventLog ZSET 时间索引，7d）→ 冷层 git（weekly eval 拉取聚合快照进 `docs/harness-feedback/bundles/`，永久可复算）→ 关联锚点引用 events.jsonl（不复制输入输出原文）。

**Q2 eval 谁做/哪做/纠正怎么进评估**：执行者 = `eval:harness-ledger` 域的 **eval cat**（F192 现成机制：域配 evalCat + system thread，cron/触发唤醒）——**不是开发 thread 里的猫**。链路：thread A 纠正发生 → 被纠正猫上报结构化反馈事件（关联段猜测 + threadId + ts）→ 事件**积累不立即评估**（单次纠正样本不足）→ 阈值命中（同段关联事件攒够）调度该段即时评估 / weekly 兜底全扫。**评估按段不按 thread**：eval cat 拉全局段数据，thread A/B 的事件天然汇入同一段的时间线。

**Q3 指标规则放哪/和段一起管理吗/怎么迭代/首版**：
- schema（类型）：`packages/shared/src/types/harness-judgment.ts`（纯契约）
- **段判定实例：`assets/prompt-hooks/<hook>/judgment.yaml`——与段同域共管**（改段时判定就在旁边）
- 评估引擎：`packages/api/src/infrastructure/harness-eval/harness-ledger/`（与 sop evaluator 同层）
- 全局参数（ε/K/阈值默认）：eval 域 YAML
- 迭代：指标版本化，verdict 带指标版本；**operator suppress 率高 = 指标不合适信号** → 修订队列；指标改动走 git PR（可在历史数据上回放对比验证）
- 首版：手写——首批 3 类段（路由/provenance/写回）判定实例源自 30 天审计 + 三猫体感 + seed cases；T1 规则即 opus 三增量；其余段先只有成本指标，效果指标标 unmeasurable 渐进补

**Q4 审批-修改链 + 拒绝反馈环 + 允许静默（三条新决策）**：
- 通知 → 你确认 → **自动调 override 接口** = 代码行为，**端到端一次做完、无 followup 无过渡态**（2026-07-09 co-creator 纠正："人工执行过渡"撤销）——审批执行器是正式 scope 的一部分，与 PR3 override API 在 Week 2 联调期同步接通；**dogfood 进入条件 = 全链路（tracing→触发→eval→verdict→审批→自动执行→差分）代码化跑通**，dogfood 阶段 operator 只做一个动作：点确认/拒绝
- **拒绝也是数据**：suppress/reject 落结构化事件 `{verdictId, segmentId, rejectReason, ts}` 进同一时间线；下一轮评估该段时，**历史被拒方案 + 拒因是评估器输入**——不重复提被否建议，或针对拒因给新方案（评估器有记忆）
- **允许不产生通知（防过拟合铁则）**：合法 verdict 含 `insufficient-data`（数据不足静默继续积累）与 `no-action-needed`（段无实质影响跳过）——**不进审批通知，静默记录**。不为评估而评估。

## 10. 与理想态的差距（诚实声明）

- 五环全自动是 north star；v0 的归因半自动（阈值开 task，归因本身靠猫）、修补全人工（approve 通道）
- Week 1 correlation 是窗口置信度（`correlationConfidence: 'window'`），精确 join 是后续增强；T2a 差分在窗口置信度上成立
- 段粒度 aggregate → 逐段依赖 #1075 实际合入形态，**以合入后 AC/code 为准重验，不预设**
- T2b（provenance / truth-source drift）ground truth 半自动（eval/review 标注）
- 时间尺度：修补验证以 weekly 周期为单位，闭环证明 ≥2-3 周
