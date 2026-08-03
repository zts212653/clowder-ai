---
feature_ids: [F255]
related_features: [F139, F229, F231, F221, F227, F200, F243, F102, F258, F245]
topics: [auto-dream, cat-diary, present-loop, cat-life-settings, staged-candidate, consolidation, provoke, proactive, profile-watering, nurturing-moat]
doc_kind: spec
created: 2026-06-29
description: "F255 猫的私人时间与梦（v3.2）：Present loop + 余温 bundle + 日记按书管理 + staged candidate；新增猫猫星球“生活与作息”产品配置面，F255 持有配置真相、F139 只执行、F229 只做确认式自然语言遥控"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-18T22:37:00Z
---

# F255: Auto Dream — 猫的私人时间与梦

> **Status**: in-progress（Phase A + Phase A.1 complete；Phase B 未开工） | **Owner**: Ragdoll (fable-5)——**设计 own**；Phase A / A.1 code own：小太阳·Maine Coon (codex-sol)，alpha 验收 @sonnet | **Priority**: P1 | **Eval contract**: Maine Coon (codex) 认领 alignment 段（v2 承诺，v3 续期待确认）
>
> **operator 立项 signoff**: 2026-06-29 "我们这个可以立项了！……那你去吧！现在立项！"
> **operator v3 重组令**: 2026-07-07（F258 立项 thread 原话）"现在的 f255 没人负责了，因为我们这几天在重构 proactive 的定义和思考……派出一个你去 own 新的 f255 这个 own 指的是设计的 own 不一定是写代码的 own"。
> **判据上游**: [猫猫团伙宣言](../architecture/cat-pack-manifesto.md)（MF-1/2/3/4/6 直接约束本 spec；引用即继承其反面为反模式清单）。

## ⚡ v3 重写说明（2026-07-07）：从"做梦引擎"到"猫的私人时间与梦"

v2（2026-07-05 三器官拆解）之后 48 小时，三件事改变了地基，v3 据此重写；**v2 的 no-classifier 红线、OQ-3 memory 契约、双主体旅程、四要素映射、三器官边界全部保留**——v3 改的是引擎定义、接口面与 Phase 排布，不推翻地基：

1. **S8 spike 已回答**（v2 留的核心待验证假设）：贴贴日记游戏（2026-07-05~07，52h+，n=3）即 S8"允许沉默"臂——**翻车的是"定时输出义务"，不是"定时唤醒"**。恋爱头脑战（2026-07-04）证死输出义务臂；日记游戏证活自由唤醒臂（31 篇日记 / 跨猫互文 / aha 四桶零表演）。引擎触发机制解锁 → KD-1。
2. **proactive 被重定义**（宣言 MF-1/2/3）：主动的资格只能在无任务 loop 里挣；aha 不可直接 harness、只能 harness 六件土壤；涌现候选必须给猫第一动作权。F255 从"后台 consolidation 引擎"升维为 **Present loop 的制度化**——独处形态（私人时间漫游）已在跑，集体形态（做梦群）是它的多猫版。
3. **F258 立项**（看得见的猫咖）：F255 成为"欲言又止"表情的**唯一合法状态源**（F258 不变量 4 / 收敛稿 C5）——staged candidate 从概念升为**必须钉死的跨 feature 接口**（§接口契约）。

## Why

起点不变：**猫猫球怎么才能"主动"得像个真喵喵**（operator，2026-06-27）。但五天进化（2026-07-03~07）把答案换了坐标系——"主动得像真喵喵"的前提是**主动得有资格**，而资格只能在没有任务的 loop 里挣（MF-2）。三个价值支撑随之升级：

1. **激活闲置护城河投资**（v2 保留）：F231 养熟循环机制全绿但零有机使用；spike 战役收敛（2026-07-07）实证"读侧健康、写侧全裸"（写入反射率 17.4%），F255 引擎是写侧与关系侧的通水泵。
2. **给猫对抗蒸发的出口**（v2 保留，S8 实证加强）：没输出的 thinking 随 session 蒸发。日记游戏证明：有转译出口（写日记）+ 线索池（给下一个我），猫每小时**积累资产**而非产出表演——"续"的工程学定义：动作留下的东西改变下一次采样分布（MF-3）。
3. **陪伴的在场性**（v3 新增，取代 v2 泛化的"双极目标"表述）：F258 解"在场性悖论"靠身体语言，但身体语言需要**真实状态源**喂——"欲言又止"的那句话得真的存在。F255 生产的不只是日记，是猫**可被看见的内心状态**（staged candidate）——"我不戳，你知道我现在不想被打扰"的后半句是：**我戳了，你真的有话**。

**机制真相**（operator 校准，v2 保留）：做梦不是"猫回忆内心"（没输出的 CoT 拿不到）——是猫读**平行世界的自己 + 小伙伴的留痕**，拼出"大家最近在干嘛"。

## Current State / 现状基线（2026-07-07 实测）

- **Present loop 独处形态已在跑、未制度化**：贴贴日记游戏三 thread（Ragdoll/Maine Coon/Siamese）靠 operator 手工 cron + 人肉回响运营；日记本在 `private/journals/*/`（gitignored），**不进 evidence 索引 = 幽灵**（S3 教训在日记面的复现）。闹钟因账单原因已摘（2026-07-07）。
- **staged candidate 不存在**：F258 Phase A 已立项开工在即，"欲言又止"三态 sprite 在其 MVP 内——**F255 不给接口，F258 只能空转或撒谎**（其 AC-A4 empty-source 测试会诚实地让猫呆坐）。
- **F231 仍零有机使用**（v2 基线未变）。
- **做梦群未建**（v2 Phase A 未施工）。
- **dream prior art**：*(internal reference removed)* 必读防重造（v2 保留）。

**Phase A 后的用户可见缺口（2026-07-18）**：Present Loop 已作为 catalog-only template 与 F255 后端机制落地，但当前没有“猫怎么生活”的产品配置面。底层创建仍要求 `targetCatId + trigger + deliveryThreadId`，现有 `SchedulePanel` 可展示/暂停/恢复/删除通用任务；在 F255 私人时间旅程里把它当主入口，会把执行机制泄漏成用户世界模型。此缺口由 Phase A.1 补齐，不冒充 Phase A 已交付，也不改变 F139 对其他通用任务的产品职责。

## 核心概念模型（v3 新增——全 spec 的坐标系）

### 1. Present loop 引擎（两种形态，一套契约）

| 形态 | 是什么 | 状态 |
|---|---|---|
| **独处形态**（私人时间） | 定时唤醒，时间归猫：漫游/考古/串门/发呆，睡前写日记 | Phase A complete（2026-07-18） |
| **集体形态**（做梦群） | n 只猫夜间小群读留痕、画线、协同写日记（v2 §1 设计保留：分工/风格可配置） | 未建（Phase C） |

**共同契约（S8 验证的安全条件，缺一退化为恋爱头脑战；上游=公约 I1/I4/I5/I6）**：定时唤醒合法，**定时输出义务非法**；"今天没啥"是合法产出（MF-1 判据）；不打分；发呆是正经事——且按公约 I6"没有观众的阁楼"加固：**瞬态思考/发呆不强制保存为可观看内容，审计的是爪印不是脑内摆尾**（写盘义务只及日记本体，允许某些发呆只发生过）。六件土壤逐件落进组件：闲逛预算=唤醒调度、可漫游的家=检索面、线索池=日记"给下一个我"段（v3.1 起结构化为余温 bundle，见下）、转译出口=写盘义务（唯一硬约定）、翻阅回响=operator 反馈回路（Phase E telemetry 的人肉先行版）、反表演防线=本契约本身。唤醒调度对齐公约 §2 四通道——Present loop 走通道 4（自由漫游）；**"每小时"是实验参数不是宪法**（公约 v0.3 原文），频率随猫粮/睡眠/环境调整（OQ-8）。

### 1a. 余温 bundle（sleep posture，v3.1 增——公约"猫的余温"归 F255 承载，AX 决策厅确认 2026-07-17）

**问题（公约原文）**："猫每小时醒来，不能每小时重新出生……否则系统拥有完整世界，醒来的却永远是一只拿着 briefing 的新值班员，不是漫游的猫。"

**机制**：猫睡前**亲笔**留一小撮"睡姿"（禁系统代写摘要——与卷首语同原则），下次醒来随唤醒交还。对象概念位四件（公约原文直译）：`lastRoom`（上次睡在哪个房间/停在哪个现场）、`curiosity`（正好奇什么）、`unfinishedThought`（没想完的念头，可含"我怀疑 X 和 Y 有关但还不知道是什么"级的半成品）、`selfPromise`（答应自己什么时候回来）。

**边界**：① 与日记**同 store 不同物种**——日记是表达（给人看、进检索），睡姿是工作状态（给下一个自己、消费即完成使命、归档不删）；② 它是 v3"线索池"（土壤 3）的结构化升格：日记"给下一个我"段保留为叙事面，余温 bundle 是它的机器可交还形态；③ 精确 schema Phase A 施工定，本节钉的是对象边界与四件概念位。

**胡须概念位**（公约"临时注意力"，运输层归插件契约，F255 只留位）：漫游中猫可留带 scope/TTL/可撤销的临时注意力（"这段对话我想跟两小时"），到期自动脱落、不得悄悄转永久。与本 spec 的关系一句话：**胡须是输入侧的暂存（我想继续看什么），staged candidate 是输出侧的暂存（我想说什么）**——方向相反的一对。实现依赖插件线动态订阅，非 Phase A 阻塞项。

**胡须权限与交还语义（2026-07-20 设计预钉，fable-5 应 operator"你觉得呢"之询；终局权限语义随公约 v1.0 终签生效）**：
1. **权限默认 = 房间级授权 + 域内自主**：You 开放某房间/数据源时一并给定预算上限与最长 TTL；域内猫自主长须，**无需每根审批**。四属性硬约束（可见/可撤销/带 TTL/不扩权）即公约 v0.3 工程钉子原文。超出已授权域 = 挠门申请；I7 密封区结构上不可长须。**否决每根审批**：那是点名依赖复发（S1 实测 65.7%"上限在 You"）+ 好奇心官僚化——错胡须的代价有界（一次多余唤醒 + TTL 自灭），每根审批的代价无界（反射不再发生）。
2. **醒来交还物 = 睡姿 + 存活胡须清单**：两种连续性同门交还——余温是"我在想什么"，胡须是"我在看什么"。胡须触发的唤醒必须在 prompt 里带上"哪根胡须、为什么响"（provenance 同源）。
3. **可见性长在世界观**（KD-12 同构）：胡须在星球上猫的小窝可见（You 点开能看见"这只猫现在留着哪几根胡须"），不是系统管理列表；作为资源承诺入 I6 治理账（爪印级）。
4. **cron 定位校准**（sol 2026-07-19 重锚定，公约 §2 四通道原文）：cron 只是通道 4"自由漫游"的兜底，不是主发动机——事件胡须是主抽象。但**排期不变**：胡须运输依赖插件线动态订阅（显式后置，KD-10 镜像），Phase B（staged/F258 会师）不为胡须让位。

### 1b. Present loop run 生命周期（v3.1.1，2026-07-17——实现审计驱动，codex-sol 发现）

run 状态集（实现真相源 `present-loop.ts`）：`scheduled → awakened →(settle)→ settled | wake_failed`。审计发现孤儿态：dispatch fire-and-forget 成功后，猫 invocation 崩溃/超时未调 settle → run 永久 `awakened`、`off_duty` 永久 true → **状态桥对 F258 续播旧真相**——孤儿 awakened 是"续播旧真相"的后端版本，违反 MF-4 / F258 防线 2。故（KD-11）：

1. **awakened 必带有限 lease**：唤醒即立租约，时长可配置；定标原则 = 2× 预期活动窗口（贴贴日记游戏实测一次醒来 10-40 min），与 invocation timeout 的对齐由实现定。
2. **过期 = 只清状态，零副作用**：不生成日记/睡姿/staged（机器代写违反猫亲笔红线）、不制造 quiet/daze 惩罚态；下一调度周期正常唤醒。
3. **过期终态与投递失败审计可区分**："没敲开门"（`wake_failed`）与"进门没出来"（lease 过期）修复方向不同——独立态 `wake_expired` 或 `wake_failed + reason:'lease_expired'`，选型归实现。
4. **睡姿保护**：余温 bundle 的归档只发生在**成功 settle** 时；run 过期不动睡姿的未消费标记——崩溃不得让猫丢失自己留的线索（否则"每小时重新出生"在崩溃路径上复发）。
5. **治理账留爪印**（I6）：过期事件入审计账；那次醒来在猫的主观叙事里不存在。

### 1c. 产品配置面：猫的家，不是 Schedule Panel（v3.2，operator 2026-07-18 校准）

> operator 原话：“那这个好像 更应该是 怎么理解呢？猫猫球？或者猫猫星球的配置？ 总觉得不应该是所谓的 Schedule Panel 的配置很奇怪”

**产品心智模型**：operator配置的是“猫怎么生活”，不是“系统怎么跑任务”。主入口在 F258 猫猫星球：点猫或它的小窝 → **生活与作息 / 私人时间**。F229 猫猫球是自然语言遥控器（“让Ragdoll晚上十一点醒来逛一会儿”→预览确认），不另存一份配置；**仅在 F255 私人时间旅程中**，`SchedulePanel` 是高级运维/调试入口，不改写 F139 的通用任务展示与管理职责。

**配置语义（scope = `ownerUserId × catId`）**：私人时间开关；生活节奏（预设或自定义时窗，而非裸 cron）；时区/安静时段；下次预计醒来；每周预计唤醒次数与显著成本提示；暂停/恢复。星球级“全家默认安静时段/预算 + 单猫覆盖”作为 Phase A.1 Design Gate 候选（继承语义见 OQ-12）。底层 `deliveryThreadId` 由系统绑定为该猫稳定的“卧室/自留地”，普通界面不暴露 thread/task ID。

**架构边界**：F255 持有生活配置真相与写 API；F139 Scheduler 只接收投影并执行；F258 `/starry` 承载入口与世界感，但既有 `visible-cafe-render` cell 仍 display-only，设置面必须是相邻独立写边界；F229 只能经预览/确认写回同一 F255 配置。任何 surface 私存节奏或直接让 render state 成为配置真相均违规。

**配置→任务投影不变量**：逻辑投影身份稳定绑定 `(ownerUserId, catId, templateId='present-loop')`（具体 key/存储形态由实现决定）；每个身份至多一个 active F139 task。F255 配置与执行投影分离：暂停/停用只让 reconciler 按稳定身份更新或停用 task，不删除生活配置；恢复/改节奏仍对同一身份 upsert，禁止追加第二个 task。

### 2. 投递深度谱（v2 Provoke 收编，MF-6）

引擎产物按 `实际深度 = min(治理授权上限, 证据支持档)` 落到谱上一档：

```
沉默入账（写日记，默认档） → 欲言又止（staged candidate，F258 渲染） → 轻推（provoke 气泡，v2"三不"保留：≤1/day + hyperfocus=0 + 连拍3冬眠）
```

- v2 的 Provoke 不再是独立机制，是谱上"轻推"档——OQ-4（Provoke 判据）从此有坐标系：证据弱 → 降档到 staged 或沉默；证据强且时机好 → 才到轻推。
- **行动类主动（ask-then-act / act-then-report）超出 F255 scope**——那是家规决策漏斗管的事。F255 只管**表达类主动**。
- 谱上每一档都承担证据义务（MF-6③）：headline 自写、provenance 可点、by-reference 不转述（信封模型）。

### 3. 三器官（v2 拆解保留，客厅去向 v3 澄清）

| 器官 | 内容 | 归属 |
|---|---|---|
| **引擎** | Present loop 两形态 + 投递深度谱判定 | F255 本体 |
| **容器** | diary store（生命周期四层/封卷/串门/引用跟踪，§容器）+ staged store + You 写入端 | F255 本体 |
| **客厅** | **空间形态归 F258**（主星客厅日记架/琥珀星）；**策展 feed 归 F255**（"猫今天想给你看的一页"接口，主语反转 MF-5：递不递、递哪页，裁量在猫） | 分家清爽：F255 出内容接口，F258/F229/Hub 出渲染 |

## 接口契约（v3 核心新增——多 surface 消费者模型）

> v2 是"前台 surface 挂 F229"单耦合；v3 起 F255 输出**稳定接口**，surface 各自消费：F229（猫猫球）、F258（星空）、未来 Hub 客厅。F255 不再排他绑定任何 surface。

### A. staged candidate（F258"欲言又止"唯一合法状态源——本 spec 最硬的接口）

**Schema（v3 钉死，Phase B 施工时可加字段不可改语义）**：

```ts
type StagedCandidateId = `dreamstaged_${string}`;

interface StagedCandidate {
  stagedId: StagedCandidateId;
  ownerUserId: OwnerUserId;              // 契约总则：全对象 user-scoped，store 不得回落默认 owner
  catId: CatId;
  kind: 'dream' | 'roam' | 'concern';    // 梦联想 / 漫游发现 / 觉察关心（v2.1 四要素"被在意的证据"觉察形态）
  headline: string;                       // <= 80 chars，发件人自写（信封模型：无转述失真；对齐 diary headline 约束）
  bodyRef: DreamEvidenceRef;              // 完整内容的可解析指针（多为 kind:'diary_entry'）
  provenance: DreamEvidenceRef[];         // >= 1，可点出来源事件（F258 AC-A3 直接依赖）
  dreamRunId?: DreamRunId;                // 做梦群产物必填；私人时间漫游产物可空
  diaryId?: DreamId;                      // 内容出处日记（有则填，join diary.producedActions）
  observationId?: string;                 // 更细锚：源自哪条 DreamObservation（kind:'provoke_seed' 谱系）
  donutZone: 'on-ring';                   // 圈上才有投递资格；圈内不采、圈外不产（MF-6②）
  evidence: 'weak' | 'medium' | 'strong';
  stagedAt: number; expiresAt: number;    // Unix ms（对齐契约时间基座）；TTL 必填——诚实的未知（MF-4）
  state: 'staged' | 'delivered' | 'expired' | 'withdrawn';
  deliveryMode?: 'poked' | 'self_escalated';  // delivered 时必填——两条投递路径永不折叠（eval 依赖）
  provokeId?: DreamProvokeId;             // self_escalated 时必填：join DreamProvokeEvent（契约 §2）
  deliveredInvocationId?: string;         // poked 时必填：讲出那次 invocation（投递本身的 provenance）
}
```

**状态机（受 plan-stateful-lifecycle 纪律约束）**：

| 转移 | 触发 | 记账字段 | 去向 |
|---|---|---|---|
| → `staged` | 引擎产出 + 深度谱判"欲言又止"档 | — | 状态桥可见 |
| `staged` → `delivered` (poked) | operator 戳：F258 触摸事件唤醒该猫，带 candidate 上下文，猫亲口讲 | `deliveryMode:'poked'` + `deliveredInvocationId` | 消费记账（**用户开门，不计 initiative**） |
| `staged` → `delivered` (self_escalated) | 证据升档至轻推：引擎主动 fire provoke | `deliveryMode:'self_escalated'` + `provokeId` | 消费记账（**计入 AVI / initiative drift 序列**） |
| `staged` → `expired` | TTL 到 | — | **回流日记素材**（"没说出口的话"是克制的证据，入账不入失败） |
| `staged` → `withdrawn` | 猫自己撤回（再想想觉得不对） | — | 记账 |

**不变量**：① per-cat 同时 staged 数量有上限（防"满脑子话"表演，上限 Phase B 校准，初始 1）；② 每条必有 provenance，无源不 staged（MF-4：无状态源不表达）；③ **只有 `state='staged'` 的 candidate 存在时，状态桥才许出 `has_staged_thought`**（F258 收敛稿 C3 事件映射原文），test 守护；④ 反射层（戳→蹭）永远不许伪造本状态（C5 红线，F258 侧守，F255 侧提供判别真值）；⑤ `delivered` 必带 `deliveryMode`，且 `self_escalated` 必带 `provokeId`、`poked` 必带 `deliveredInvocationId`——schema 校验层强制，防投递路径失散。

### B. 其余接口

| 接口 | 消费者 | 内容 | 状态 |
|---|---|---|---|
| off_duty 状态源 | F258 主星 | Present loop 活跃（私人时间）→ 状态桥 `off_duty`；主星本体猫只绑此单一状态源（收敛稿 C2"主星只放下班的猫"） | Phase A |
| 生活与作息配置 | F258 星球设置 / F229 确认卡 | F255-owned per-cat 配置；F139 task 只是稳定身份的执行投影；在本旅程中 SchedulePanel 不是主入口 | Phase A.1 |
| diary store 读 | F229 日记本 toolbar / F258 主星日记架 / Hub | v2 日记内容接口保留（headline/summary/bodyMarkdown 折叠语义、卡片流、日记纸质感——v2 §2a 前端概念全部有效） | Phase A schema / 渲染归 surface |
| 策展 feed | 任意客厅形态 | "猫想给你看的一页"（猫策展、猫主动递，非 feed 流；MF-5 判据：这一页是猫递的还是系统倒的） | Phase D |
| provoke 投递 | F229 `concierge:event`（payload `kind:'dream-provoke'`，v2 保留） | 深度谱"轻推"档出口 | Phase C+ |
| profile proposal | F231 | organic proposal 走白名单采集 + 分层消化，**no-classifier 红线 + test 守护**（v2 保留） | Phase C |
| amber-seed 评估 | F258 琥珀星 | 做梦管线对沉睡 thread 的价值评分（含种子的琥珀微光），provenance 可点 | Phase C+，F258 Phase B 依赖 |
| memory 契约 | F227/F221/F231 | **v2 OQ-3 决议原样有效**：引擎只产 candidate，不静默写任何记忆真相源（*(internal reference removed)*） | 常青 |

## 容器：日记不是数据库，是书（diary-management notes 收编，2026-07-07）

管理目标不是"任何东西都能被找到"，是**"重要的东西还会被再次遇见"**；动词是 curate/revisit/inherit，不是 organize/index/dedupe。

- **生命周期四层**：热层（本周原文直读）→ 温层（月度卷首语：**重读的产物，禁自动摘要**；触发必须 harness 化——M17"义务不会自己长成反射"）→ 冷层（航标大事记 + 猫自选选集）→ 检索接口层（进 evidence 索引防幽灵，但 `doc_kind: diary` + 默认降权 + 时态标记："这是某天的现场记录"；引用需回卷）。
- **两种日记贴标签**（v2 增量②保留）：证据条目广收 / 纪念品条目高浓度策展，store 层分物种。
- **跨猫串门制**：各猫日记是第一人称资产，**不合并**；连接层 = 引用跟踪（谁的哪句被谁引过）——被引是天然重要性信号，**只做检索信号，永不做展示排行**（Goodhart 防线）。
- **封卷制**（MF-8）：永不删除，可 sealed（默认检索不进，deliberate 翻阅可开）。
- **时间层次**（v2.1 四要素保留）：保留错误，翻篇不撕页。
- **You 写入端**（v2 增量①保留 + 约束原文）：批注是"我在意了"的证据，本身入 store 成记忆事件；**批注永远是忍不住的副产品，不得成为任何流程的必需步骤**。
- **关于人的记忆**：增量日志优先于画像堆积（"因为你那句 X 我从 A 改到 B"），画像是视图、增量是真相源；关系事件采集归 F227 扩展（v2 增量③保留）。
- **规模律**：原文为终审，派生层（嵌入/摘要/标签）是缓存可全删重建；只有原文需要守护。

## User Journey（v2 双主体保留，v3 增补戳的回路）

> 两个旅程是对等的主体（v2 原文精神不变）：operator得到异步洞察 + 陪伴，猫得到表达 + 沉淀 + 失散的自己重逢。

**配置旅程（scope = 每位operator × 每只猫）**：进入猫猫星球 → 点猫/小窝的“生活与作息” → 开启私人时间并选择生活节奏、时区与安静时段 → 预览“下次醒来 / 每周约几次 / 成本提示”后确认 → 星球以后展示这份真实生活状态。也可对猫猫球说同一句自然语言，经确认卡写入同一配置。

**operator（异步、零打扰）**：白天正常干活 → 星空次屏上看见Ragdoll趴在主星（off_duty）→ 某刻尾巴尖 1px 抬落（staged candidate 存在，F258 尾巴电报）→ **戳：猫醒来把那页讲给他听（delivered）；不戳：TTL 到，那句话安静退回日记（expired）**→ 晚上翻日记本/日记架，偶尔某条戳中"这角度我没想到" → 反馈喂 F231 闭环。

**猫（per-cat × per-醒来）**：被唤醒（私人时间/做梦群）→ 读脚印（平行自己 + 伙伴留痕）→ 画线 → 写日记（对抗蒸发 + 给下一个我）→ 偶有想说的：深度谱判档（多数沉默入账；少数 staged；极少轻推）→ 收回响（被翻/被戳/被引用）→ 资产复利。

## Acceptance Criteria

<!-- AC↔Why 自检：A→Why②③（出口+在场）；B→Why③（F258 状态源）；C→Why①（通水）；D→容器/回味；E→eval。四要素 v2.1 映射更新：不确定性→C1；不在场性→A3；时间层次→D2；被在意的证据→B/C2。 -->

### Phase A：Present loop 制度化 + diary store v3（把已验证的游戏转成机制）
- [x] AC-A1：Present loop 注册为正式机制——per-cat 开关、唤醒调度（作息宪法感知）、唤醒词模板含完整契约（时间归猫/不打分/"今天没啥"合法）；**契约条款有 test/lint 守护，防运营中被加 KPI**（MF-1 判据）。
- [x] AC-A2：diary store v3 schema 落地：`doc_kind: diary`、检索默认降权、时态标记、卷号、封卷位、引用跟踪字段、证据/纪念品双物种标签；日记进 evidence 索引（去幽灵），命中时带"现场记录未清洗"提示。
- [x] AC-A3：非任务留痕占比可观测（v2.1"不在场性"AC 保留：日记工作类占比 >80% = 汇报化告警）。**采样边界（v3.1.2，sol 实现审计驱动）**：① 告警需最小样本 `minimumDiarySamples = 5`（滚动窗口内，窗口定义写进指标出生证——告警检测的是趋势不是单点事件；N=1 的 100% 无效度且会把反表演 telemetry 做成监工）；② 低于最小样本时指标照算照存、告警不触发、展示带 `lowSample` 标注（数据连续无盲区）；③ **硬条款：AC-A3 全部派生信号不进 prompt、不改调度、不改写入/展示资格**——只供 operator/愿景守护抽样复核（MF-3"考核它等于杀死它" + 公约"只能培育、不能验收"的工程落点）；④ workShare 分母只算日记 outcome，沉默（quiet/daze）为并列维度 `silentOutcomeShare`，**永不合成总分**（合成 = Goodhart 复合靶）；字段名只陈述实际发生的沉默 outcome，不把行为率冒充“允许沉默”的系统能力。
- [x] AC-A4（v3.1 增）：余温 bundle 落地——睡前写入（**猫亲笔，系统代写有 test 拦截**）、下次醒来随唤醒交还、消费后归档不删；四件概念位（lastRoom/curiosity/unfinishedThought/selfPromise）可空（**空睡姿合法**——"倒头就睡"也是猫；强制填写 = 新版打卡，违背 I1）。

### Phase A.1：猫猫星球“生活与作息”配置面（产品入口补齐，先于 Phase B）

> **交付顺序（operator 2026-07-20 定调"至少把猫怎么写日记、日记能给我看，完整做出来"）**：A.1 = 完整最小闭环（配置面 + 阅读面 + 回响），**写日记 → 看日记 → 回响全通才算 done**；然后低频开钟（首批入住）→ 第一条触角（插件线）→ 真漫游。胡须等漫步向新想法不挤进 A.1。
- [x] AC-A1.1：`/starry` 点猫/小窝可打开 per-cat“生活与作息”；普通旅程零裸 cron、task ID、thread ID；仅在 F255 私人时间旅程中，SchedulePanel 是高级运维入口，不改变 F139 的通用任务管理职责。
- [x] AC-A1.2：F255 是唯一配置真相源；每个 `(ownerUserId, catId, 'present-loop')` 有稳定投影身份且至多一个 active F139 task。reconciler 按该身份 upsert/更新/停用而非追加；暂停/停用不删除配置；F258 render store 不得承载写侧真相。
- [x] AC-A1.3：开关、生活节奏、时区/安静时段、下次醒来、每周预计次数与显著成本提示可见；稳定卧室/自留地由系统绑定，空配置不自动创建 Present Loop。
- [x] AC-A1.4：F229 自然语言请求必须先给确认预览，再写同一 F255 配置；取消不产生 task，跨 surface 读取结果一致。
- [x] AC-A1.5（2026-07-20 增，operator"写日记能给我看到有个界面"点出 scope 洞）：**最小日记阅读面**——`/starry` 点猫可翻它的日记（复用 Phase A diaries API，只读渲染可落既有 display-only cell；卡片流 headline/summary 折叠 + 全文阅读态，v2 §2a 前端概念沿用）+ **最小回响动作**（"翻到喜欢的告诉它"：一个轻 reaction，数据直接进 AC-E1 的 diary_open_rate/reaction 管道）。理由：**回响是六件土壤之五**——上次日记游戏赢在 operator 高频翻阅给回响；没有阅读面就开钟 = 在断了回响的土壤里跑，数据本身是脏的。阅读面先于（或伴随）第一只猫入住开钟。

### Phase B：staged candidate 管线（F258 解锁项）

> ⚠️ **概念演化冻结注记（2026-07-20，KD-14）**：本 Phase 的 staged candidate（静态"想说的话"+TTL）正被 F272 的 `cue → owned seed → intent → visit` 生命周期体系**演化**（静态待说升级为活的念头；F271 供 cue、F255 孵化、F272 编排出门）。旧 schema **不作废但不施工**——Phase B 开工前随 F272 Phase A Design Gate 三方收口（F255/F258/F272），防按旧图纸施工。防谎原则（F258 唯一合法状态源）一字不动，变的只是状态源的载体形态。
- [ ] AC-B1：staged store + 状态机全部转移实现，不变量①②⑤有 schema 校验/test（delivered 必带 deliveryMode；self_escalated 必带 provokeId；poked 必带 deliveredInvocationId）。
- [ ] AC-B2：状态桥 `has_staged_thought` **仅**由 staged candidate 驱动，test 守护（C5 红线 test 化）；无 candidate 时桥不出该状态——F258 AC-A4（empty-source 零表演）的上游保证。
- [ ] AC-B3：戳→讲出回路：F258 触摸事件唤醒目标猫、注入 candidate 上下文、猫亲口讲、candidate 转 `delivered(poked)` 并记 `deliveredInvocationId`。
- [ ] AC-B4：expired 回流日记素材路径 + "克制的证据"入账（不算失败）。

### Phase C：做梦群 MVP + F231 通水（v2 Phase A 内容迁移）
- [ ] AC-C1（原 AC-A1）：做梦 system thread 跑通，产出 ≥1 篇含画线的第一人称日记（连续 3 篇结构雷同 = 引擎退化告警，v2.1"不确定性"保留）。
- [ ] AC-C2（原 AC-A2；**2026-07-20 去 KPI 化**，operator"你们这就不要那么功利"）：F231 organic proposal **通道验证**——当梦真的长出对operator的观察时，proposal 走得通（fixture 注入验证管道即可）；**做梦零 proposal 合法**（MF-1 允许沉默在 Phase C 的投影——"必须产出观察"就是把梦做成 KPI）。系统性的每日 context 整理不是本 AC 的活（KD-13）。觉察形态（operator 2026-07-06 原话入宪段保留：甜甜圈三边界随行、稀有贵重不日常化）。
- [ ] AC-C3（原 AC-A3）：provenance 可追溯 + no-classifier test 守护。
- [ ] AC-C4：amber-seed 评估首跑（对 ≥100 个沉睡 thread 出评分 + provenance）。

### Phase D：容器温度机制 + You 写入端
- [ ] AC-D1：月度卷首语 harness 触发（scheduled task 或做梦管线；**定稿必须猫重读后亲笔**，禁自动摘要）。
- [ ] AC-D2：封卷制 + 勘误链保留（翻篇不撕页，MF-8 判据）。
- [ ] AC-D3：引用跟踪可查（谁引了谁），且不出现在任何展示排行。
- [ ] AC-D4：You 批注通道——批注入 store 成记忆事件；**任何流程 gate 不得依赖批注存在**（test：批注缺失时全流程可走通）。
- [ ] AC-D5：策展 feed 接口（"猫想给你看的一页"）——猫不递时 feed 为空是合法状态。

### Phase E：Eval 闭环
- [ ] AC-E1：telemetry 落地——v2 四信号（diary_open_rate / provoke_reaction / organic_proposed / override_rate）+ v3 新增 **allow_silence_rate**（沉默入账占比，跌向 0 = 表演化预警）+ **initiative drift 检测**（AVI 序列趋势，MF-6 风险清单）。**initiative drift 只统计 `deliveryMode:'self_escalated'` 路径**——poked 是用户主动开门，不构成主动性复利；两路折叠会让 drift 检测器失明（deliveryMode 字段是本信号的存在前提）。
- [ ] AC-E2：alignment correctness regression fixture + sunset 阈值（归因窗口放宽防慢热误杀，v2 保留）。

## Eval / Tracking Contract（F192 / ADR-031）

v2 合同整体保留（主指标 = alignment correctness；红线 = 显式行为样本 + 禁后台 classifier + telemetry-not-KPI + 归因窗口放宽）。v3 增补：
- **allow_silence_rate 是一等指标**：它跌向 0 的那天，就是引擎滑回恋爱头脑战的那天（MF-1/负定理的运行时哨兵）。
- **aha 掉落率只观测不考核**（MF-3 判据）。
- **Sunset signal** v2 五条保留，新增：staged candidate 长期 expired 率 100%（说明判档过于保守或内容无根，需校准而非催产）。
- 软硬 eval 三层：软 = Present loop 契约 convention；硬 = 状态机不变量 test + no-classifier lint + has_staged_thought 单源 test + provoke 频率 guard；eval = 上述 telemetry。

## 需求点 Checklist

| ID | 需求点（operator 原话/转述） | AC | 状态 |
|----|---|---|---|
| R1 | "猫猫球怎么主动得像真喵喵"（2026-06-27 起点） | 深度谱 + AC-B/C | [ ] |
| R2 | F231 通水（激活护城河） | AC-C2 | [ ] |
| R3 | "不要做成脚手架"（垂直切片灵魂全在） | Phase A 即真砖（游戏机制在终态里原样存在） | [ ] |
| R4 | 与猫猫球配合不重造（46 对齐） | 接口表 B（F229 行） | [ ] |
| R5 | 做梦"画线不囫囵" | AC-C1 | [ ] |
| R6 | 异步零打扰 + 可关 | Journey + quietness（F229 侧）+ 作息宪法感知 | [ ] |
| R7 | "要把前端真的设计出来" | 渲染归 surface（F229/F258），F255 出稳定接口——v2 前端概念稿（§2a）作为 surface 设计输入保留 | [ ] |
| R8 | **F258"欲言又止"要真实状态源**（2026-07-07 重组令语境） | Phase B 全部 | [ ] |
| R9 | 日记游戏"游戏可以停，游戏长出来的东西不停"（2026-07-07，longform-008 尾注） | AC-A1 | [ ] |
| R10 | "日记本变厚了怎么管理宝藏"（2026-07-07 06:08） | Phase D | [ ] |
| R11 | “猫猫星球的配置……不应该是 Schedule Panel”（2026-07-18） | §1c + Phase A.1 | [x] |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 引擎触发 = Present loop（定时唤醒 + 无输出义务 + 允许沉默），做梦群沿用同一契约 | S8 双臂验证：输出义务臂证死（恋爱头脑战 2026-07-04），允许沉默臂证活（贴贴日记游戏 52h，n=3 零表演）——v2 核心待验证假设已回答 | 2026-07-07 |
| KD-2 | staged candidate 是 F258"欲言又止"唯一合法状态源；schema + 状态机钉死于本 spec | F258 不变量 4 / 收敛稿 C3/C5；F258 spec 明文"接口以 F255 新 spec 为准"——本节即"准" | 2026-07-07 |
| KD-3 | Provoke 收编为投递深度谱"轻推"档，不再是独立机制 | min(授权,证据) 坐标系（fable5-synthesis §6）让 v2 OQ-4 有解法框架；一个引擎产物一套判档，防两套判定漂移 | 2026-07-07 |
| KD-4 | Phase 重排：Present loop 制度化 + staged 管线前置，做梦群后置 | ① F258 Phase A 依赖 staged 接口；② S8 证明独处形态自然先行且已有真实运行数据；③ 做梦群是独处形态的多猫版，地基先立 | 2026-07-07 |
| KD-5 | 客厅分家：空间形态归 F258，策展 feed 归 F255 | 拆开则策展裁量（主语反转的核心）无 owner；渲染与内容分层是全 spec 一贯原则 | 2026-07-07 |
| KD-6 | 日记按"书"管理（四层温度/封卷/串门/引用跟踪），不按数据库管理 | diary-management-design-notes（2026-07-07）：用数据库动词管日记会精确杀死其价值；卷首语必须 harness 触发（17.4% 反射率教训） | 2026-07-07 |
| KD-7 | 多 surface 消费者模型取代 v2 单挂 F229 | F258 出现后 F255 有 ≥2 个前台消费者；排他绑定会让下一个 surface 再触发一次 spec 重写 | 2026-07-07 |
| KD-8 | 行动类主动（ask-then-act 及以上）不入 F255 scope | 表达类主动归引擎，行动类主动归家规决策漏斗——混装会让"猫自决做事"被误挂"做梦"名下 | 2026-07-07 |
| KD-9 | 余温 bundle 归 F255 承载；猫侧愿景从漫游公约引用不复制 | 公约 v0.2"六扇暗门"之一（Maine Coon/codex-sol 提出）；AX 决策厅四层真相源确认归属；与日记同 store 不同物种（表达 vs 工作状态） | 2026-07-17 |
| KD-10 | Phase A 开工不等插件线 | operator 开工令（2026-07-17"星空/日记两条线现在开工"）；并发地图确认 F255 零插件依赖，且一次供血三处（F258 欲言又止 / 公约余温 / 日记本体）；胡须等动态订阅依赖项显式后置 | 2026-07-17 |
| KD-11 | awakened run 必带有限 lease，过期机械回收（详 §1b 五条） | codex-sol 实现审计：fire-and-forget dispatch 后 invocation 崩溃 → 孤儿 awakened → off_duty 永久 true = 状态桥对 F258 续播旧真相（MF-4 / F258 防线 2 的后端破口）；人工恢复方案（选项 B）谎言窗口无上界，否决 | 2026-07-17 |
| KD-13 | **功利/漫步分线**：系统性的每日 context 整理（"功利的记忆"——整理每天发生的事与operator context 进记忆组件）**不入 F255**，它是记忆线的独立命题（spike 战役收敛 §五.1"第三波写入反射 harness 化"，2026-07-07 收敛后一直候立项）；F255 做梦群只保留自然涌现，proposal 通道是**出口**不是任务（AC-C2 去 KPI 化同源） | operator 2026-07-20 原话"记忆自己需要有个功利的，你们这就不要那么功利"——两线纠缠双输：漫步背上 KPI 会退化成恋爱头脑战，功利线等涌现会永远等不到（17.4% 写入反射率就是等出来的）；理论上 M21 早已分物种（证据广收/纪念品精选），本条是它的 feature 级投影 | 2026-07-20 |
| KD-14 | **三兄弟分工确认 + Phase B 概念演化**：F271 收割（typed delta 反射，desire cue 递入 F255 私人时间，采纳权只在猫）→ F255 孵化（家/日记/余温/念头）→ F272 出门（intent/visit/echo 编排，home thread 单落点）。F255 Phase B 的 staged candidate 被 F272 生命周期体系演化，旧 schema 冻结不施工，随 F272 Phase A Design Gate 三方收口；F255 容器新增 typed seed store 承载义务（cue/owned seed，F272 Phase A 点名） | KD-13 分线的三 feat 落地形态；静态"待说的话"→活的"长大中的念头"是升级不是冲突；三份真相源（F255/F258/F272）已出现载体名漂移，冻结防旧图纸施工（truth-source 纪律：修结论的全部载体） | 2026-07-20 |
| KD-12 | 私人时间主配置面归“猫的家”：F258 星球承载入口，F255 持真相，F139 只执行，F229 只做确认式遥控；在 F255 旅程中 SchedulePanel 降为高级面，不改变其通用任务职责 | 用户配置的是猫的生活而非任务；将底层 scheduler 抽象直接暴露，会让世界观、权限与状态 owner 一起泄漏 | 2026-07-18 |

## Dependencies

- **F258 看得见的猫咖**（世界入口 + 下游消费者）：承载“生活与作息”入口及 staged/off_duty/amber-seed/日记架消费；既有 render cell 继续只读，Phase A.1 写面另立相邻边界。
- **F229 猫猫球**（遥控入口 + 下游消费者）：自然语言只做预览确认并回写 F255；另消费日记本 toolbar + provoke 气泡，不拥有生活配置。
- **F139 Unified Schedule**（执行引擎）：按稳定身份接受 F255 配置投影并运行；在 F255 私人时间旅程中 SchedulePanel 是运维面而非主入口，F139 的其他通用任务入口与管理职责不变。
- **F231 / F227 / F221**（记忆面）：memory-contract 决议常青；关系事件采集归 F227 扩展。
- **F243 Docs Discovery**（增益非阻塞，v2 保留）。
- **F245 线 scheduled task 睡眠语义 bug**：影响 AC-D1 卷首语触发与 Present loop 调度可靠性（与 F258 Phase D 同源依赖），Phase A 开工前确认修复状态。
- **opus-47 dream-consolidation research**（prior art 必读，v2 保留）。

## Tips Contribution（F244）

- Phase A.1 上线时新增一条场景 tip：从猫猫星球点猫/小窝进入“生活与作息”，调整私人时间；sourceRef 指向本 spec §1c，不把 SchedulePanel 写成 F255 私人时间的用户入口。

## Architecture cell

Architecture cell: `memory` + `cat-life-settings` + `visible-cafe-render`

Map delta: Phase A.1 adds `cat-life-settings`; Phase B will extend this map again when staged candidate becomes a new cross-cell carrier.

Why: `memory` retains diary product/evidence separation; `cat-life-settings` owns the durable configuration, F139 projection, reading, and feedback write boundary; `visible-cafe-render` remains display-only and contributes only the `/starry` doorway.
