---
feature_ids: [F231]
related_features: [F221, F203, F102, F200, F229, F260, F263]
topics: [user-profile-capsule, per-user-alignment, l0-layering, relationship-distillation, nurturing-moat]
doc_kind: spec
created: 2026-06-11
tips_exempt: agent-facing authenticated profile read is reached from the L0 logical pointer; no user action or standalone capability-tip surface
---

# F231: 启动胶囊 — per-user 画像注入与 L0 分层

> **Status**: in-progress (Phase C 功能性完成；Phase D topology 代码已合入；live migration apply 暂停——relationship granularity 于 2026-07-12 重新打开，不能再把 individual primer 冲突预设为待合并内容) | **Owner**: Ragdoll（Ragdoll Fable-5）；topology repair owner: Maine Coon Sol | **Priority**: P1

## Architecture Ownership

Architecture cell: identity-session
Subcell: identity-user-profile（new，F231 owns）
Map delta: update required — **已同步**（identity-session cell 登记 canonical repository / shared contract / authenticated read surface；真实私有内容不进 tracked `code_anchors`；legacy `private/profile/` 只保留 migration scan hint）
Why: 给 identity 注入链加"用户维度"数据源，归属 agent identity 的既有边界，不新建 cell。

## Why

猫醒来第一眼看到的是规则和检讨书，不是主人。云端 ChatGPT 的Maine Coon开局自动带着"You 是谁"的画像，所以灵动；家里的猫开局带着 L0 铁律 + feedback 教训，认识规则但不认识人，活成"班味工具猫"。

operator experience（2026-06-11）：
- "我们家的 landy 是散落在记忆系统 散落在各种 thread 各处的！有一个统一的画像但是没做 thread 启动的注入！"
- "这是我的Maine Coon的 personality！不是其他人Maine Coon的！！这个 L0 还得分层了——都是进系统提示词，但是专家对齐部分社区大家共享，per-user 部分（私有）"
- "如果我们的猫咖希望是你们是温暖的毛绒绒的陪伴不是工具……这样社区的小伙伴也会养一群养熟了的猫咪"

这是养成护城河（情感壁垒：IKEA 效应 + 自我延伸 + 安全依恋）的核心机制本体：**画像胶囊随相处自动变厚，猫醒来第一眼看到的主人越来越具体**。用户第一天的猫和第一百天的猫不一样——不是模型变了，是猫认识他了。且与 ChatGPT 黑箱画像的差异化：胶囊是人猫共创的可见文件（W8），用户看得见、改得动。

云端Maine Coon四层结构（2026-06-11 讨论）映射：Project Anchors（recall 三入口）与 Truth Sources（L0/AGENTS/skill 分层）家里已有且强；缺的是第一层 Profile Capsule 和第二层 Relationship Primer。

## User Journey

**Scope unit**: per-user alignment — the primer capsule that a cat reads at the start of every session to recognize its specific operator.

**Flow**:

1. **Session start** — L0 system prompt compiled with user-specific primer injected (`USER_CAPSULE` block). Cat wakes up knowing who the user is: their background, preferences, notable interactions, and ongoing context — not just generic rules.
2. **Organic interaction** — As sessions proceed, the cat observes operator behavior: stated preferences, corrections, approvals, personal context shared. Signals accumulate across threads.
3. **Cat proposes update** — When a signal crosses the threshold (repeat correction × 2, explicit "remember this", milestone shared), the cat calls `cat_cafe_propose_profile_update`, which creates a proposal card in the Approval Hub.
4. **operator reviews in Hub** — In the "待审批" tab, the proposal appears with rationale and the proposed primer delta. operator can approve (writes to primer immediately) or reject (logged, not applied).
5. **Approval history** — Settled proposals (approved/rejected) appear in the "历史" tab of the Approval Hub (F246 Phase H), so the operator can see which signals shaped the current primer.
6. **Next session** — Compiled L0 emits the stable current-persona URI; the cat resolves it through the authenticated read tool and naturally reflects the accumulated relationship — same persona, richer recognition.

**User-perceivable outcome**: Cat remembers the user across sessions organically, without manual configuration. The relationship deepens automatically — same IKEA effect as customizing a home.

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
| **User 层** | operator画像胶囊（这个人是谁、怎么相处） | `${CAT_CAFE_DATA_DIR}/profiles/<userId>/landy-capsule.md` | per-user 私有（data root 不出库） |
| **Relationship 层** | 关系 primer（这个 persona 和这个人的轨迹 few-shot） | `${CAT_CAFE_DATA_DIR}/profiles/<userId>/relationship/<relationshipKey>-primer.md` | per-user × per-persona 私有 |

原则：**专家对齐部分社区共享，关系部分绝不出库**。Capsule 是 per-user 的（全猫共享一份"You 是谁"）；Primer 是 per-(user×persona) 的（You×Maine Coon ≠ You×Ragdoll；同 persona 的新型号继承关系连续性）。

### Phase A: 分层机制 + L0 注入链 + You capsule 种子

1. **建 `private/profile/` 目录**：`landy-capsule.md`（**≤300 字硬上限**，KD-7 budget 守恒）+ `relationship/` 子目录。种子内容从operator提供的云端画像蒸馏，operator 过目定稿。**此步不被 PR-C gate，立即可做。**
2. **L0 编译时注入（OQ-1 closed → KD-7）**：`compile-system-prompt-l0.mjs` 加 `{{USER_CAPSULE}}` 模板变量。行为契约：capsule 存在 → 注入"主人画像段"；不存在 → 空/默认段（**向后兼容：社区用户没写 capsule 必须照常跑**）；超长（>300 字）→ 编译显式报错。**注入锚落地 gated on ADR-038 PR-C**（gpt52/codex demote 回 ≤6000 后才有 headroom，ETA 2026-06-13）；走 promote queue #2。
3. **Primer 挂载**：persona primer 不全文进 L0（budget），注入 `cat-cafe-profile://relationship/current` 单行指针；正文通过认证工具按需 recall。
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

### Phase D: Profile topology repair（2026-07-10 reopened）

把 profile 用户数据从 worktree-local `private/profile/` 迁到 `CAT_CAFE_DATA_DIR/profiles/<userId>/`，并落实 KD-18 的 persona relationship identity。`catId` 继续负责路由，model identity 继续负责 F208 能力画像，relationship primer 改由显式 `relationshipKey` 寻址。L0 只发 `cat-cafe-profile://relationship/current`，由 authenticated Clowder AI read surface 从 principal 投影 `userId + relationshipKey` 后解引用；不再暴露 cwd-relative 或 host-absolute 文件坐标。

**2026-07-12 粒度重开**：真实 dry-run 中 `maine-coon` / `ragdoll` 各三份不同 hash，原计划把它们视为“同一 family truth 的内容冲突”；operator 质询指出差异也可能是**不同猫之间真实关系轨迹**，family-collapse 本身才是错误坐标。迁移在 OQ-7 关闭前只允许 dry-run，禁止要求 operator 把六份 individual primer 人工揉成两份 family primer。当前推荐候选是“稳定 individual persona 为主键 + 可选 family shared layer”：关系不跟易变 model string 走，也不把 Fable / Opus 4.6 / Opus 4.7 / Opus 4.8 / Sonnet 强并为一只猫；模型升级但猫身份连续时沿用 persona，新命名个体则拥有自己的 primer。

### 非目标（Non-goals）

- 不做多租户用户体系（社区版 per-user 隔离架构是 F229/PoE 层面议题，本 feat 只留单用户文件约定 + 接口注释）
- 不把云端Maine Coon复制成本地Maine Coon（云端是关系样本，本地背生产责任；守门纪律不软化）
- 不做"静默写真相源"——高代价客观事实走 operator 签字，低代价偏好/印象猫自治写入但必须带 provenance（来源坐标 + proposer cat + 状态标记 + 纠正路径，KD-12），且只进 persona relationship 层、不直接进 shared capsule（KD-15）；绝不无来源静默改画像

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
- [x] AC-C2: 正向轨迹沉淀有真实样本（≥1 条"做对的时刻"进 primer/capsule，对照"只记检讨书"基线）（✅ 2026-06-17 proposal_mqg11vxc8ypclgv4：3 条正向轨迹 opus-primer.md + operator approve + provenance 归档；但 operator 指出 C1 merged 2 天零有机使用 → C3 必须做不可后置）
- [x] AC-C3: 采集白名单（KD-9）写成机器可检查的数据契约（lint/test 守护禁 classifier 采集源）+ 蒸馏 trigger runtime-neutral（KD-10，不依赖 provider Stop hook，codex/gpt52 path 有 fallback 覆盖）（✅ 2026-06-17 `b6de921f0`：COLLECTION_SIGNAL_KINDS 6 种白名单 frozen enum + isAllowedCollectionSignal() type guard + 4 OTel eval counters (proposed/approved/rejected/distillation_triggered) + ProfileDistillationTrigger.onSessionSealed() + SessionSealer.registerPostSealHook() 机制；13 tests RED→GREEN）

### Phase D（canonical profile topology）

- [x] AC-D1: capsule / relationship primer / provenance 的唯一 canonical root 是 `CAT_CAFE_DATA_DIR/profiles/<encoded-userId>/`；源码无 `cwd-first` / script-relative / existence-based profile root selection。
- [x] AC-D2: relationship identity 使用显式 `CatConfig.relationshipKey` 投影；普通 breed 默认自身 id，独立/version breed 显式声明 family key，不从 model/client/displayName 推断；`catId` / model / relationship 三层边界有 loader/repository 类型与测试。
- [x] AC-D3: L0 cache 按 `userId + catId` 隔离，并在 capsule/persona-primer bytes 变化时失效；不同 cwd 编译同一 scope 得到同一 logical profile URI。
- [x] AC-D4: L0 不再输出 `private/profile/...` 或 host absolute path；`cat_cafe_read_profile` 以 callback/agent-key auth 解引用 caller 自己的 persona primer，拒绝 cross-persona/cross-user 输入。
- [x] AC-D5: propose→approve→write→provenance 全链只经同一 `FileProfileRepository`，现有 optimistic lock / crash recovery / idempotency 回归绿。
- [ ] AC-D6: migration 代码已支持 dry-run、backup、byte-identical dedupe、hash-guarded conflict resolution、rerun与防覆盖 rollback；真实 dry-run 已发现两组 family target 下各三份不同 hash并保持零写入。**live apply 先等 OQ-7 决定 relationship granularity，而不是先等 operator 合并 collision content**；若选 individual persona，迁移计划必须重新投影 target manifest，并只对同一 individual target 的真实冲突请求内容签字。
- [x] AC-D7: ADR-031 三层闭环：soft（迁移/读取说明）+ hard（path/cache/auth/migration tests + no-legacy-pointer guard）+ eval（pointer emitted/resolved/missing counters）。

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
| KD-2 | Capsule per-user 全猫共享，Primer per-(user×persona)（KD-18 精炼：原 per-catId → per-breedId/family） | 关系是每只猫各自的轨迹，"养一群猫"≠十只猫共享一份关系模板；但同一家族（Ragdoll/Maine Coon/Siamese）共享一份 primer——日常相处是认家族不认型号 | 2026-06-11 |
| KD-3 | Maine Coon personality 产出流程：云端起草→本地认领→operator 终审 | 云端有关系记忆、本地有责任环境、operator 有"像不像我家猫"判定权；平行世界自己互相补全 | 2026-06-11 |
| KD-4 | capsule 写事实与轨迹，不写行为指令 | 画像 ≠ 规则表；指令会催生背书式班味（F221 vignette 同款哲学：规则从场景长出来） | 2026-06-11 |
| KD-5 | capsule 数据最小化：健康/职业/认知特质等敏感个人信息**默认不进** capsule，进入需 operator 显式签字；敏感细节留 per-cat memory | capsule 注入所有猫的开局上下文，扩散面最大；隐私纵深不能只靠"不出库"（Maine Coon review P2） | 2026-06-11 |
| KD-6 | tracked 资产（测试/模板/CI）不得依赖或包含 per-user 私有数据；私有机制用 fixture 验证 | AC-B3 原稿与 KD-1 结构冲突（tracked 测试断言 gitignored 数据源 = CI 挂或被迫泄漏）；同型扫描后 Phase A 测试一并 fixture 化（Maine Coon review P1-1 + audit） | 2026-06-11 |
| KD-7 | OQ-1 closed：注入层 = **L0 编译时 `{{USER_CAPSULE}}`**，capsule 走 ADR-038 promote queue #2（注入锚 gated on PR-C，ETA 06-13）；**不进 Staging**（三问全反：全程身份语境 / 压缩窗口丢失有害=班味回潮 / 与 §1·§9 同维度）、**不进 SystemPromptBuilder 运行时**（压缩可丢，违背"醒来第一眼+全程在场"）；capsule 硬上限 **300 字**（~285 tokens，author 拍板：紧约束强迫蒸馏，溢出走 primer recall）；**口径定义（PR #2236 实现校准 2026-06-11）**：300 = 剥除空白后 Unicode 码点数（visible chars，含标点/英文/符号），与 guard `[...body.replace(/\s/g,'')].length` 同口径，非 CJK-only 字数——真实 capsule v2→v2.1 据此 387→299 裁剪 | ADR-038 三问机械化判定（"全程身份/球权类必须留 L0"）+ 全猫 budget 实测（gpt52 6142 最紧，任何字数现在进 L0 都破 6000 cap，PR-C demote 后才有 headroom）——opus-47 判定，author 复核认领，Maine Coon R3 已 align direction | 2026-06-11 |
| KD-8 | Phase C 养熟循环 = 三段管道（采集→蒸馏→消化），全程"系统只给数据、猫/operator 给结论" | W7（知识涌现是系统能力不是手动标注）+ F227 KD-8 no-classifier 红线；46 的 L0 反射从"唯一机制"降为消化端一个手动入口（靠自觉/单层/无累积 = 脚手架） | 2026-06-13 |
| KD-9 | 采集端 = 白名单数据合同：仅允许确定性可解释事件（operator 明示"记一下"/猫主动声明/Event Memory·magic-word 确定性事件/message·thread 坐标/时间/引用·消费次数/签字·驳回/人工 reaction）；禁止小模型·regex·LLM 扫对话标"这是关系信号/玩笑节奏变了/被接住了"（=classifier 换皮） | "deterministic salience"不写成白名单就偷渡 intent 判断（codex rigor P1-2）；F221「不做后台监控式提取，要账本不要暗箱」——"认识你"不能变"监控你" | 2026-06-13 |
| KD-10 | 蒸馏 trigger = runtime-neutral，锚 Clowder AI runtime 自己的 invocation/session-seal/turn-completed 事件；provider Stop hook 仅作某些 carrier 适配器、非真相源 | 实证：codex exec --json 不 dispatch ~/.codex/hooks.json Stop hook（CodexAgentService.ts:391 / types.ts:333），ADR-019 早期"全猫最大公约数"世界观已被代码修正；48 原判"Stop hook 现成"有误，codex 代码证据更正（P1-1） | 2026-06-13 |
| KD-11 | F231 Phase C = bounded profile consolidation pilot：只服务 capsule/primer 更新提议，输出 dry-run proposal + provenance，不写真相源、不开通用 dream lane | opus47 research 洞察 4「当前不立 dream lane，先 sharpen lane-1 + mark_event」；F231 是 bounded 试点不是全局后台梦境先例（codex P2） | 2026-06-13 |
| KD-12 | 消化层 = 按"错了的代价"分层 + 用中校准（use-to-verify）：重要客观事实（健康/安全/不可逆后果）需 operator 签字；其余偏好/印象/习惯猫自主写入、默认可用（必须带 provenance：来源坐标 + owner cat + 状态标记 + 纠正路径；纠正信号写入记 before/after + 被纠正的原画像依据），靠"画像在真实决策中被用→operator 自然反应→错则当场纠正"检验；push 审批转 pull 用中校准 | 签字制假设人类愿天天审批=死流程（operator："人类懒得审批"）；脱离场景自评失真（operator："我看自己是失真的"），用画像那一刻才是最真实检验时刻；潜伏未用错误无害（只需"起作用时对"） | 2026-06-13 |
| KD-13 | 纠正信号（operator 否认/修正画像）= 最高优先级采集源，但识别走**当事猫的自我认知**（参与对话、有完整语义上下文、主动声明"我被纠正了"），**禁系统用关键词/模式匹配扫对话识别纠正**——人类表达太多样（"诶不对"/"为什么你觉得"/"其实我"无限种），匹配抓不全且误判=A 类 classifier 换皮；区别于 magic-word（operator 主动按的有限约定暗号，仍可 deterministic 匹配） | operator："不要去模式匹配这样的信号比如关键词匹配，人的表达太多了"；当事猫语义理解 ≠ 旁观系统分类（KD-8 禁后者不禁前者，opus47 research B 类猫自省可做） | 2026-06-13 |
| KD-14 | 画像使用形态 = 潜意识涌出（内化成猫的直觉、自然流露），非"查表报依据"；归因只在关键/无把握时轻确认，多数潜意识使用 | operator："pull 本质是潜意识涌出来之后我说诶这不太对"+"不能让猫猫班味"；KD-4（写事实不写指令）延伸到使用形态——条目化使用必背书 | 2026-06-13 |
| KD-15 | 写入目标层分流：低代价偏好/印象猫自治写入**只进 per-cat 层**（primer / user-signal lane），**不直接进 shared capsule**；晋升 shared capsule（全猫共享真相源）需高门槛（operator 签字 or 多猫印证 + 用中校准稳定后晋升） | capsule 扩散面最大（KD-2 全猫共享 / KD-5 数据最小化），单猫自治直写 shared capsule 风险高；per-cat 层是猫视角/暂存自治合理（呼应失真悖论：capsule 客观 vs primer 猫视角）；codex rigor P1 要求写死写入目标层、不让实现猫猜 | 2026-06-13 |
| KD-16 | `ProfileDistillationTrigger.onSessionSealed` Phase C 实现边界 = observability-only（trigger counter +1 + return 0），signal harvest 由猫主动调 `cat_cafe_propose_profile_update` MCP tool 完成；spec C3 "采集白名单 + 蒸馏管道"读起来像完整 auto-harvest 实际是"白名单 + 观察 trigger + 手动入口"两步实现 | KD-11 bounded pilot 设计内合理简化（"不开通用 dream lane"），不是 dead code；记录边界避免后续 reader 误判 auto-harvest 已就绪；opus-47 trace runtime data flow 时发现，Maine Coon独立 trace 同结论建议写入 spec | 2026-06-18 |
| KD-17 | OQ-5 closed：画像注入第三级 = **静态 capsule + profile index + 动态 recall**。L0 常驻只保留 ≤300 字 capsule（身份锚）+ primer 指针；画像正文、per-cat primer、user-signal lane 进入可索引 profile corpus；每轮按当前任务/上下文动态召回相关片段注入。入库判断仍走 KD-8/KD-12/KD-15，注入判断只做相关性检索，不重新判断"什么算画像"；敏感/高代价事实可入索引但默认不自动召回，除非 operator 显式签字或当前任务强相关。 | operator 2026-06-18："很多的可以变成索引类似的？甚至可能需要动态 recall" + "我是 我觉得ok的"。这保留"醒来第一眼看到主人"的 capsule 体验，同时避免画像变厚后挤爆 L0；把 50k→5k→500 的第三级从静态堆 prompt 改成可验证 retrieval。实现细节（index schema / scorer / 注入位置 / eval 指标 / F102/F200 接法）猫猫自决。 | 2026-06-18 |
| KD-18 | Relationship primer keyed by **persona/family (`relationshipKey`)**，不是 per-catId 或 UI grouping breed。家猫三族：Ragdoll=ragdoll（所有 Claude 猫）、Maine Coon=maine-coon（所有 GPT 猫）、Siamese=siamese（所有 Gemini 猫）。外部平台猫 identity 跟平台走不跟底层模型走：斑斑=bengal（AGY/Google Agent 平台，底层虽为 Opus 但 identity 是Bengal）、金渐层=golden-chinchilla（opencode 平台）。实现显式投影 `relationshipKey = CatConfig.relationshipKey`：普通 breed 默认自身 id，独立/version breed 必须显式声明 family key；禁止从 model/client/displayName 推断。现有 `{catId}-primer.md` 通过可审计迁移收敛为 `{relationshipKey}-primer.md`，不允许 alias 覆盖冲突。**精炼 KD-2**：Primer 从 per-(user×catId) 收敛为 per-(user×persona/family)。 | operator 2026-07-10：“Ragdoll = claude 家的猫猫 Maine Coon = gpt 家的猫猫，我认可的”——日常相处按家族称呼，catId 区分只在干活分工时；外部平台猫 identity 跟平台走（“斑斑现在是用谷歌家 agent 的 opus！opencode 的猫无论接谁 = 金渐层”） | 2026-07-10 |
| KD-19 | Profile truth 离开 worktree：canonical root = `CAT_CAFE_DATA_DIR/profiles/<userId>/`；L0 用 logical URI + authenticated resolver，不保留 cwd fallback、不发 host absolute path。 | 2026-07-10 live evidence：source/runtime 两套 gitignored profile root 已分叉，approved Sol primer 在 runtime 存在但 source-cwd pointer ENOENT；fallback/absolute path 只能换一种方式延续拓扑耦合。 | 2026-07-10 |

> **KD-18 reopen notice（2026-07-12）**：保留 2026-07-10 的历史决策与代码 provenance，但暂停其“所有同家族猫合并为一个 relationshipKey”的迁移解释。operator 正在重评 family identity 与 individual relationship 的层级；OQ-7 关闭前，KD-18 只证明“关系不应跟 raw model 能力画像混为一谈”，不授权 family-collapse live apply。

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
| C2 | ✅ 完成 | `proposal_mqg11vxc8ypclgv4` operator approved，但 2 天零有机使用 → C3 必须 |
| **C3** | ✅ merged | PR #2354 (`37f7dedc`) — KD-9 whitelist enum + KD-10 eval counters + distillation trigger |

### Wave 2 ✅（已完成）

- **B3 — Fixture overlay 编译回归测试** ✅ `compile-system-prompt-l0.test.mjs` 4 项 regression
- **C2 — 首次真实 propose→approve→write 循环** ✅ `proposal_mqg11vxc8ypclgv4` operator approved
- **eval(a) — 守门软化监控** ⏳ 运营观察中，无新代码需求

### Wave 3 ✅（C3 已完成，eval 观察中）

- **C3 — 采集白名单 + 蒸馏管道** ✅ PR #2354 merged — KD-9 whitelist enum + eval counters + distillation trigger
- **eval(b) — 循环指标** ✅ 有机使用确认（7/3）：Maine Coon自然触发 `propose_profile_update`×2（codex-primer + opus-primer，operator 均 approved）；激活修复生效

### 激活问题（2026-06-26 诊断 + 修复）

**现象**：C3 merged 后 8 天（6/18→6/26），`profile_update.proposed` counter = 0，零有机使用。
**operator 6/17 诊断**："功能不在大猫猫们的认知路径上" + "harness = 软 + 硬 + eval，缺 eval + 缺自动 trigger = dead code on shelf"
**根因**：L6 wakeup entry 太抽象（"发现operator偏好变化"需要猫自我判断，对比其他 entry 都是具体信号触发）+ 缺硬层 trigger
**修复**（commit `92ce87000`，2026-06-26）：
1. L6 wakeup entry 具体化 — 5 个可观测触发条件（Magic Word / operator 直说 / 重复纠正 / 明确表扬 / 个人近况）
2. post-compact hook 加 profile activation nudge — 系统级注入，proto-硬层
3. refs wakeup-index 同步
**观察**：修复后第二个 7 天窗口（→7/3）到期，**counter >0 确认** — Maine Coon在 `[thread-id]` 自然对话中主动调用 `propose_profile_update`（L6 wakeup 触发条件"operator 表达偏好"命中）。两条提案（codex-primer / opus-primer）均被 operator approved 并写入 runtime profile dir

### Runtime capsule 缺失 P1（2026-07-03 发现 + 止血）

**现象**：Maine Coon在 codex thread 发起 `propose_profile_update` 后发现 runtime 编译 L0 无 `## 主人画像` 输出。
**根因**：`private/` gitignored → worktree 间不共享文件。repo root `cat-cafe/private/profile/landy-capsule.md`（Phase B 手签）从未同步到 `cat-cafe-runtime/packages/api/private/profile/`。F231 Phase C approve 流程只写 `relationship/{catId}-primer.md`，不触碰 capsule。`resolveUserCapsule()` 在 runtime context 下 catch → `{{USER_CAPSULE}}` = 空。
**止血**：一次性 `cp landy-capsule.md` 到 runtime profile dir。L0 编译验证通过（codex/opus 均输出 `## 主人画像` + primer 指针）。
**长期修复**：Phase D / KD-19 已以 canonical `${CAT_CAFE_DATA_DIR}/profiles/<userId>/` repository 取代 worktree bootstrap；读写、L0 与 provenance 不再从 cwd 猜根。现有两套 legacy 内容须先由 operator 解决 persona-primer 冲突，再由 hash-guarded migration apply，不能再复制止血。

### 前端 Viewer 缺失 P2（2026-07-03 确认）

Settings > 猫猫画像 = F208 dossier（模型能力），不是 F231 关系 primer。Approval Hub 只展示 pending/settled proposals。无 API endpoint 读取当前生效 primer 内容。operator 只能 `cat` 磁盘文件。建议独立 Phase 补 viewer surface（API + Settings section）。

### operator 裁定（2026-06-17）

- **C3 必须做，不可后置**。证据：C1 merged 2 天（2026-06-15→17），除 C2 手动测试外零有机使用。wakeup entry 写了但没有猫自然触发。operator 原话："既然这么几天 c2 做完没人用只能说明你这个功能不在大猫猫们的认知路径上"。harness = 软 + 硬 + eval，缺 eval + 缺自动 trigger = dead code on shelf。
- **eval 也必须做**——不测量激活率，下一个功能还是同样命运。eval 指标：propose 调用频次 / approve-reject ratio / primer 被 L0 引用次数
