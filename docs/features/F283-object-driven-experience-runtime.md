---
feature_ids: [F283]
related_features: [F153, F192, F223, F268, F277]
topics: [frontend, experience-runtime, object-driven-ui, adaptive-ui, capability-readiness, telemetry]
doc_kind: spec
created: 2026-07-31
description: "让稳定可召回的界面骨架按真实运行对象与用户判断点浮现内容，并用可校准信号持续验证哪些动态表面真正有用。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-31T09:30:00Z
---

# F283: Object-Driven Experience Runtime — 对象驱动的动态体验运行时

> **Status**: frozen / research hypothesis (Experience Design Gate not authorized) | **Owner**: 小太阳·Maine Coon
> (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator signoff**: `0001785489147032-000207-931331e7` — “好像得立项了，F277
> 和新的动态 UX 应该不是一个 feat 才行”。本签字授权立项与体验原型，不授权生产 UI
> 实现；真实页面实现必须先过 operator Experience Design Gate。
>
> **Freeze source**: `0001785494350337-000269-73941a81` — 通用动态 UX 重构冻结；先把 F277 与轻度 UI 整治解耦。

## Architecture Ownership

当前 owner split：

- F223 / `hub-action-surface`：猫或系统把 Workspace、Preview、rich block 等第一方表面
  端上桌的 typed execution surface 与可验证 delivery；
- F153：原始 telemetry 与运行健康；
- F192/F268：不确定效用的 measurement / eval 与 keep、tune、sunset 决策；
- F277 / `thread-navigation`：thread 注意力聚类、导航与关系投影；
- **F283**：运行对象、用户判断点与能力 readiness 如何解析成当前页面的
  `collapsed / visible / expanded / degraded` 体验状态。

architecture map delta 必须在 Phase C 开工前关闭，预期在 Phase A 结束时裁决：F283 是扩展
`hub-action-surface`，还是建立更窄的 `experience-runtime` cell。该决议前不落生产 runtime，
不拿原型结构倒逼架构。

## Why

Clowder AI 已经拥有大量能力和多个固定面板，但固定展示会持续收取导航税；反过来，把一切砍成
极简界面又会让用户主动找不到 Workspace 等能力。You 要的不是“更多面板”或“全部隐藏”，而是：

> “如果不是在开发什么，好像就没必要展示；甚至就算是在开发，类似这样的模块也应该允许
> 折叠或默认折叠。”

同时，动态界面不能靠猫或模型心情变化。它必须基于真实对象、能力状态与明确的用户判断点，
保留稳定召回入口，并能回答：用户自己打开了什么、猫帮忙打开了什么、哪些只是被展示、
哪些最后真的形成了行动。

本 Feature 的价值目标是：**用很少的稳定骨架承载可召回能力，让运行对象默认以低税折叠态
出现，只有明确需要用户判断时才主动展开；再用可校准的行为信号决定这套浮现策略该保留、
调节还是撤销。**

## Current State / 现状基线

- 当前桌面是 Sidebar + Chat + Right Panel 三列；Workspace/Status 通过右栏 mode 切换，
  `ChatContainer` 还存在 workspace/transcript auto-open effect。
- F223 已提供 `cat_cafe_workspace_navigate`、`cat_cafe_preview_open` 等 typed surface，
  但只回答“怎么可靠打开”，不回答“此刻该不该浮现、默认折叠还是展开”。
- ADR-043 已确立稳定锚点、对象出生证、折叠态优先、可靠召回与投影纪律，但吴浪提出的
  Capability Contract / Resolved PDL 仍被明确标为待验证假设。
- F268 已证明 tips 领域可采 `exposed / action / dismissed / failure` 等隐私最小事件，
  同时明确“click 不是 effectiveness”；尚无覆盖任意 UI surface 的通用 adoption verdict。
- 现有动态体验 Vision Prototype 位于
  `docs/videos/frontend-runtime-concept-demo/`（分支 `feat/frontend-runtime-demo`，验证锚
  `15bf4ca41`）：
  `quiet / developing / decision / degraded` 四态可交互切换；它是体验假设，不是生产实现。
- F277 的右侧“现场”若只重复左侧已有的 thread 成员、归组与状态，就没有信息增量；
  F277 仍留在自己的 Experience Design Gate，不由 F283 替它决定成品。

## What

### Phase A: Aha Vision Prototype + Experience Design Gate

先只验证体验，不先造 PDL、Capability Contract、通用 layout engine：

1. 用家里现有三列视觉语言做四态动态原型：
   - `quiet`：右栏只保留稳定召回把手，不显示空容器；
   - `developing`：运行对象以折叠信号出现，开发中本身不触发自动展开；
   - `decision`：出现明确需要 You 判断的对象时，Workspace 临时展开；
   - `degraded`：用户确认保留的稳定入口显示降级与恢复动作，不无提示消失。
2. 同一原型同时验证用户手动打开、猫建议打开、系统策略浮现三条入口。
3. operator 在 Chrome 里亲自走完整时间线，裁决“还能多简约”“何时展开开始打扰”。
4. 只有 operator signoff 后，才从体验反推最小运行契约；不让工作假设先绑架产品。

### Phase B: Surface Episode + Measurement Certificate

为同一 surface episode 定义隐私最小、可去重的结构事件。候选语义：

- `surface_exposed`：入口或折叠态确实对用户可见；
- `surface_opened`：表面被打开，`origin = user | agent | system_policy`；
- `surface_acted`：用户在表面内完成与出生对象相关的明确 action；
- `surface_collapsed | surface_dismissed`：用户主动降噪或拒绝；
- `surface_degraded | surface_recovered`：稳定入口的 readiness 变化。

这组 F283 surface 事件是受 F268 tips 事件启发、但覆盖面更广的独立 namespace；二者不得
自动推断或机械翻译。未来若复用同一事件 substrate，必须先给出显式、可审计的语义映射。

事件只携带 schema-bound `surfaceKind / origin / episodeRef / objectKind / readiness /
timestamp` 与必要的 scope ref；禁止消息正文、文件内容、prompt 与自由文本。原始 telemetry
走 F153，长期效用判断走 F192/F268 同款 eval discipline；F283 不建立第二套 telemetry
平台。

本 Phase 必须先落 measurement certificate，再允许 verdict：

- **Utility claim**：对象驱动浮现能减少用户召回步骤，同时不增加无效展开与判断税。
- **Estimator**：按 episode 区分 exposure、open、action、dismiss 与 recovery；用户手动
  打开表示真实召回需求，猫/策略打开只是 offer，不能直接算 success。
- **Validity bounds**：重复打开必须去重；dwell time 不等于价值；自动展开会机械抬高
  open count；“没点”可能是折叠态已足够，不能直接判失败。
- **Consumer**：operator + F283 owner 只据此决定某条浮现策略 keep / tune / sunset，以及
  哪些能力需要稳定入口；不用于给用户或猫打绩效分。
- **Calibration**：先由 operator 对有代表性的 dogfood episode 标注
  `helpful / unnecessary / intrusive / insufficient`，再冻结窗口、样本量与
  withdrawal condition；未校准前只做 observability，不挂健康 verdict。

### Phase C: One Resolved Experience Vertical Slice

只选择一个现成能力族做真实纵切片，默认候选为 Workspace：

1. 读取 canonical capability/readiness 与当前运行对象；
2. 生成一份可重建的 resolved experience projection；
3. 同一语义同时供人类 UI 和猫查询，避免猫只知道“系统有能力”却不知道用户眼前在哪；
4. 支持用户手动打开与猫 typed action 打开，二者共享 surface identity，但保留 origin；
5. 严格实现稳定锚点、默认折叠、判断点展开、降级不消失、可一键回默认布局。

本 Phase 不做全站迁移，不做自由生成 UI，不定义通用 PDL；纵切片通过后才判断哪些字段
值得升格为 Capability Contract / Portable/Resolved PDL。

### Phase D: Dogfood → ADR Revision or Rejection

- 用真实 episode 回放检验四态与召回边界；
- 将验证成立的条文候选修订进 ADR-043；
- 不成立的浮现规则明确撤回，不用“以后调参数”保存失败假设；
- 若 Workspace 纵切片不能同时改善召回成本与判断税，停止 Runtime 产品化，保留
  F223 typed actions + 稳定静态入口。

## User Journey

### Primary Journey: 界面只在该出现时长出来

- **Scope unit**: workspace
- **Actor**: You + 猫猫
- **Entry**: You 打开 Clowder AI，当前没有需要操作的运行对象。
- **Flow**:
  1. 页面保留 Sidebar / Chat / Workspace 稳定召回锚点，右侧没有空面板税。
  2. 猫开始开发 → 右侧只出现低密度折叠信号；You 可忽略，也可主动打开。
  3. 出现明确决策 → Workspace 临时展开并只显示判断所需内容。
  4. You 完成判断 → 运行对象收尾，表面回到折叠或消失；Workspace 主动入口始终可找。
  5. 若能力故障 → 稳定入口保留降级态与恢复动作，不静默消失。
- **Success evidence**: Chrome 交互原型录屏 + 桌面/窄屏截图 + operator signoff；
  生产纵切片阶段再补 typed event replay 与 alpha UAT。
- **Non-goals**: 全站前端重写、模型自由生成 DOM、用点击率当价值、替 F277 设计 thread
  聚类、让系统替用户硬性限制注意力预算。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | surface episode | You | 主动点 Workspace → 入口稳定可找 → 打开 origin=user | event fixture + screenshot |
| S2 | surface episode | 猫猫 + You | 猫建议并打开 Workspace → You action/dismiss → 保留 origin=agent | typed action replay |
| S3 | capability | You | pinned Workspace readiness 失败 → 显示 degraded + recover → 恢复 | failure/recovery fixture |

## Acceptance Criteria

### Phase A（Aha Prototype）

- [ ] AC-A1: Chrome 中可切换 `quiet / developing / decision / degraded` 四态，且
  developing 默认折叠、decision 才主动展开、quiet 无空容器。
- [ ] AC-A2: 原型有稳定 Workspace 主动入口；动态内容隐藏时无需猜测即可召回。
- [ ] AC-A3: operator 走完整时间线并签字，明确自动展开阈值、默认折叠内容与不可接受的打扰。
- [ ] AC-A4: 原型及说明明确标为 Vision Prototype，不宣称 capability/runtime/schema 已实现。

### Phase B（Measurement Certificate）

- [ ] AC-B1: typed event schema 区分 user / agent / system_policy origin，并以 episode 去重；
  forbidden-field tests 证明不采正文、文件内容、prompt 或自由文本。
- [ ] AC-B2: measurement certificate 完整定义 utility claim、estimator、validity bounds、
  consumer、calibration、样本量/窗口与 withdrawal condition。
- [ ] AC-B3: click/open 单独不能产生 effectiveness success；高 open/零 action、
  折叠态已足够、立即 dismiss 三类反例均有 fixture。
- [ ] AC-B4: telemetry 复用 F153，eval 复用 F192/F268 接入点；F283 未建立平行通用管道。

### Phase C（Workspace Vertical Slice）

- [ ] AC-C1: resolved experience projection 可从 canonical capability/readiness + 运行对象重建，
  无手工第二清单。
- [ ] AC-C2: Workspace 手动打开与猫 typed action 打开共享 surface identity，origin 可区分且
  delivery 可验证。
- [ ] AC-C3: quiet/developing/decision/degraded 四态有行为测试、视觉证据与 alpha UAT；
  用户确认保留的稳定入口在 degraded 时不消失。
- [ ] AC-C4: 一键回到全量默认布局，断线/失败不把用户留在不可召回状态。

### Phase D（Dogfood Closure）

- [ ] AC-D1: 至少一轮 operator calibrated episode 产生 keep/tune/sunset 决策，不用裸 CTR。
- [ ] AC-D2: 仅验证成立的规则进入 ADR-043 revision；失败假设被明确撤回。

## 机制选择

| Claim | 机制 | 原因 |
|-------|------|------|
| 四态切换、稳定召回、降级不消失 | 行为测试 + Design Gate | 明确体验契约 |
| 展开/收起是否真正有用 | eval-design | 效用不确定，且要驱动 keep/tune/sunset |
| telemetry 是否丢、延迟、重复 | F153 logs/metrics/traces | 运行健康，不挂 Eval Hub |
| 猫如何调用 Workspace surface | F223 convention/typed tool | 已有确定执行契约，不重造 |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “如果不是在开发什么，好像就没必要展示” | AC-A1/C3 | Chrome 时间线 + screenshots | [ ] |
| R2 | “就算是在开发，也应该允许折叠或默认折叠” | AC-A1/A3/C3 | interaction replay + operator signoff | [ ] |
| R3 | “主动想打开 Workspace 时不能找不到” | AC-A2/C4 | recall path replay | [ ] |
| R4 | 记录用户手动点开与猫帮忙打开，知道哪些真的在用 | AC-B1/B2/B3/D1 | event fixture + calibrated verdict | [ ] |
| R5 | F277 与新的动态 UX 不是一个 feat | OQ-1 关闭 | architecture ownership review 记录 | [ ] |

### 覆盖检查

- [ ] 每个需求点都映射到至少一个 AC。
- [ ] 每个 AC 都有 test、截图、录屏、measurement certificate 或 operator signoff。
- [ ] 前端需求已准备需求→证据映射表。

## Dependencies

- **Evolved from**: ADR-043（对象出生证、折叠态、可靠召回与投影纪律）
- **Related**: F223（第一方 Hub surface typed action 与 delivery verification）
- **Related**: F153（raw telemetry / runtime health owner）
- **Related**: F192 / F268（eval runtime 与 adoption≠outcome 的 measurement 先例）
- **Related**: F277（thread attention 是独立消费者，不是本 Runtime 的 core scope）

## Risk

| 风险 | 缓解 |
|------|------|
| “动态”变成模型随心重排 | 只消费 typed object/readiness/event；布局定型需用户确认 |
| 极简导致能力失联 | 稳定召回锚点 + 默认布局回退 |
| 自动展开制造新打扰 | developing 默认折叠；只有明确判断点可展开；用 calibrated episode 调整 |
| 点击率 Goodhart | open 只是 offer/demand 信号；必须结合 action/dismiss/qualitative label |
| 先造通用 PDL 造成架构豪赌 | 先做一个定制 Aha Prototype + Workspace vertical slice |
| 与 F277 混成巨型前端改造 | F277 只管 thread attention；F283 只管 object→surface experience policy |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F283 与 F277 分立 | thread attention 是一个 consumer；动态体验是跨能力的 surface policy |
| KD-2 | 先 Aha Prototype，后抽象 Runtime/PDL | 防止工作假设先绑架最终体验 |
| KD-3 | 稳定骨架 + 默认折叠 + 判断点展开 | 同时避免空面板税与极简失联 |
| KD-4 | manual/agent/system origin 必须区分，但裸次数不等于价值 | 自动行为会污染计数；效用需 episode 校准 |

## Review Gate

- Phase A：operator 是唯一体验签字人；猫/社区 review 只查概念漏洞、可实现性与边界。
- Phase B：按 eval-design 出生证审 measurement；隐私与 telemetry owner 交叉复核。
- Phase C：非作者 review + targeted UI tests + browser evidence + alpha operator UAT。
