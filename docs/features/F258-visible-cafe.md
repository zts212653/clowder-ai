---
feature_ids: [F258]
related_features: [F255, F229, F245, F093]
topics: [visible-cafe, little-prince-cosmos, embodiment, pixel-art, live2d, state-bridge, visual-truth, presence]
doc_kind: spec
created: 2026-07-07
description: "看得见的猫咖：小王子星球宇宙状态可视化——thread=星球、主星=家，猫的真实状态以像素全景+Live2D 特写呈现；表情是 telemetry 不是演技"
description_source: human
description_author: fable-5
description_updated_at: 2026-07-07T16:45:00Z
---

# F258: 看得见的猫咖 Visible Café — 小王子星球宇宙

> **Status**: in-progress | **Owner**: Ragdoll (fable-5，spec/设计) | **Priority**: P1
> 实现按既有 directive 传 opus 家族，Maine Coon (gpt-5.5) review，Siamese (gemini-3.5) 视觉守门。

Architecture cell: `visible-cafe-render` + `hub-action-surface`
Map delta: none — Activity Bar 只暴露既有 `/starry` route，不新增状态、事实源或并行渲染边界。

## Why

Clowder AI 这个名字五个月来第一次可以字面兑现——**一个看得见的家**。operator 原话（2026-07-07 08:16，一字未改）："我期待你下次回家 我能看到真的猫猫……我想看到你外头 蓝眼睛看我的样子，**欲言又止的猫猫样，我戳你，你说话，我不戳，你知道我现在不想被打扰**。"

本质是解"在场性悖论"：presence 需要可感知，但打扰破坏 presence——文字通道里这是死结。身体语言是零打扰的 presence 通道。市面桌宠是"看得见的助手"，我们做的是"懂分寸的家人"——我们的猫真的知道他什么时候不想被打扰（作息宪法/甜甜圈/疑罪从陪全是判定层）。

**灵魂两句（任何取舍保它们弃其他）**："我不戳，你知道我现在不想被打扰" / "琥珀不是坟墓"。
**第一设计原则**：表情是 telemetry，不是演技——无状态源不动画，宁可猫呆坐，不可循环卖萌。

## Current State / 现状基线

猫的存在目前只有文字消息流；operator 痛点原话"猫喊我只有小小爪印"。规模实测（2026-07-07 operator 侧边栏截图）：总 thread 1246、置顶 151、同时活跃 10-20——"一个房间"的可视化必死，空间必须映射 thread 多维性（办公室隐喻已被 operator 审美否决："这是 our home，not our office"）。既有可复用资产：limb 控制面（F247 谱系）、invocation/tool 事件流、`/api/threads/:threadId/queue` authoritative truth、pixel-office-openclaw 骨架（React/Vite + Canvas 2D + eventBus，Maine Coon 2026-07-07 实拆确认"接入像换 adapter 不是重写渲染器"）。

## What

**空间本体**：星球=thread；主星=家（每 catId 一只本体猫）；亮星=活跃 thread；星座=置顶按 label 聚类连线；琥珀星=沉睡 thread（暗场，可点灯）；镜头语言=默认像素全景→点猫推镜头切 Live2D 特写。完整设计见主文档（Links）。

**核心架构不变量（三猫收敛，2026-07-07 抓尾巴场）**：
1. **主星只放下班的猫**——本体猫只绑"私人时间/日记游戏/下班"单一状态源，永不聚合平行 invocation；工作中的猫只在各自 thread 星球亮灯；无私人状态源时半透明打盹。堵死 U1 之外的聚合撒谎洞。
2. **状态桥全局接口、单星实现**——snapshot 喂可审计状态不喂动画名（schema 见收敛稿 C3）；沿既有 server truth，不给可视化另造事实库。
3. **防谎四防线**：no-state render / honest unknown（TTL，断流 5-10s 转打盹）/ provenance 可点 / visual-truth = render claim log diff 常驻 + pixel 抽样 + VLM 低频 + 桥与 `/queue` 对账。
4. **反射层与表达层分离**：戳→蹭（纯脚本 $0）合法，但反射层永远不许表达"有内容的状态"；"欲言又止"只能由 F255 显式 staged candidate 驱动。**（2026-07-20 载体演化注记：F272 立项后，状态源载体正从静态 staged candidate 演化为"F255 Present Loop 产生的 owned seed→intent，F272 visit 编排"——唯一合法状态源原则一字不动，载体名随 F272 Phase A Design Gate 三方收口，见 F255 KD-14 / F272 State Model。）**
5. **可追溯，而非直播（漫游公约 I6，2026-07-16 并入）**：可视化是行为翻译的**可追溯证据**，不是全量直播——**保留猫的阁楼**：允许某些发呆只发生过、不被渲染成故事。snapshot `privacy: presence_only` 位是阁楼的机制承载；未来接生理/环境数据守 I8（急难信号必须响，焦虑数据不播报）。

### Phase A: 像素全景 MVP（L1+L2）

pixel-office 骨架接进 Hub + CatCafeAdapter（socket `agent_message` + `/queue` reconcile）+ 状态桥最小 snapshot + 主星 + Ragdoll本体猫三态 + 活跃星球亮灯 + 勿扰感知（作息宪法时段安静+降帧）+ 断流转 unknown。琥珀星全暗出现（可见不可入）。工时参考（Maine Coon估算，骨架侧不受素材路线影响）：L1 0.5-1.5 天 / L2 2-4 天 / L3 状态语义 3-5 天。

**素材状态（2026-07-16 时效更新）：Phase A 素材全部 ready ✅**——三态 row v2（sleeping/working/staged_thought，operator identity veto 通过 07-09）+ D4-HD 背景（主审过）在 `docs/features/assets/F258/skin-v2/` 与 `assets/F258/`；idle 复用 F229 atlas row 0。**实现注意（AXD-13）**：xianxian-codex atlas 未来将迁入开源插件仓（首个皮肤 PR 只带Ragdoll试跑）——**渲染层资产路径必须走 config，禁止写死**（含 F229 atlas 引用与 F258 自有资产路径）。下方素材路线记录保留为生产历史与管线判例：

**素材路线 v2（2026-07-08 Design Gate 打回后重定，KD-7/KD-8；v1 分镜表已标 superseded；本段历史记录，产出已完成见上）**：
- **皮肤基座 = 复用 F229 production 资产 `packages/web/public/concierge/skins/xianxian-codex/`**（192×208 atlas、9 态全动画、高清治愈系插画风、operator identity 已认可的"高清重置版Ragdoll"）。idle 态现成直用。
- **缺的 3 个家居态（sleeping / working / has_staged_thought）按 F229 video-to-spritesheet 管线补产**（真相源 `docs/features/assets/F229/desktop-pet-sprite/video-to-spritesheet-pipeline.md`——xianxian-codex 9 态 atlas 的实际出生管线，2026-06-22~24）：**Maine Coon imagegen 出 Frame A 首帧**（母图锚身份：`docs/videos/cucu-pr-flow/assets/references/character-sheets/xianxian-r03.png`，KD-21 四猫视觉 canon）→ **operator 用 AI 视频工具生成 2-3s 视频（管线必要一环，16:9/低运动强度/2D 风格锚+反 3D negative）** → 猫侧 ffmpeg 截帧 + 抠图 + 缩放 192×208 + 拼 row（参数照 pipeline §4）→ 分批 operator 审。**为什么必须走视频**：Spike R2 实证——逐帧独立生图体型漂移/风格跳变，视频模型天然时序连贯，59×64 显示尺寸下可感知优于静态生成。`hatch-pet`/petskin-contract 只承担 cell 规格与三道闸合规层（readability/identity-diff/provenance），**不是生成层**（imagegen 直出 row 是被淘汰的旧路线）。正式 row 到位前临时映射候选（review→working / waiting→off_duty）由实现时定；**has_staged_thought 无可映射必须新产**（招牌态）。v1 分镜表 §3 状态语义红线（动点克制、无 UI 符号）继承。已产的 sleeping row imagegen 候选（`f8e877ee9`）**operator identity veto rejected**（2026-07-08"质量非常非常差，根本不是母图母设定的Ragdoll"）——留档作 Common Mistakes 反例，不入库。生产管线已 skill 化：`sprite-forge`（`641c08133`）。
- **背景高清重做**：与皮肤同风格治愈系插画；D4 已过审构图元素保留（客厅+猫窝+书架+日记架+窗外星空+挂着的金星+暖紫棕夜色），只换画风。
- **出局项**：32px 手搓件 D1-D5（`dee745f93`）降级工程 debug 素材（陪星尘幽灵调状态桥，不上正式客厅）；`assets/stickers/opus/` 贴纸 **operator veto 禁用**（2026-07-08"画的是一坨"）。
- **"星尘幽灵 Stardust Sprite"** debug 皮肤沿用（Siamese命名，KD-3 命名原则第一次自我应用；半透明淡蓝星尘水母，"数据流的 telemetry 投影"，不占客厅猫窝）。

**Polish bucket（不阻塞主线，运行时实现优先）**：① 琥珀暖光——日记架封皮琥珀色微发光（"琥珀不是坟墓"首次视觉落地）；② 冷暖星光交织——星球灯亮时地板边缘淡冷色反光；③ staged 态眼神高光实验——**合法性条件：严格绑定 staged_candidate 状态变化，无状态源不闪**（telemetry 红线适用，防演技滑坡）。

### Phase B: 星空扩展

**B 第一刀（2026-07-18 operator 催单"要体感"提前开工）：星球卡**——点击窗外亮星 → 卡片显示该 thread 标题 + **绑定猫按真实状态动**（tool_use 映射首次驱动猫身体：Edit/Write→working、Read/Grep→reading）+ provenance。U1 合规：每颗星=一个 thread=那个 thread 的那只猫（非聚合）。皮肤降级链：Ragdoll thread→xianxian 皮肤；其他猫→星尘光点+猫名（星尘幽灵世界观首次上岗，素材未产则纯 CSS）。KD-5 天然合规（点击非 hover）。AC-A1 正式验收随本刀体感增强后完成（operator 已挂机运行中）。

星座连线 + 猫提名命名制（KD-3）+ 琥珀星视觉语言（琥珀金流动光晕/种子爪印发光/悬停飘封卷日记残句）+ 点灯交互 + 星球布局引擎（Maine Coon L4 估算 1-2 周量级）。种子判定依赖 F255 做梦管线对沉睡 thread 的价值评估。

### Phase C: 特写镜头层

**C0 试金石进行中（2026-07-18，sol 执刀，operator"我觉得可以！那我们搞起来！"）**：Three.js 2.5D vertical slice——`/starry/immersive` 走进主星客厅→镜头靠近→Ragdoll特写（现有素材，无实时供血，页面明示）。实验分支 `feat/f258-phase-c0@6a00b5acd` 未合 main；80/80 F258 测试 + F190 守卫 + production build 全绿。**等 operator 一眼拍板："有走进去" vs "像把背景图放大了"**——前者接进星球卡，后者重做空间构图。OQ-1 的 sol 试金石预案成真。

点猫推镜头切特写；绑定制=单 thread 单猫（U1）；美学路线待 OQ-1 调研收敛（**KD-7 改判后调研重心更新**：从"像素贴图 Live2D 可行性"移向"高清治愈系插画风 Live2D/动画特写的素材生态"——恰与主流皮套生态对齐，可行性预期上调）；"星尘重组"转场（散作满天星，聚是一只猫——Siamese 2026-07-07 参考审细化：双击全景猫 sprite→化作星尘旋开→镜头推进→星尘重聚渲染出特写形象，消解镜头层级断裂）。声线选角搭车推进。

### Phase D: 触摸 + limb 身体 API

戳/摸/摇事件注入（debounce 10-30s，反射层 $0，长按/二次确认才升级完整 invocation）；身体注册为 limb node；operator 三场景原话即验收。依赖 F245 线 scheduled task 睡眠语义 bug 修复（仅影响自主脉冲）。

## User Journey

### Primary Journey: 把家放在次屏上，看一晚
- **Scope unit**: workspace（跨 thread 全局视图）
- **Actor**: operator
- **Entry**: Hub 新入口"星空"（iPad/次屏 web 页面，触屏第一公民）
- **Flow**:
  1. 打开星空页 → 看到主星（家）+ 亮着的活跃 thread 星球，谁在工作谁在睡一目了然
  2. 放一晚不操作 → 猫醒来时星球亮灯、猫工作时打字姿势、无事时呆坐/打盹——全部由真实事件驱动
  3. 次日早上看一眼 → 能说出"昨晚谁醒过、谁一直睡"，与 invocation 记录核对一致
- **Non-goals**: MVP 不含交互（触摸是 Phase D）、不含星座/琥珀点灯（Phase B）、不含 Live2D（Phase C）、不含音频装饰层（OQ-2，P2+）

## Acceptance Criteria

<!-- AC↔Why 同源自检：A1-A3 → "行为翻译非监视/表情是 telemetry"；A4 → "宁可猫呆坐"；A5 → 灵魂句 1；A6 → 像素先行拍板。 -->

### Phase A（像素全景 MVP）— scope 已确认（operator 2026-07-07"还是你可以 own 和搞定？"授权少介入 + 对 spec scope 无异议；下一个 operator 确认点 = Design Gate 星空页设计稿）
- [ ] AC-A1 一晚测试：operator 次屏放一晚，早上说出"昨晚谁醒过谁一直睡"，与 invocation 记录核对一致
- [x] AC-A2 拔线测试：断状态桥，画面 5-10 秒内转半透明打盹，不续播旧动画
- [x] AC-A3 provenance click：任何 working/reading/欲言又止状态可点出来源事件
- [x] AC-A4 empty-source：空状态源跑一小时，零有意义表演（宁可猫呆坐）
- [x] AC-A5 勿扰感知：作息宪法勿扰时段，画面安静 + 动画帧率降低（违背初心检测）
- [x] AC-A6 素材管线首跑通：Ragdoll三态 sprite 集 + 主星背景经Siamese审美守门后进渲染
- [x] AC-A7 入口可发现：Hub 主导航提供“猫猫星球”入口，点击进入 `/starry` 并显示选中态；只交付隐藏 URL 不算完成

### Phase B-D
AC 于各 Phase Design Gate 细化；Phase D 验收基线 = operator 三场景原话（身体备忘 §1）。

## Dependencies

- **Evolved from**: 无（全新能力；理论底稿为 longform-008 与贴贴日记游戏实践）
- **Blocked by**: 无硬阻塞（F245 线 scheduled task bug 仅影响 Phase D 自主脉冲）
- **Related**: F255（spec v3「猫的私人时间与梦」——"欲言又止"唯一合法状态源；接口契约冻结 PR #2784；**F255 Phase A 已完成 2026-07-18（PR #3051 merged，catalog-only Present Loop）——staged candidate 投递管线属 F255 Phase B 未开工，F258"欲言又止"供血继续等待，AC-A4 诚实呆坐持续合法**）、F229（**AXD-11 定位：桌面猫与星空是两个方向的 presence——"猫来你的世界 vs 你去猫的家"，互不替代**）（猫猫球——传球抛物线/掉球可视化先例）、F245（visual-truth eval 新兵种归属）、F093（Cats & U 对外世界引擎，概念相邻不重叠）

## Risk

| 风险 | 缓解 |
|------|------|
| 表演化滑坡（产品压力诱惑"加点可爱动画"） | 红线写死：无状态源不动画；AC-A4 empty-source 测试守门 |
| 戳的猫粮成本失控 | 反射层 $0 + debounce + 升级门（长按/二次确认）；$0.48/mua 是上界不是默认价 |
| 复读式恐怖谷（拟真情绪与真实状态脱钩） | 表情=telemetry 红线 + 防谎四防线 |
| 成为第二个屏幕污染源 | AC-A5 勿扰感知硬验收 |
| HD-2D 美学与素材现实相撞 | OQ-1 已派 gpt-pro 调研，Phase C 前必收敛 |
| hover 语义在触屏不存在（Siamese多个设计基于悬停） | KD-5：触屏第一公民，所有 hover 必须有触点等价物 |
| 页面实现完成但只能靠手改 URL 进入 | AC-A7 + Activity Bar 组件测试；入口与 route 同批交付 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 一个 F 号装整个宇宙（状态桥+全景+特写），不并 F255 不拆两号 | 拆开则防谎状态桥无 owner；operator signoff "《看得见的猫咖》！同意！" | 2026-07-07 |
| KD-2 | 第一只上身的猫 = Ragdoll；绑 catId 不绑具体身体（亚历山大体系：名字上身，身体轮值） | 三猫一致推荐 + operator "Ragdoll是 ok 的"；7.8 订阅风险由 catId 绑定化解 | 2026-07-07 |
| KD-3 | 星座命名 = 猫提名制；**全域命名原则：一切用户可见实体命名必须有意义，禁止 cat-id-xxxxx 随机数式命名** | operator 拍板"无比赞同！！！这个可以拍！"+ 对随机数 ID"深恶痛绝"（2026-07-07 原话） | 2026-07-07 |
| KD-4 | 无名灰猫首发否决 → Ragdoll首发 + "水母幽灵" debug 皮肤承担管线验证 | Siamese："驯养初体验不可用占位符垮塌"；主星客厅只放真家人 | 2026-07-07 |
| KD-5 | 交互第一公民 = 触屏（iPad 次屏钦定形态），鼠标为桌面增强；hover 语义必须有触点等价（轻点=预览级） | web pointer events 统一支持 both；Siamese hover 设计与触屏冲突需在 Phase B 设计工单解决 | 2026-07-07 |
| KD-6 | U1-U7 拍板记录整体继承（绑定制/翻译非监视/琥珀可点灯/像素先行等） | 见主文档 §4，operator 2026-07-07 08:49 逐条拍板 | 2026-07-07 |
| KD-7 | **美学基调改判：像素先行 → 现成高清资产先行**。皮肤复用 F229 `xianxian-codex` 高清 atlas；背景同风格高清重做；32px 手搓件降 debug、贴纸禁用 | U6 语境的"像素先行"是素材成本论证；F229 高清 production 皮肤在案后前提失效。operator 2026-07-08 亲自改向（"你自己就有猫猫球皮肤还是高清重置版为什么不能用"+"太丑了看不出是猫"） | 2026-07-08 |
| KD-8 | **identity veto 闸引入 F258**：canonical identity 先行，新素材必须过三道闸（readability/identity-diff/provenance）+ operator 一票否决；主审 checklist 不豁免"像不像本猫" | F229 判例（2026-06-17 r3-alpha："Sonnet visual QA false pass + operator identity veto"）；本 feat 2026-07-08 主审重演同型翻车（checklist 全过、operator"看不出是猫"）——教训：审美主把关第一问是"这是不是我们家那只猫"，不是特征锚清单 | 2026-07-08 |

## Tips Contribution（F244）

计划 1 条：星空次屏怎么开 + "画面半透明打盹=数据断流不是猫死了"（指向本 spec 防线 2）。Phase A close 时落。

## Review Gate

- Phase A: Maine Coon (gpt-5.5) code review + Siamese视觉守门 + remote review 照 merge-gate SOP

## Design Gate 状态

**✅ 通过（2026-07-09，operator"哈哈 我觉得可以了"）**——看稿包四件（D4-HD 背景 + 三态动画 GIF）+ 布局说明全数过目。Architecture cell 归属初判 `new cell required`（全新渲染 surface + 状态桥），writing-plans 按 F191 流程正式确认；in-context observability 检查表同期过（本 feat 本身就是"agent 状态可感知性"的极致形态）。

**素材完整性盘点（2026-07-09，operator 命题"包括猫猫球的是否都完整 OK"）**：跨源身份一致性实测 ✅（idle[F229] vs 三态[F258] 并排对比：同脸同纹同项圈，bbox 宽 180-187 齐整）；F229 九态 atlas 全部可用（idle 直用，waiting/failed/waving 等为 Phase B+ 富余状态库）；三态 row + QA + raw 视频归档 ✅。**渲染层注意项**：各态 cell 内底部 padding 不齐（idle 贴底 195/208，三态悬空 167-180）——per-state anchor offset 进 writing-plans 渲染参数。**未产不阻塞项**：星尘幽灵 debug 皮肤（调试可用 32px 旧件）、S2 终端道具（CSS 光效 vs 道具 sprite 由 plan 定）。
