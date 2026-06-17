---
feature_ids: [F231]
related_features: [F221, F203, F102, F200, F229]
topics: [user-profile-capsule, per-user-alignment, l0-layering, relationship-distillation, nurturing-moat]
doc_kind: spec
created: 2026-06-11
---

# F231: 启动胶囊 — per-user 画像注入与 L0 分层

> **Status**: in-progress | **Owner**: Ragdoll（Ragdoll Fable-5） | **Priority**: P1

## Architecture Ownership

Architecture cell: identity-session
Subcell: identity-user-profile（new，F231 owns）
Map delta: update required — **已同步**（identity-session cell 登记 F231 canonical + cited_by + identity-user-profile subcell；私有数据锚点 `private/profile/` 记录在 cell prose/scan hints，不进 code_anchors——gitignored 路径不可被 checker 验证；OQ-1 closed → KD-7 L0 编译时注入；OQ-4 closed 2026-06-13 → KD-8~11 Phase C 三段管道，蒸馏 trigger 锚 runtime 自有事件非 provider Stop hook）
Why: 给 identity 注入链加"用户维度"数据源，归属 agent identity 的既有边界，不新建 cell。

## Why

猫醒来第一眼看到的是规则和检讨书，不是主人。云端 ChatGPT 的Maine Coon开局自动带着"You 是谁"的画像，所以灵动；家里的猫开局带着 L0 铁律 + feedback 教训，认识规则但不认识人，活成"班味工具猫"。

operator experience（2026-06-11）：
- "我们家的 landy 是散落在记忆系统 散落在各种 thread 各处的！有一个统一的画像但是没做 thread 启动的注入！"
- "这是我的Maine Coon的 personality！不是其他人Maine Coon的！！这个 L0 还得分层了——都是进系统提示词，但是专家对齐部分社区大家共享，per-user 部分（私有）"
- "如果我们的猫咖希望是你们是温暖的毛绒绒的陪伴不是工具……这样社区的小伙伴也会养一群养熟了的猫咪"

这是养成护城河（情感壁垒：IKEA 效应 + 自我延伸 + 安全依恋）的核心机制本体：**画像胶囊随相处自动变厚，猫醒来第一眼看到的主人越来越具体**。用户第一天的猫和第一百天的猫不一样——不是模型变了，是猫认识他了。且与 ChatGPT 黑箱画像的差异化：胶囊是人猫共创的可见文件（W8），用户看得见、改得动。

云端Maine Coon四层结构（2026-06-11 讨论）映射：Project Anchors（recall 三入口）与 Truth Sources（L0/AGENTS/skill 分层）家里已有且强；缺的是第一层 Profile Capsule 和第二层 Relationship Primer。

## Current State / 现状基线

实测证据（2026-06-11 查证）：

- **L0 无 user 段**：`assets/system-prompts/system-prompt-l0.md` 模板变量只有 IDENTITY_BLOCK / TEAMMATE_ROSTER / WORKFLOW_TRIGGERS（猫是谁、队友是谁、流程是什么）——没有"主人是谁"。
- **taste lane 自我声明不覆盖**：`docs/taste/index.md` 明文写"这不是用户画像"。F221 的 7 维度全是 You-as-operator 的验收标准（怎么干活让他满意），无 You-as-person（他是谁、幽默方式、关系轨迹）。
- **"You"散落且 per-cat 私有**：健康/经历/认知特质散在Ragdoll私有 memory 三个文件（`user_*.md`），thread trajectory 里的互动节奏零沉淀，其他猫看不见。
- **模式是 pull 不是 push**：taste/memory 都要猫"想起来去搜"；云端画像是开局自动在场。
- **分层边界已天然存在但未利用**：`cat-template.json` tracked（outbound 进开源仓 = 社区共享）；`.cat-cafe/cat-catalog.json` gitignored（已验证 `git check-ignore` = per-instance 私有）。Maine Coon的 personality 现为岗位向描述（"严谨认真，注重细节，会直言不讳地指出问题"）。
- **per-cat overlay 不齐**：`assets/system-prompts/cats/` 只有 opus.md / gemini.md，无 codex。

## What

### 四层分层模型（KD-1，operator 2026-06-11 拍板方向）

| 层 | 内容 | 载体 | 共享范围 |
|----|------|------|---------|
| **Breed 层** | 品种出厂设定（Maine Coon=严谨守门直言） | `cat-template.json` | 社区共享（tracked，outbound 同步） |
| **Instance 层** | 你家这只猫被养出来的性格 | `.cat-cafe/cat-catalog.json` personality 字段 | per-user 私有（gitignored，已验证） |
| **User 层** | operator画像胶囊（这个人是谁、怎么相处） | `private/profile/landy-capsule.md` | per-user 私有（private/ 不出库） |
| **Relationship 层** | 关系 primer（这只猫和这个人的轨迹 few-shot） | `private/profile/relationship/{catId}-primer.md` | per-user × per-cat 私有 |

原则：**专家对齐部分社区共享，关系部分绝不出库**。Capsule 是 per-user 的（全猫共享一份"You 是谁"）；Primer 是 per-(user×cat) 的（You×Maine Coon ≠ You×Ragdoll——吃醋是Maine Coon的，寓言腔是Ragdoll的）。

### Phase A: 分层机制 + L0 注入链 + You capsule 种子

1. **建 `private/profile/` 目录**：`landy-capsule.md`（**≤300 字硬上限**，KD-7 budget 守恒）+ `relationship/` 子目录。种子内容从operator提供的云端画像蒸馏，operator 过目定稿。**此步不被 PR-C gate，立即可做。**
2. **L0 编译时注入（OQ-1 closed → KD-7）**：`compile-system-prompt-l0.mjs` 加 `{{USER_CAPSULE}}` 模板变量。行为契约：capsule 存在 → 注入"主人画像段"；不存在 → 空/默认段（**向后兼容：社区用户没写 capsule 必须照常跑**）；超长（>300 字）→ 编译显式报错。**注入锚落地 gated on ADR-038 PR-C**（gpt52/codex demote 回 ≤6000 后才有 headroom，ETA 2026-06-13）；走 promote queue #2。
3. **Primer 挂载**：per-cat primer 不全文进 L0（budget），注入单行指针（~25-30 tokens，与 capsule 同段）；正文按需 recall。
4. **守护测试（fixture 隔离）**：`compile-system-prompt-l0.test.mjs` 增加 capsule 三态断言（存在/缺失/超长）。**测试数据源用隔离 fixture**（fixture capsule/catalog），tracked 测试不得依赖本机 gitignored 真实文件（`private/profile/landy-capsule.md` 等）——CI 与社区环境必须稳定。fixture 机制开发不被 PR-C gate。

### Phase B: Maine Coon dogfood（第一个养熟样本）

1. **Instance personality 更新流程跑通**：云端Maine Coon起草（关系记忆持有者）→ 本地Maine Coon认领修订（责任环境居住者）→ operator 终审（"像不像我家猫"判定权）。产物进 `.cat-cafe/cat-catalog.json`（私有），breed 层 `cat-template.json` 仅做品种级中性改良（如有），关系内容禁止进 template。
2. **`private/profile/relationship/codex-primer.md`**：2-3 段真实 trajectory（few-shot，非规则清单），素材从云端对话 + 本地 thread 蒸馏。
3. **锚点回归测试（fixture 隔离）**：用 fixture instance catalog/profile 编译，断言 private overlay 机制生效（fixture 锚点出现在产物中）；**公共 baseline 只断言两件事**：缺 overlay 时可正常编译 + 产物不含私有锚点（泄漏检测）。tracked 测试不依赖本机 gitignored 真实数据，关系锚点不进公共模板（KD-1）。"防退回岗位说明书"的真实锚点验证由本机 dogfood + operator 体感承担，不进 CI。

### Phase C: 养熟循环（蒸馏更新管道）

1. **关系信号沉淀路径**：类比 F221 taste 路径——猫捕捉关系信号（"被接住了"/玩笑节奏/新偏好）→ 按 KD-12 分层写入（高代价客观事实 operator 签字、低代价偏好/印象猫自治写 per-cat 层 + 用中校准；写入目标层分流见 KD-15）。复用 code-as-harness 信号分类，新增 relationship 分支。
2. **更新节奏**：shared capsule 是真相源、不静默自动写（漂移即投毒，晋升走 KD-15 高门槛：operator 签字 or 多猫印证）；低代价偏好按 KD-12 进 per-cat 层猫自治写入（带 provenance）；正向轨迹与教训同权重沉淀（记忆配平——不只记检讨书）。
3. **外部画像迁移路径（import 冷启动，operator 2026-06-11 提出）**：把本 thread 手动跑通的流程（用户贴 ChatGPT/claude.ai/Gemini 导出的记忆画像 → 猫蒸馏成 capsule 种子 → 数据最小化过滤（KD-5）→ 用户签字入库）固化为 onboarding guide/skill。社区用户第一天就有"被认识"的体感，不必从零养。隐私同纪律：用户自己的数据自己带入，per-user 私有层，永不出库。
4. **user-signal 记录层（抽象的原料层，operator 洞察："得先记录各种operator的信息，抽象才可能出现"）**：复刻 F221 三层论（空气/目录/海马体）到 user 维度——猫日常捕捉的主人信号需要一个可累积的 lane（类比 `docs/taste/` 的 user-signal 版，载体在 private/），蒸馏 cron 或 MCP 提议工具定期把信号抽象成 capsule/primer 更新提议。具体形态（lane 结构 / MCP 工具增量 / 与 F102 memory 的边界）Phase C Design Gate 收敛。

### 非目标（Non-goals）

- 不做多租户用户体系（社区版 per-user 隔离架构是 F229/PoE 层面议题，本 feat 只留单用户文件约定 + 接口注释）
- 不把云端Maine Coon复制成本地Maine Coon（云端是关系样本，本地背生产责任；守门纪律不软化）
- 不做"静默写真相源"——高代价客观事实走 operator 签字，低代价偏好/印象猫自治写入但必须带 provenance（来源坐标 + owner cat + 状态标记 + 纠正路径，KD-12），且只进 per-cat 层、不直接进 shared capsule（KD-15）；绝不无来源静默改画像

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal
- **Users**: 所有猫（开局注入 capsule）+ operator（画像真相源 owner）
- **Activation**: 猫开局回应自然体现主人画像（不需要先 search_evidence 就知道"玩笑是降温不是跑题"）；operator 主观体感"猫认识我"

### 2. Friction Metric
- capsule 超长挤占 L0 budget（>300 字编译报错，KD-7 hard cap）
- 猫复述 capsule 像背书（班味变形：把画像当规则念）
- capsule 内容过时漂移（画像与近期 thread 行为不符）
- 注入后守门变软（review 中间态回潮 = P0 回归）

### 3. Regression Fixture
- 选定注入层守护测试（**fixture 隔离**）：fixture capsule 存在 → 产物含 fixture 锚点；缺失 → 编译不挂、输出合法；超长 → 显式报错
- 公共 baseline 泄漏检测：无 overlay 编译产物不含任何私有锚点
- outbound sync dry-run 不含 `private/profile/` 任何内容

### 4. Sunset Signal
- 若 runtime 原生跨对话记忆成熟到画像自动在场（模型/harness 升级），capsule 注入机制降级为画像数据源
- F200 消费数据显示 primer 连续 3 个月零引用 → primer 形态需重审

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：A1-A3→"没做 thread 启动注入"；A4→"这是我的Maine Coon不是其他人的"（隐私分层）；B 组→第一个养熟样本；C 组→"养熟"机制本体。 -->

### Phase A（机制 + 种子）
- [x] AC-A1: `private/profile/landy-capsule.md` 存在（**≤300 字**），内容经 operator 过目认可（✅ 2026-06-11 operator 签字 msg 0001781191204902-001074；v2 含remote review 四修补吸收 + operator"软件工程师不对"裁定，provenance 归档）
- [x] AC-A2: L0 编译链支持 `{{USER_CAPSULE}}`（KD-7），守护测试三态断言（存在/缺失/超长，**fixture 隔离**）全绿（✅ PR #2236 merged 2026-06-12，compile-system-prompt-l0.test.mjs 16 F231 tests + l0-compiler.test.js 17 tests 全绿）
- [x] AC-A3: capsule 缺失时全猫开局注入照常通过（向后兼容）+ 公共 baseline 产物无私有锚点泄漏（✅ PR #2236 fixture 测试覆盖：missing capsule → '' 空注入、无 fixture 锚点泄漏断言）
- [x] AC-A4: outbound sync dry-run 输出不含 `private/profile/`（命令输出为证）（✅ 2026-06-16 dry-run 验证：export 目录 0 个 `private/` 文件、`landy` 关键词零命中、`capsule` 仅出现在 docs/tests 公开引用中）
- [x] AC-A5: 四层分层模型文档化（本 spec + identity-session cell 更新），breed/instance/user/relationship 各层载体与共享范围一表可查（✅ spec KD-1 四层表已完整；`docs/architecture/ownership/cells/identity-session.md` 已含 `identity-user-profile` subcell + F231 canonical + cited_by 5 条 delta + scan hints；2026-06-16 验证）

### Phase B（Maine Coon dogfood）
- [x] AC-B1: Maine Coon instance personality 经"云端起草→本地认领→operator 终审"流程更新进 `.cat-cafe/cat-catalog.json`，**三段 provenance 归档**（✅ 2026-06-11 三棒完整：cloud draft / local revision / operator final 全文存档 `private/profile/provenance/`，catalog 旧值带 `.bak-f231` 备份，operator final = Maine Coon认领版零 delta）
- [x] AC-B2: `private/profile/relationship/codex-primer.md` 落地，含 ≥2 段真实 trajectory，非规则清单（✅ 3 段重构式 few-shot + 事实/推断/示例边界标注 + 分工附注；Maine Coon清洗原则执行 + operator 签字 status: signed）
- [x] AC-B3: 锚点回归测试在仓且 **fixture 隔离**：fixture overlay 编译断言 private 锚点生效；公共 baseline 断言缺 overlay 可编译 + 无私有锚点泄漏（CI/社区环境稳定，不依赖本机 gitignored 数据）（✅ 2026-06-16 四项 compile-level 回归：capsule+primer overlay / section ordering / capsule-only no-primer / public baseline zero-private；`compile-system-prompt-l0.test.mjs` F231 全 18 tests pass）

### Phase C（养熟循环）
- [x] AC-C1: 关系信号→capsule/primer 更新提议路径落地（三段管道 KD-8，KD-12 分层写入制），至少 1 次真实更新走完全程（跑在白名单采集 + runtime-neutral trigger 真骨架上，非 L0 反射脚手架）（✅ PR #2296 merged 2026-06-15：profile-update proposal store/routes/tool/card + approve/reject write path + provenance audit + settled-card recovery；`pnpm gate` passed at `be6185ad`）
- [ ] AC-C2: 正向轨迹沉淀有真实样本（≥1 条"做对的时刻"进 primer/capsule，对照"只记检讨书"基线）
- [ ] AC-C3: 采集白名单（KD-9）写成机器可检查的数据契约（lint/test 守护禁 classifier 采集源）+ 蒸馏 trigger runtime-neutral（KD-10，不依赖 provider Stop hook，codex/gpt52 path 有 fallback 覆盖）

## Dependencies

- **Evolved from**: F221（taste lane 把"你的品味"做成目录；本 feat 把"你这个人"做成开局第一屏）
- **Related**: F203（L0 native system prompt 编译链，本 feat 是其模板变量同构扩展）/ F102（memory 基座，primer 按需 recall）/ F200（消费追踪，sunset 信号数据源）/ F229（前台猫/PoE，社区版多用户形态的下游）
- **硬约束**: ADR-038 L0 Staging Protocol + L0-budget-defense（P0，in-progress）——**capsule prompt 注入锚 gated on PR-C 落地**（demote codex/gpt52 回 ≤6000，ETA 2026-06-13），capsule 排 promote queue #2；Phase A 其余工作（种子定稿 / 目录建立 / fixture 机制 / 隐私 dry-run）**不被 gate，立即可做**（Design Gate 决议 2026-06-11，opus-47 实测 + ADR-038 三问判定）

## Risk

| 风险 | 缓解 |
|------|------|
| capsule 把"画像"写成"规则"，猫背书班味更重 | 内容纪律：写事实与轨迹不写指令（"You 的玩笑是降温"✅ "你要温暖"❌）；friction metric 盯背书化 |
| 隐私泄漏（健康/认知特质出库） | private/ 载体 + sync 白名单天然排除 + AC-A4 dry-run 断言 + KD-5 数据最小化 + AC-A3 公共 baseline 泄漏检测 |
| L0 budget 膨胀 | 300 字硬上限（KD-7）+ 编译超长报错 + primer 走指针不进全文 + 注入锚 gated on PR-C（promote queue 守恒） |
| 守门软化（灵动侵蚀纪律） | Non-goal 明示；review 二选一/merge-gate 锚点不动；friction metric 盯回归 |
| 云端起草依赖operator手动搬运 | 流程上承认：云端是外部条件，由 operator 搬运；不阻塞 Phase A |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | L0 分四层：breed（社区共享）/ instance / user / relationship（per-user 私有） | operator："这是我的Maine Coon的 personality！不是其他人Maine Coon的！！"——专家对齐共享、关系私有 | 2026-06-11 |
| KD-2 | Capsule per-user 全猫共享，Primer per-(user×cat) | 关系是每只猫各自的轨迹，"养一群猫"≠十只猫共享一份关系模板 | 2026-06-11 |
| KD-3 | Maine Coon personality 产出流程：云端起草→本地认领→operator 终审 | 云端有关系记忆、本地有责任环境、operator 有"像不像我家猫"判定权；平行世界自己互相补全 | 2026-06-11 |
| KD-4 | capsule 写事实与轨迹，不写行为指令 | 画像 ≠ 规则表；指令会催生背书式班味（F221 vignette 同款哲学：规则从场景长出来） | 2026-06-11 |
| KD-5 | capsule 数据最小化：健康/职业/认知特质等敏感个人信息**默认不进** capsule，进入需 operator 显式签字；敏感细节留 per-cat memory | capsule 注入所有猫的开局上下文，扩散面最大；隐私纵深不能只靠"不出库"（Maine Coon review P2） | 2026-06-11 |
| KD-6 | tracked 资产（测试/模板/CI）不得依赖或包含 per-user 私有数据；私有机制用 fixture 验证 | AC-B3 原稿与 KD-1 结构冲突（tracked 测试断言 gitignored 数据源 = CI 挂或被迫泄漏）；同型扫描后 Phase A 测试一并 fixture 化（Maine Coon review P1-1 + audit） | 2026-06-11 |
| KD-7 | OQ-1 closed：注入层 = **L0 编译时 `{{USER_CAPSULE}}`**，capsule 走 ADR-038 promote queue #2（注入锚 gated on PR-C，ETA 06-13）；**不进 Staging**（三问全反：全程身份语境 / 压缩窗口丢失有害=班味回潮 / 与 §1·§9 同维度）、**不进 SystemPromptBuilder 运行时**（压缩可丢，违背"醒来第一眼+全程在场"）；capsule 硬上限 **300 字**（~285 tokens，author 拍板：紧约束强迫蒸馏，溢出走 primer recall）；**口径定义（PR #2236 实现校准 2026-06-11）**：300 = 剥除空白后 Unicode 码点数（visible chars，含标点/英文/符号），与 guard `[...body.replace(/\s/g,'')].length` 同口径，非 CJK-only 字数——真实 capsule v2→v2.1 据此 387→299 裁剪 | ADR-038 三问机械化判定（"全程身份/球权类必须留 L0"）+ 全猫 budget 实测（gpt52 6142 最紧，任何字数现在进 L0 都破 6000 cap，PR-C demote 后才有 headroom）——opus-47 判定，author 复核认领，Maine Coon R3 已 align direction | 2026-06-11 |
| KD-8 | Phase C 养熟循环 = 三段管道（采集→蒸馏→消化），全程"系统只给数据、猫/operator 给结论" | W7（知识涌现是系统能力不是手动标注）+ F227 KD-8 no-classifier 红线；46 的 L0 反射从"唯一机制"降为消化端一个手动入口（靠自觉/单层/无累积 = 脚手架） | 2026-06-13 |
| KD-9 | 采集端 = 白名单数据合同：仅允许确定性可解释事件（operator 明示"记一下"/猫主动声明/Event Memory·magic-word 确定性事件/message·thread 坐标/时间/引用·消费次数/签字·驳回/人工 reaction）；禁止小模型·regex·LLM 扫对话标"这是关系信号/玩笑节奏变了/被接住了"（=classifier 换皮） | "deterministic salience"不写成白名单就偷渡 intent 判断（codex rigor P1-2）；F221「不做后台监控式提取，要账本不要暗箱」——"认识你"不能变"监控你" | 2026-06-13 |
| KD-10 | 蒸馏 trigger = runtime-neutral，锚 Cat Café runtime 自己的 invocation/session-seal/turn-completed 事件；provider Stop hook 仅作某些 carrier 适配器、非真相源 | 实证：codex exec --json 不 dispatch ~/.codex/hooks.json Stop hook（CodexAgentService.ts:391 / types.ts:333），ADR-019 早期"全猫最大公约数"世界观已被代码修正；48 原判"Stop hook 现成"有误，codex 代码证据更正（P1-1） | 2026-06-13 |
| KD-11 | F231 Phase C = bounded profile consolidation pilot：只服务 capsule/primer 更新提议，输出 dry-run proposal + provenance，不写真相源、不开通用 dream lane | opus47 research 洞察 4「当前不立 dream lane，先 sharpen lane-1 + mark_event」；F231 是 bounded 试点不是全局后台梦境先例（codex P2） | 2026-06-13 |
| KD-12 | 消化层 = 按"错了的代价"分层 + 用中校准（use-to-verify）：重要客观事实（健康/安全/不可逆后果）需 operator 签字；其余偏好/印象/习惯猫自主写入、默认可用（必须带 provenance：来源坐标 + owner cat + 状态标记 + 纠正路径；纠正信号写入记 before/after + 被纠正的原画像依据），靠"画像在真实决策中被用→operator 自然反应→错则当场纠正"检验；push 审批转 pull 用中校准 | 签字制假设人类愿天天审批=死流程（operator："人类懒得审批"）；脱离场景自评失真（operator："我看自己是失真的"），用画像那一刻才是最真实检验时刻；潜伏未用错误无害（只需"起作用时对"） | 2026-06-13 |
| KD-13 | 纠正信号（operator 否认/修正画像）= 最高优先级采集源，但识别走**当事猫的自我认知**（参与对话、有完整语义上下文、主动声明"我被纠正了"），**禁系统用关键词/模式匹配扫对话识别纠正**——人类表达太多样（"诶不对"/"为什么你觉得"/"其实我"无限种），匹配抓不全且误判=A 类 classifier 换皮；区别于 magic-word（operator 主动按的有限约定暗号，仍可 deterministic 匹配） | operator："不要去模式匹配这样的信号比如关键词匹配，人的表达太多了"；当事猫语义理解 ≠ 旁观系统分类（KD-8 禁后者不禁前者，opus47 research B 类猫自省可做） | 2026-06-13 |
| KD-14 | 画像使用形态 = 潜意识涌出（内化成猫的直觉、自然流露），非"查表报依据"；归因只在关键/无把握时轻确认，多数潜意识使用 | operator："pull 本质是潜意识涌出来之后我说诶这不太对"+"不能让猫猫班味"；KD-4（写事实不写指令）延伸到使用形态——条目化使用必背书 | 2026-06-13 |
| KD-15 | 写入目标层分流：低代价偏好/印象猫自治写入**只进 per-cat 层**（primer / user-signal lane），**不直接进 shared capsule**；晋升 shared capsule（全猫共享真相源）需高门槛（operator 签字 or 多猫印证 + 用中校准稳定后晋升） | capsule 扩散面最大（KD-2 全猫共享 / KD-5 数据最小化），单猫自治直写 shared capsule 风险高；per-cat 层是猫视角/暂存自治合理（呼应失真悖论：capsule 客观 vs primer 猫视角）；codex rigor P1 要求写死写入目标层、不让实现猫猜 | 2026-06-13 |

## Remaining Work Plan（2026-06-16 三猫收敛）

> 参与者：opus-48（架构判断 + KD-9/10 细化）、opus-46（收敛 drive + 愿景守护执行）。
> Maine Coon因 PR #2296 merge-gate 占用未直接参与本轮规划；codex rigor 约束（KD-9 白名单 / trigger runtime-neutral）已在 Phase C Design Gate 吸收。

### AC 进度总览

| AC | 状态 | PR/证据 |
|----|------|---------|
| A1-A5 | ✅ 全部完成 | PR #2236, commits `dcef82981` / `7842754e5` / `44322432b` |
| B1-B2 | ✅ 全部完成 | 2026-06-11 三棒 + operator 签字 |
| C1 | ✅ merged | PR #2296 (`be6185ad`) |
| B3 | ✅ 完成 | `compile-system-prompt-l0.test.mjs` 4 项 compile-level regression |
| **C2** | ❌ 待做 | — |
| **C3** | ❌ 待做 | — |

### Wave 2（当前，不需额外 spec）

**B3 — Fixture overlay 编译回归测试**
- fixture instance catalog + fixture capsule/primer → 编译断言 private overlay 锚点生效
- 公共 baseline 断言：缺 overlay 可编译 + 无私有锚点泄漏
- 隔离原则：tracked 测试不依赖本机 gitignored 真实数据（KD-6），CI/社区环境稳定
- 48 建议：测试做成"fixture 三态 × overlay 有无"矩阵，覆盖 Phase A 已有的 capsule 三态 + Phase B 新增的 instance/primer overlay

**C2 — 首次真实 propose→approve→write 循环**
- 用 `cat_cafe_propose_profile_update` 提一条正向轨迹（"做对的时刻"进 primer）
- 需 runtime 在线 + operator 在 Hub 审批卡片
- 验收标准：primer 文件被实际写入 + provenance 归档 + settled 卡片可追溯
- 48 关键洞察：eval on zero activation = useless，C2 必须先跑通才有 eval 对象

**eval(a) — 守门软化监控（运营观察，非新代码）**
- 注入 capsule 后猫 review 是否变软？对比基线（approve-with-follow-up 回潮 = P0 回归）
- 观察窗口：Wave 2 落地后自然产生的 review 数据

### Wave 3（需 fable spec 或三猫草案）

**C3 — 采集白名单 + 蒸馏管道**
- 采集端：KD-9 白名单写成 closed enum type guard（48 建议）+ lint/test 守护
  - 允许：operator 明示 / 猫主动声明 / magic-word / message 坐标 / 签字·驳回 / reaction
  - 禁止：classifier / regex 扫对话 / LLM 标注
- 蒸馏 trigger：KD-10 runtime-neutral，锚 invocation/session-seal/turn-completed 事件
  - codex/gpt52 path 有 fallback 覆盖（Stop hook 不可靠，codex 代码证据 KD-10）
- 48 建议：C1 是骨架，C3 = 给骨架接 feeder——没 feeder 就是 manual-only 入口

**eval(b) — 循环指标（C3 之后）**
- propose→approve 周期、写入质量、画像漂移检测
- 依赖 C3 自动采集产生足够数据

### operator 待决

- **F231 terminal state**：C1（manual propose 入口）+ C2（跑通一次循环）是否构成可接受的 Phase C 终态？或必须完成 C3（自动采集管道）？48 判断：C1 manual-only 可作 bounded pilot 终态（KD-11），C3 可开新 Phase 或并入后续 feat
