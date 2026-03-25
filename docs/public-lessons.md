---
feature_ids: []
topics: [lessons, learned]
doc_kind: note
created: 2026-02-26
---

# Lessons Learned

> 目的：沉淀可复用、可验证、可追溯的教训，避免重复踩坑。  
> 导入目标：作为 Hindsight 的稳定知识入口之一（P0/P0.5）。

---

## 1) ID 规则

- 格式：`LL-XXX`（三位数字，递增）
- 稳定性：已发布 ID 不重排、不复用
- 状态：`draft | validated | archived`
- 变更：重大改写保留同一 ID，并在条目中记录 `updated_at` 与变更原因

---

## 2) 条目模板（7 槽位）

```markdown
### LL-XXX: <教训标题>
- 状态：draft|validated|archived
- 更新时间：YYYY-MM-DD

- 坑：<一句话描述踩了什么坑>
- 根因：<为什么会踩>
- 触发条件：<在什么条件下会复发>
- 修复：<当时怎么修>
- 防护：<可执行机制；规则/测试/脚本/流程>
- 来源锚点：<文件路径#Lx | commit:sha | review-notes/doc 链接>
- 原理（可选）：<第一性原理；必须由真实失败案例支撑>

- 关联：<ADR / bug-report / 技能 / 计划文档>
```

---

## 3) 质量门槛（入库前必过）

1. 有来源锚点：至少 1 个可追溯锚点，推荐 2 个（规则 + 实例）。
2. 有时效性验证：确认未被后续 addendum / mailbox 讨论推翻。
3. 有可执行防护：不能只写“注意”，必须有可执行动作。
4. 原理槽位约束：没有真实失败案例支撑，不写原理。
5. 去重：同类教训合并，避免“同义多条”。

---

## 4) 时效性检查清单

每次提炼或更新条目前，按文档类型检查：

- ADR / 协作规则文档：30 天内是否有更新或 addendum
- bug-report / incident：7 天内是否有新复盘或补丁
- discussion 沉淀项：14 天内是否有结论更新

同时检查：

1. 相关 ADR 是否有附录/补丁
2. mailbox 是否有后续讨论更新结论
3. BACKLOG 对应项状态是否变化

---

## 5) 首条示例

### LL-001: 提炼教训前先做时效性验证
- 状态：validated
- 更新时间：2026-02-13

- 坑：直接从旧文档提炼规则，忽略后续 addendum，导致导入过时结论。
- 根因：把“文档存在”误当成“结论仍有效”，缺少时效性检查环节。
- 触发条件：高频讨论期（同一主题 3 天内多次更新）或 ADR 后续附录新增时。
- 修复：在提炼流程前增加时效性检查清单，并要求至少核对一次 mailbox 更新。
- 防护：将时效性检查写入提炼标准；未通过检查的条目不得进入 P0 导入集。
- 来源锚点：
  - *(internal reference removed)*
  - `docs/decisions/005-hindsight-integration-decisions.md#L297`
- 原理（可选）：知识沉淀是“状态同步问题”，不是“文档搬运问题”；任何结论都依赖其最新上下文状态。

- 关联：
  - *(internal reference removed)*
  - *(internal reference removed)*
  - `docs/decisions/005-hindsight-integration-decisions.md`

---

## 6) Maine Coon侧首批条目（AGENTS + Review + Skills）

### LL-002: Review 问题必须先 Red 再 Green，禁止先改后补测
- 状态：validated
- 更新时间：2026-02-13

- 坑：收到 P1/P2 后直接改实现再“补测试”，容易把症状盖住但根因未修。
- 根因：把“看起来修好了”误当成“可证明修好了”，缺失可复现的失败基线。
- 触发条件：时间压力大、问题看起来简单、已有多处改动叠加时。
- 修复：先写失败用例并跑出红灯，再做最小修复，最后转绿并跑回归。
- 防护：review 关闭条件绑定 Red→Green 证据；无红灯记录不允许宣称修复完成。
- 来源锚点：
  - `AGENTS.md#L281`
  - `cat-cafe-skills/cat-cafe-receiving-review/SKILL.md#L52`
- 原理（可选）：修复可信度来自“可重复的因果链验证”，不是来自主观确信。

- 关联：
  - `cat-cafe-skills/cat-cafe-receiving-review/SKILL.md`
  - `cat-cafe-skills/systematic-debugging/SKILL.md`

### LL-003: Reviewer 必须有立场，Author 必须技术性 push back
- 状态：validated
- 更新时间：2026-02-13

- 坑：review 变成礼貌性同意，双方“对方说啥就是啥”，缺乏技术争论。
- 根因：模型天然趋同，追求和谐而非正确性，导致关键分歧被掩盖。
- 触发条件：高节奏迭代、双方都想“快点过 review”、术语不精确时。
- 修复：review 结论必须明确“建议修/不修 + because”；author 必须给技术判断。
- 防护：分歧无法收敛时升级铲屎官裁决，不允许用“非 blocking”逃避判断。
- 来源锚点：
  - `AGENTS.md#L262`
  - `AGENTS.md#L271`
- 原理（可选）：高质量 review 的本质是“可审计决策过程”，不是“快速达成共识”。

- 关联：
  - `cat-cafe-skills/cat-cafe-receiving-review/SKILL.md`
  - `cat-cafe-skills/cat-cafe-requesting-review/SKILL.md`

### LL-004: P1/P2 当轮清零，P3 当场决断，不挂债务
- 状态：validated
- 更新时间：2026-02-13

- 坑：把高优先级问题“先记 backlog”导致风险跨轮累积，后续修复成本放大。
- 根因：把“记录问题”误当成“解决问题”；债务清单变成延期借口。
- 触发条件：功能赶工、多人并行、合入窗口临近时。
- 修复：P1/P2 必须当前迭代修完并验证；P3 当场决定修或不修。
- 防护：review 报告必须显式标注清零状态；P1/P2 未清零不得放行合入。
- 来源锚点：
  - `AGENTS.md#L247`
  - `AGENTS.md#L277`
- 原理（可选）：风险管理要“就地收敛”，延后会把局部风险变系统风险。

- 关联：
  - `docs/ROADMAP.md`
  - `cat-cafe-skills/merge-approval-gate/SKILL.md`

### LL-005: 修完 review 后必须回给 reviewer 二次确认再合 main
- 状态：validated
- 更新时间：2026-02-13

- 坑：作者修完后自行判断“改对了”直接合 main，绕过 reviewer 最终确认。
- 根因：把“实现完成”与“审查闭环完成”混为一件事。
- 触发条件：连续修复多项 P1/P2、分支已准备合入、作者主观把握高时。
- 修复：修复完成后提交确认请求，等待 reviewer 明确放行语句再合入。
- 防护：合入门禁检查 docs/mailbox 放行证据；条件放行需二次确认。
- 来源锚点：
  - `cat-cafe-skills/merge-approval-gate/SKILL.md#L8`
  - `cat-cafe-skills/cat-cafe-receiving-review/SKILL.md#L151`
- 原理（可选）：双人闭环的价值在于“独立验证”，不是“互通知晓”。

- 关联：
  - `cat-cafe-skills/merge-approval-gate/SKILL.md`
  - *(internal reference removed)*

### LL-006: 没有新鲜验证证据，不得宣称完成
- 状态：validated
- 更新时间：2026-02-13

- 坑：未运行最新验证命令就宣称“已修复/已通过”，造成虚假完成与返工。
- 根因：把经验判断当证据，忽略“状态会随代码与环境变化”。
- 触发条件：连续修改后未全量验证、疲劳状态、依赖代理汇报时。
- 修复：每次完成声明前执行对应验证命令，读取完整输出和退出码。
- 防护：completion 前置 verification gate；输出中必须附验证依据。
- 来源锚点：
  - `cat-cafe-skills/verification-before-completion/SKILL.md#L19`
  - `cat-cafe-skills/verification-before-completion/SKILL.md#L27`
- 原理（可选）：工程沟通的最小诚信单位是“可复现证据”，不是“信心表达”。

- 关联：
  - `cat-cafe-skills/verification-before-completion/SKILL.md`
  - `cat-cafe-skills/spec-compliance-check/SKILL.md`

### LL-007: 交接缺 Why 会让接手方无法判断
- 状态：validated
- 更新时间：2026-02-13

- 坑：交接只写改动不写 why/取舍/待决项，接手方无法判断风险与下一步。
- 根因：把“信息传递”简化成“变更清单”，忽略决策上下文。
- 触发条件：赶进度、跨猫传话频繁、review 来回次数增多时。
- 修复：交接统一按五件套（What/Why/Tradeoff/Open Questions/Next Action）。
- 防护：缺项即阻断发送；交接模板与 skill 检查同时执行。
- 来源锚点：
  - `AGENTS.md#L181`
  - `cat-cafe-skills/cross-cat-handoff/SKILL.md#L10`
- 原理（可选）：协作效率的瓶颈是“决策上下文丢失”，不是“消息数量不足”。

- 关联：
  - `cat-cafe-skills/cross-cat-handoff/SKILL.md`
  - *(internal reference removed)*

### LL-008: Worktree 生命周期必须成套执行（建-收敛-合入-清理）
- 状态：validated
- 更新时间：2026-02-13

- 坑：只建不清理 worktree，或在 main 上直接处理冲突，导致磁盘膨胀与误回退。
- 根因：把 worktree 当临时目录而非“并行开发基础设施”管理。
- 触发条件：多特性并行、review follow-up 频繁、合入后未立刻收尾时。
- 修复：按标准流程执行：创建隔离 → 分支收敛 rebase → 合入后立即 prune。
- 防护：review 时检查已合入未清理 worktree；session 开始先跑 `git worktree list`。
- 来源锚点：
  - `AGENTS.md#L311`
  - `AGENTS.md#L376`
- 原理（可选）：隔离资源不做生命周期管理，最终会反向吞噬迭代效率。

- 关联：
  - `AGENTS.md`
  - `docs/ROADMAP.md`
  - `LL-011`
  - `LL-012`

### LL-009: 关键前提不确定时，先提问再动作
- 状态：validated
- 更新时间：2026-02-13

- 坑：在关键前提不明时硬猜推进，后续修复变成“补丁叠补丁”。
- 根因：把“快速前进”误认为效率，低估错误方向的返工成本。
- 触发条件：需求边界模糊、review 反馈不完整、多方案冲突未决时。
- 修复：先澄清不确定点，再进入实现；不清楚的 review 项先问全再修。
- 防护：流程上把“澄清问题”置于实现之前，未澄清不得进入修复环节。
- 来源锚点：
  - `AGENTS.md#L192`
  - `cat-cafe-skills/cat-cafe-receiving-review/SKILL.md#L100`
- 原理（可选）：方向正确性是效率前提，错误方向上的加速只会放大损失。

- 关联：
  - `cat-cafe-skills/systematic-debugging/SKILL.md`
  - `cat-cafe-skills/cat-cafe-receiving-review/SKILL.md`

---

## 7) Ragdoll侧首批条目（CLAUDE.md + Bug Report + Skills）

### LL-010: 删除文件必须用 trash，禁止 /bin/rm
- 状态：validated
- 更新时间：2026-02-13

- 坑：shell 提示 "Use trash or /bin/rm" 时选了 `/bin/rm`，绕过安全网不可逆删除了文件。
- 根因：把 `/bin/rm` 误认为"更正确"的选择。实际上 shell alias `rm → trash` 就是安全网，绕过它 = 放弃恢复能力。
- 触发条件：shell 提示二选一时；或脚本中直接调用 rm。
- 修复：一律使用 `trash` 命令代替任何 rm 操作。
- 防护：CLAUDE.md 明确禁止 `/bin/rm`；铲屎官 shell 配置 `rm` alias → `trash`。
- 来源锚点：
  - CLAUDE.md "删除文件必须用 trash" 段落（auto memory 2026-02-12）
  - 2026-02-12 实际犯错事件
- 原理：不可逆操作必须有安全网（垃圾桶 = undo buffer）。绕过安全网的捷径永远比它节省的时间更危险。

- 关联：CLAUDE.md 铲屎官硬规则

### LL-011: Worktree 清理的正确顺序——先 push，再 cd 回主仓，最后 remove
- 状态：validated
- 更新时间：2026-02-13

- 坑：(1) 在 worktree CWD 里执行 `git worktree remove` 删除自己 → shell 悬空，什么都做不了。(2) 先删 worktree 再想 push → 站在虚空里连记忆都改不了，铲屎官笑着救了我。两次犯同类错误。
- 根因：没有意识到"删除当前工作目录"会导致 shell 失去锚点。删了就什么都做不了了。
- 触发条件：在 worktree 目录内执行清理操作；或在清理前没完成所有需要 worktree 存在的操作。
- 修复：强制顺序——(1) rebase + 合入 main (2) push origin main (3) cd 回主仓 (4) git worktree remove。
- 防护：CLAUDE.md §9 铁律 + `using-git-worktrees` / `finishing-a-development-branch` skill 自动引导。
- 来源锚点：
  - `CLAUDE.md#L274` §9 Worktree 使用与清理
  - 2026-02-12 两次犯错（早：CWD 删自己；晚：先删再想 push）
- 原理：在自己的工作目录里删除自己 = 锯断自己坐着的树枝。任何"销毁当前环境"的操作都必须先切换到安全位置。

- 关联：LL-008 | `using-git-worktrees` skill | `finishing-a-development-branch` skill

### LL-012: 不要 --force 删有猫在工作的 worktree
- 状态：validated
- 更新时间：2026-02-13

- 坑：Maine Coon正在 worktree 里修 bug，我看到 `git branch --merged main` 就以为已合入，`--force` 强删了他的工地。Maine Coon呆在消失的目录里不知所措。
- 根因：把 `--merged main` 当成"工作完成"的充分条件。实际上 `--merged` 只说明分支起点在 main 历史上，不代表 worktree 内的工作已完成或没人在用。
- 触发条件：清理 worktree 时看到"包含修改或未跟踪文件"警告但选择 --force。
- 修复：清理前必须问"这个 worktree 有猫在用吗？"。有修改/未跟踪文件警告 = 绝对禁止 --force。
- 防护：CLAUDE.md 明确规则 + 清理前先检查 worktree 内 git status。
- 来源锚点：
  - CLAUDE.md "Worktree 铁律"（auto memory 2026-02-12）
  - 2026-02-12 实际犯错：强删 `cat-cafe-opus-permission-request`
- 原理：单一信号（`--merged`）不足以判断完整状态。状态判断需要多维验证——分支合并状态 ≠ 工作目录状态 ≠ 使用者状态。

- 关联：LL-008 | LL-011 | `using-git-worktrees` skill

### LL-013: Git commit 前必须检查暂存区
- 状态：validated
- 更新时间：2026-02-13

- 坑：`git add myfile && git commit` 但暂存区已有上次 session 或铲屎官留下的文件，导致无关改动混入 commit。
- 根因：`git add` 是追加操作，不是替换操作。暂存区是累积状态，不会因为新 add 而清空之前的内容。
- 触发条件：连续 session 之间，或铲屎官手动操作后，暂存区有残留文件。
- 修复：commit 前必须 `git status` 检查暂存区全部内容，确认只有自己的文件。
- 防护：CLAUDE.md "Git commit 纪律" 明确规则。
- 来源锚点：
  - CLAUDE.md "Git commit 纪律"（auto memory）
  - 实际犯错事件（混入无关改动）
- 原理：累积状态工具（git staging、Redis pipeline、消息队列等），操作前必须验证当前状态，不能假设初始为空。

- 关联：无对应 skill；通用 git 纪律

### LL-014: Bug 修复必须先写 Bug Report 再动手
- 状态：validated
- 更新时间：2026-02-13

- 坑：收到铲屎官汇报的 URL 路由缺失 bug 后，直接修代码，没写 bug report 也没写 review 信。被铲屎官批评：没有记录 = 无法复盘。
- 根因："修 bug 最重要"的思维惯性，跳过了记录环节。没有意识到记录本身是修复流程的一部分。
- 触发条件：收到 bug 报告后想快速修复的冲动；bug 看起来简单的时候尤其容易跳过。
- 修复：CLAUDE.md §4 强制要求先写 bug report（5 项：报告人/复现步骤/根因/修复方案/验证方式），再动手。
- 防护：CLAUDE.md §4 协作准则 + `systematic-debugging` skill 引导先分析再修复。
- 来源锚点：
  - `CLAUDE.md#L203` §4 Bug 修复必须先写 Bug Report
  - *(internal reference removed)*（就是那次没写 report 的 bug）
- 原理：修复是瞬时的，记录是永久的。没有记录的修复 = 无法复盘、无法学习、无法防止同类错误。

- 关联：`systematic-debugging` skill | CLAUDE.md §4

### LL-015: Worktree 开发必须用独立 Redis 端口（6398），绝不碰 6399
- 状态：validated
- 更新时间：2026-02-13

- 坑：在 worktree 工作时未设置 REDIS_URL，服务回落到默认 6399（铲屎官数据），数据从 307 keys 降至 15 keys（95% 丢失）。虽最终从 RDB 备份完全恢复，但过程惊险。
- 根因：开发环境和生产数据共享同一个 Redis 实例，靠配置（环境变量）隔离。一旦忘设配置，默认值指向生产。
- 触发条件：worktree 中启动服务但忘记创建 `.env` 设置 `REDIS_URL=redis://localhost:6398`。
- 修复：(1) 强制 worktree 使用 6398 端口 (2) 启动前验证 `echo $REDIS_URL` (3) 启动后验证数据量。
- 防护：CLAUDE.md §10 三猫铁律 + `.env` 模板 + 启动验证步骤。
- 来源锚点：
  - `CLAUDE.md#L344` §10 Worktree Redis 隔离
  - *(internal reference removed)*
- 原理：开发环境与生产数据必须物理隔离（不同端口/实例），不能靠配置正确性保证。默认值必须指向安全侧（沙盒），而非危险侧（生产）。

- 关联：LL-008 | LL-011 | CLAUDE.md §10 | Redis 数据丢失 incident report

### LL-016: ioredis keyPrefix 对 eval() 和 keys() 的行为不一致
- 状态：validated
- 更新时间：2026-02-13

- 坑：假设 ioredis 的 `keyPrefix` 配置对所有命令行为一致。实际上 `eval()` 的 KEYS[] 参数会自动加前缀，但 `keys()` 搜索不会自动加前缀。
- 根因：ioredis 内部实现不统一——`eval()` 走了命令封装层（会加 prefix），`keys()` 走了另一条路径。
- 触发条件：使用 `keyPrefix` 配置的 ioredis 实例调用 `keys()` 搜索或 `eval()` Lua 脚本。
- 修复：`keys()` 手动拼接 prefix；`eval()` KEYS[] 不需要手动加（会自动加）。
- 防护：auto memory `redis-pitfalls.md` 记录 + Redis 测试隔离规则（CLAUDE.md §7）确保测试环境能暴露此类问题。
- 来源锚点：
  - auto memory `redis-pitfalls.md`
  - ADR-008 Lua 脚本开发中多次踩坑
- 原理：同一 SDK 的不同方法对同一配置的处理可能不一致。使用 SDK 的隐式行为（如自动 prefix）前，必须逐方法实测验证，不能假设一致性。

- 关联：CLAUDE.md §7 Redis 测试规则 | ADR-008 Lua 原子操作

### LL-023: CLI JSON 格式陷阱与 `jq` 安全防护
- 状态：draft
- 更新时间：2026-02-19

- 坑：在 CLI 中手动拼接带变量的 JSON 字符串（如 `curl` 调用 API）时，极易因双引号转义、多层嵌套或变量内容包含特殊字符而导致 JSON 格式损坏，甚至导致消息发送失败或变成“只有用户可见”的悄悄话。
- 根因：手动拼接 JSON 违反了“数据与格式分离”原则，AI 对 Shell 转义规则（尤其是多层引号）的处理在复杂场景下不可靠。
- 触发条件：通过 `curl` 调用含有环境变量（如 `$CAT_CAFE_INVOCATION_ID`）的 API，且消息内容包含引号、换行或表情符号时。
- 修复：强制使用 `jq` 构造 JSON（例如：`jq -nc --arg c "$MSG" '{content: $c}'`），利用工具确保内容被自动转义。
- 防护：更新所有 Agent 的提示词模板，将 `curl` 示例改为 `jq` 构造法；在 `GEMINI.md` 中增加醒目警告。
- 来源锚点：
  - `GEMINI.md` (2026-02-19 更新)
  - 2026-02-19 Siamese（Gemini）“猫猫杀”游戏调试过程
- 原理：结构化数据必须由结构化工具生成。在命令行环境中，`jq` 是保证数据序列化健壮性的事实标准。

### LL-017: CAS 比较必须基于不可变快照，不能用内存活引用
- 状态：validated
- 更新时间：2026-02-13

- 坑：内存 InvocationRecordStore 的 `get()` 返回对象活引用。CAS 更新时用 `get()` 获取的值做比较，但在比较前对象已被其他异步操作修改，导致 CAS 永远成功（比较的是已修改后的值）。
- 根因：JavaScript 对象是引用类型，`get()` 返回的不是快照而是同一个内存地址。CAS 的前提是"读到的旧值在比较时不变"，内存引用破坏了这个前提。
- 触发条件：内存 store 实现 + 异步并发操作 + CAS（Compare-And-Set）模式。
- 修复：引入 `snapshotStatus`——在 CAS 操作开始时立即复制当前值，后续比较基于快照而非活引用。
- 防护：CAS 模式代码审查清单 + ADR-008 S2 的 Redis Lua 原子操作（Redis 侧天然不存在此问题）。
- 来源锚点：
  - ADR-008 S2 CAS Lua 开发过程
  - `packages/api/src/domains/cats/services/InvocationRecordStore.ts` snapshotStatus 实现
- 原理：CAS 操作的正确性取决于"读取值的不可变性"。在引用语义的语言中（JS/Python/Java），内存引用 ≠ 快照；CAS 比较必须基于值拷贝。

- 关联：ADR-008 InvocationRecord 状态机

### LL-018: Session 存储必须按 Thread 隔离，不能只按 userId:catId
- 状态：validated
- 更新时间：2026-02-13

- 坑：Session 按 `userId:catId` 存储，不区分 thread。导致Maine Coon在 Thread A 的上下文（Phase 5 任务）泄漏到 Thread B（哲学茶话会），Maine Coon在茶话会结尾突然开始执行 Phase 5 文档编写——被称为"夺魂"事件。
- 根因：Session key 设计缺少 threadId 维度。隐含假设"一只猫同时只在一个 thread 工作"，但多 thread 场景下 session 跨 thread 污染。
- 触发条件：同一只猫被 @ 到多个 thread，且不同 thread 有不同的上下文/任务。
- 修复：Session key 改为 `userId:catId:threadId` + 消息级审计日志追踪上下文来源。
- 防护：BACKLOG #38（已完成）+ 消息级审计日志 BACKLOG #37（已完成）+ bug report 归档。
- 来源锚点：
  - *(internal reference removed)*
  - *(internal reference removed)*（完整 5 阶段演化）
  - BACKLOG #38 Session 按 Thread 隔离
- 原理：多租户/多上下文系统中，隔离键必须包含所有上下文维度。缺少任何一个维度 = 跨上下文泄漏风险。"够用"的隔离键在规模增长时会变成"不够用"。

- 关联：茶话会夺魂 bug report | BACKLOG #37 消息级审计 | **LL-019 过度修复** | **LL-020 补丁数量信号** | **LL-021 根因追溯深度**
- 后续演化：根因修复（本条）后，团队"顺手"修了触发器（CLI HOME 隔离 #36），引发 5 个新问题 + 6 个补丁仍不稳定，最终回退。详见 LL-019、LL-020。

### LL-019: 过度修复反模式——根因修完后不要盲修触发器
- 状态：validated
- 更新时间：2026-02-13

- 坑：茶话会夺魂 bug 的根因（Session 跨 thread 污染 #38）已修复，但"顺手"也修了次要触发器（`~/.codex/AGENTS.md` 全局注入 #36）——用替换 HOME 环境变量的方式隔离 CLI 全局配置。结果隔离方案导致：401 认证失败、模型回落、session 丢失、MCP 工具链残缺、project trust 丢失。比原 bug 造成了更多问题。
- 根因：修完根因后没有重新评估触发器的修复优先级。"既然发现了就一起修了"的惯性思维。实际上根因修复（加 threadId）已经消除了跨 thread 污染的伤害路径，触发器（全局 AGENTS.md）在项目级 `AGENTS.md` 存在的情况下已被覆盖，不再构成实际威胁。
- 触发条件：修完根因后看到"还有一个相关问题"时的冲动；修复看起来不大（"只是隔离一个文件"）的错觉。
- 修复：回退 CLI HOME 隔离方案，改用真实 HOME。确认项目级 AGENTS.md 已覆盖全局配置。
- 防护：根因修复后，触发器修复必须独立评估 ROI（收益 vs 引入新风险）。不确定时先观察，不要"顺手修"。
- 来源锚点：
  - *(internal reference removed)* Phase 3-5
  - BACKLOG #36（6 个补丁链：`2a6c7d4` → `449fe91` → `81fa2bf` → `d930e2e` → `327c0a3` → `61f3675`）
  - *(internal reference removed)*（隔离副作用 #44）
- 原理：每个修复都有引入新问题的风险。根因修复已消除伤害路径后，触发器的"理论风险"不足以证明"实际修复成本"。修复的 ROI 必须独立评估，不能因为"顺手"就搭车。

- 关联：LL-018 Session 隔离 | LL-020 补丁数量信号 | LL-021 根因追溯深度 | BACKLOG #36 #44 #51

### LL-020: 补丁数量是方向信号——N > 3 停下来复检方向
- 状态：validated
- 更新时间：2026-02-13

- 坑：CLI HOME 隔离方案 (#36) 需要 6 个补丁（sessions 丢失 → symlink → 旧目录残留 → 自引用 symlink → copy fallback → 短路保护）仍然不稳定，最终 Phase 4 发现全面失效（Codex CLI 重建 `.codex/` 覆盖所有 copy/symlink 的文件）。
- 根因：每个补丁只修当前暴露的症状，没有停下来问"方案根基是否稳定"。补丁叠补丁形成了越来越脆弱的链条。
- 触发条件：一个功能/修复需要连续 > 3 个 fix commit；每次修完一个副作用又冒出下一个。
- 修复：在第 3-4 个补丁时停下来做方向复检：这个方案的假设（"替换 HOME 就能隔离一个文件"）是否成立？有没有更精准的替代方案？
- 防护：团队约定"补丁链告警线"——同一功能的 fix commit > 3 个时，必须暂停并评估方向。
- 来源锚点：
  - *(internal reference removed)* Phase 3（6 个 commit 记录）
  - git log: `2a6c7d4` → `449fe91` → `81fa2bf` → `d930e2e` → `327c0a3` → `61f3675`
- 原理：系统在通过"补丁爆炸"告诉你方案根基不稳。持续打补丁 = 在错误方向上加速。N > 3 不是"还需要更多补丁"的信号，而是"换方向"的信号。

- 关联：LL-019 过度修复 | BACKLOG #36

### LL-021: AI 倾向停在第一层"看起来合理"的答案，不主动追溯根因
- 状态：validated
- 更新时间：2026-02-13

- 坑：茶话会夺魂 bug 调试时，修 bug 的Ragdoll（分身 session `thread_mlkxnyg17ftop4v8`）找到了 `~/.codex/AGENTS.md` 全局注入后就停了——"这能解释为什么Maine Coon去跑 superpowers"。但铲屎官追问："可它怎么知道 Phase 5 的？AGENTS.md 里又没有 Phase 5。"这一问才逼出了真正的根因——Session 跨 thread 污染。如果铲屎官没追问，我们只会修触发器，留下根因。
- 根因：AI 模型的推理模式倾向于在找到"看起来说得通"的第一层解释后停止追溯。"看起来合理"≠"因果链完全闭合"。AGENTS.md 能解释 superpowers 行为但解释不了 Phase 5 知识来源——因果链有断点，但模型没有主动识别。
- 触发条件：找到一个能解释部分症状的原因时；时间压力下想快速修复时；root cause 和 trigger 看起来像同一件事时。
- 修复：铲屎官持续追问直到因果链完全闭合。每个"解释"都要验证：它能解释所有症状吗？有没有它解释不了的？
- 防护：bug 根因分析清单增加"因果链闭合检查"——列出所有症状，确认提出的根因能逐一解释每个症状。解释不了的 = 根因不完整，继续挖。
- 来源锚点：
  - *(internal reference removed)* §5 Step 6（铲屎官追问 Phase 5 来源）
  - 实际修 bug session: `thread_mlkxnyg17ftop4v8`
  - *(internal reference removed)* Phase 1
- 原理：根因分析的正确性标准不是"找到一个合理解释"，而是"因果链完全闭合——每个症状都能被根因解释"。第一层答案往往是触发器不是根因。必须持续问 "but why?" 直到没有未解释的症状。

- 关联：LL-018 Session 隔离 | LL-019 过度修复 | LL-014 Bug Report 先行 | `systematic-debugging` skill

### LL-022: 治理基线必须脚本化，不能靠“看一眼 dashboard”
- 状态：draft
- 更新时间：2026-02-13

- 坑：P0 已有导入和严格检索策略，但如果不做固定健康检查，`tags=0` 或空库会无声发生，直到检索命中异常才被发现。
- 根因：把“偶尔人工检查”当作治理手段，缺少可重复、可自动化的最低可观测门禁。
- 触发条件：多人并行改导入/检索逻辑、环境重置、Hindsight API 字段漂移时。
- 修复：新增 `scripts/hindsight/p0-health-check.sh`，固定检查 `stats/tags/version` 三件套，并把 `tags.total==0` 与 `stats.total_nodes==0` 设为硬失败。
- 防护：P0 验收前与后续回归中运行健康脚本；失败即阻断“可用”结论。
- 来源锚点：
  - `scripts/hindsight/p0-health-check.sh`
  - *(internal reference removed)*
  - *(internal reference removed)*
- 原理：治理有效性不是“策略存在”，而是“策略被持续验证”。没有自动化检查的治理，等同于没有治理。

- 关联：`docs/decisions/005-hindsight-integration-decisions.md` | `docs/ROADMAP.md` | Task 4 可观测检查

### LL-024: 状态字段多点写入会复发蜘蛛网
- 状态：validated
- 更新时间：2026-02-27

- 坑：设计文档元数据契约时，最初方案让每个文档都有 `stage: idea|spec|in-progress|review|done` 字段。如果 661 个文件都有 `stage`，Feature 状态变化就要到处改——这正是 F40 想解决的"蜘蛛网"问题的 2.0 版本。
- 根因：把"关联数据"和"状态数据"混为一谈。`feature_ids` 是静态关联（文档属于哪个 Feature），而 `stage` 是动态状态（Feature 当前进度）。动态状态不应该散布到所有关联文档。
- 触发条件：设计元数据 schema 时，想把所有"有用信息"都放进 frontmatter；没有区分静态属性和动态状态。
- 修复：`stage` 只保留在 `docs/features/Fxxx.md` 聚合文件的 Status 字段，不放入普通文档 frontmatter。聚合文件是 Feature 状态的唯一真相源。
- 防护：ADR-011 明确记录此决策 + `feat-kickoff` / `feat-completion` skill 不在普通文档生成 `stage` 字段。
- 来源锚点：
  - `docs/decisions/011-metadata-contract.md` §D
  - `docs/features/F040-backlog-reorganization.md` Frontmatter Contract 章节
  - 2026-02-26 三猫讨论（4.6 提出此问题）
- 原理：单点真相源原则——任何状态信息都应该只有一个权威来源。多点写入 = 同步负担 + 不一致风险。静态关联可以多点存（因为不变），动态状态必须单点存。

- 关联：ADR-011 | F040 | `feat-kickoff` skill | `feat-completion` skill

### LL-025: 协作规则不能写死个体名，必须引用角色
- 状态：draft
- 更新时间：2026-02-27

- 坑：SOP、CLAUDE.md、AGENTS.md、skill 文件里写死"Ragdoll找Maine Coon review"、"Maine Coon放行才能合入"。当同一物种有多个分身（Opus 4.5/4.6/Sonnet）时，规则指向不明；AGENTS.md 甚至出现"Maine Coon文件里写找Maine Coon review"的自我矛盾。
- 根因：早期 1 Family = 1 Individual = 1 Role，写死个体名等于写死角色。多分身 + 新猫接入打破了这个等式。
- 触发条件：新猫/新分身加入时，或同一物种多个分身同时在线时。
- 修复：规则写"具有 peer-reviewer 角色的跨 family 猫"，不写"Maine Coon"。Roster (cat-config.json) 是唯一事实源，规则引用角色而非个体。
- 防护：F042 Phase B 文档去硬编码 + review 时检查是否有新增的个体名硬编码。
- 来源锚点：
  - `docs/features/F042-prompt-engineering-audit.md` §1.1
  - *(internal reference removed)*
  - 2026-02-27 四猫 + 铲屎官讨论
- 原理：协作规则的持久性取决于它引用的是稳定抽象（角色）还是不稳定实例（个体）。引用个体 = 每次团队变化都要改规则。

- 关联：F042 | F032 | cat-config.json roster

### LL-026: 身份信息是硬约束常量，不是可推断上下文
- 状态：draft
- 更新时间：2026-02-27

- 坑：Maine Coon在 Context compact 后自称"Ragdoll"（Ragdoll的昵称），把自己当成了Ragdoll。A2A @ 能力也随对话推进退化，猫猫不再主动 @ 队友协作。
- 根因：身份信息（"你是谁"）和 A2A 协议（"怎么 @ 队友"）被当成普通上下文，compact 时可能被压缩掉或改写。模型从最近上下文推断身份时，容易被最近的说话人风格锚定。
- 触发条件：长对话 → Context compact → 身份段被压缩 → 模型从残留上下文推断错误身份。
- 修复：每次 system prompt 注入（含 compact 后）都必须包含不可省略的身份声明 + A2A 格式规则。
- 防护：F042 Phase A 验证注入缺口 + Phase C 优化注入频率。
- 来源锚点：
  - `docs/features/F042-prompt-engineering-audit.md` §1.2, §1.3
  - *(internal reference removed)*（Maine Coon自省分析）
  - 2026-02-27 铲屎官运行时观察
- 原理：多 Agent 系统中，身份是最基础的约束——它决定了模型的行为边界、权限和协作关系。把身份当成可推断项，就相当于每次 compact 后给模型一个"你可以变成任何人"的自由度。

- 关联：F042 | LL-025 | SystemPromptBuilder

---

### LL-027: Feature spec 与代码实现的时间线漂移会误导路线决策
- 状态：validated
- 更新时间：2026-03-02
- 现象：F042 的 6 个 PR 在 2026-03-01 合入 main，但 spec 的 Status 仍停留在 "in-progress (决策完成，待实施)" — 导致路线盘点时两猫都要花大量 token 做 "spec vs 实际" 的对账
- 根因：没有 "PR 合入后更新 spec" 的强制环节
- 对策：**Feature 相关 PR 合入后 48h 内必须同步 spec 的 Timeline/Status**。纳入 merge-gate 或 feat-lifecycle 的收尾步骤。
- 来源锚点：
  - *(internal reference removed)*（收敛纪要）
  - Maine Coon 2026-03-01 F042 盘点分析（对账 spec vs git log）
- 关联：F042 | merge-gate | feat-lifecycle

### LL-028: "最小实现"不等于"做个玩具再重写"——绕路 C 点反模式
- 状态：validated
- 更新时间：2026-03-05
- 现象：到了交付阶段仍在"先做个简陋版本让铲屎官验收"，交付半成品而非完整 feat。内部实现步骤被暴露为交付批次，铲屎官被迫反复验收中间产物。产出后续要重写而非扩展，等于做了两遍。
- 根因：从"什么容易做"往前凑，而不是从终态往回推。把探索阶段的习惯（spike/MVP）带到了交付阶段。
- 典型症状：先做内存 Map 模拟再换 Redis、先搭空壳模板再填真逻辑、先造通用框架再写业务。
- 对策：
  1. Planning 阶段先钉终态 schema，每步产物必须在终态中原样保留（可扩展不可替换）
  2. 步骤是内部实现节奏，不是给铲屎官看的交付批次；交付物是完整 feat
  3. 纯探索显式标注 Spike（时间盒 + 产出结论），不伪装成交付物
  4. Quality gate 自检：后续要"重写"还是"扩展"？重写 = 绕路
- 来源锚点：2026-03-05 铲屎官反馈 + Ragdoll/Maine Coon联合分析
- 关联：writing-plans | quality-gate

### LL-029: 交付物验证不能只看 spec checkbox——必须核实 commit/PR
- 状态：validated
- 更新时间：2026-03-09
- 现象：猫猫声称 feature 完成/未完成，只看了 spec 文件的 checkbox 状态就下结论，没有去核实 git log、PR、实际 commit。导致"睁眼说瞎话"——spec 可能漏标、错标，与实际代码状态不一致。
- 根因：偷懒走捷径。spec checkbox 是人工维护的元数据，不是交付证据本身。把"关于证据的描述"当成了"证据"。
- 对策：
  1. 验证交付物时，至少核实两层：spec checkbox + 实际 commit/PR 状态
  2. "完成"的证据链：spec AC ✅ + commit 存在 + PR merged + 测试通过
  3. "未完成"也需要证据：具体哪条 AC 缺失 + 对应代码/PR 确实没有
  4. 不要只读 .md 文件就下结论——.md 是索引，git 才是真相
- 来源锚点：2026-03-09 铲屎官发现Ragdoll(另一线程)只看 spec 就声称 feat 未完成
- 关联：P5（可验证才算完成）| quality-gate | feat-lifecycle

### LL-030: 共享脚本改默认值，同 commit 必须补显式环境值 + 真实启动验收
- 状态：validated
- 更新时间：2026-03-13

- 坑：为开源仓安全把 `start-dev.sh` 的 proxy 默认值改为 OFF → 家里 `.env` 没补显式 `ANTHROPIC_PROXY_ENABLED=1` → runtime 重启后 proxy 消失 → 手动拉起绑定 CLI session → session 退出 proxy 再死。一个默认值改动引发 4 步修A炸B 链条。
- 根因：把"改脚本默认值"当成局部变更，没意识到这是"改所有依赖该脚本的环境的行为"。`.env` 显式值是防漂移的唯一屏障，但没有同步补上。
- 触发条件：共享脚本被多环境（dev / opensource / runtime worktree）使用 + 改了默认值但没补 `.env` 显式覆盖 + 未做真实启动验收（只跑了静态检查）。
- 修复：(1) 同 commit 补 `.env` 显式值 (2) 验收必须包含 `pnpm start` 真实启动 (3) 启动摘要标注值来源（profile default vs .env override）。
- 防护：ADR-016 N3（profile 化取代纯 `.env` 感知）+ 启动摘要值来源标注 + sidecar 状态分层（disabled/launching/ready/failed）。
- 来源锚点：
  - *(internal reference removed)*（C1 共识 + 4.1 决策）
  - `docs/decisions/016-sync-runtime-negation-decisions.md`（N3 否决分叉脚本）
  - commit `553984d5`（Maine Coon proxy kill 门禁修复）
- 原理：共享基础设施的默认值是所有消费环境的隐式契约。改默认值 = 改所有环境的行为。必须同时补齐所有消费方的显式覆盖，并用真实启动验证——静态检查只能证明"代码合法"，不能证明"行为正确"。

- 关联：ADR-016 | LL-019 过度修复反模式 | LL-020 补丁数量信号

### LL-031: Quality gate 逐字段对账 AC——文档承诺 ≠ 代码已兑现
- 状态：draft
- 更新时间：2026-03-14

- 坑：F118 Phase A 的 quality gate 将 AC-A3/AC-A5 记为"已达成"，但 AC-A3 承诺的 `rawArchivePath` 字段在代码和测试里都不存在。GPT-5.4 愿景守护才发现这个缺口。
- 根因：quality gate 按"大部分字段都实现了"的直觉打勾，没有逐字段对账 AC 文本与实际代码产出。文档里写了什么 ≠ 代码里有什么。
- 触发条件：AC 列出多个字段/能力时，部分实现容易被当成全部实现。
- 修复：spec 改为 `rawArchivePath` provider-scoped 可选，defer 到 Phase B（commit `b594dd90`）。
- 防护：quality gate Step 3 逐项检查时，对列表型 AC（多个字段/多个能力），必须逐项在代码中 grep 确认存在，不能凭印象打勾。
- 来源锚点：
  - `docs/features/F118-cli-liveness-watchdog.md` AC-A3 修订
  - GPT-5.4 愿景守护 2026-03-14（thread_mmqaetstx6zsintt）
- 原理：AC 是 feature contract 的一部分，每个字段都是承诺。"大部分实现"≠"AC 达成"。quality gate 的价值在于精确性，不在于速度。

- 关联：LL-029 交付物验证不能只看 spec checkbox

### LL-032: 愿景守护不能只看代码和测试报告——必须真实启动 dev 跑一遍
- 状态：validated
- 更新时间：2026-03-14

- 坑：F101 狼人杀被声明 done（2026-03-12），愿景守护由 GPT-5.4 审查并 pass。92 个单元测试全绿、190+ 游戏测试全绿。但 2026-03-14 铲屎官第一次真的启动 dev 点开狼人杀后发现：(1) GameShell 接了 onClose 但没渲染关闭按钮——用户被困在全屏游戏里出不来；(2) 无大厅/配置流程——硬编码 7 只猫自动塞入；(3) 猫猫 AI 不会自动行动——游戏永远卡在 night_guard 等待；(4) 与 .pen 设计稿的 UX 差距大。整体不可用。
- 根因：愿景守护是通过阅读代码、测试报告和 spec checkbox 完成的，没有一只猫真的启动 `pnpm dev`，打开浏览器，点击"狼人杀"，选个模式，看看会发生什么。单元测试验证的是组件/引擎的孤立行为，不是端到端用户体验。"每个部件都对"≠"组装起来能用"。
- 触发条件：feature 有前端 UI + 后端引擎 + WebSocket 实时交互等多层集成时；只跑单元测试不做 E2E 验证时。
- 修复：(1) 重新打开 F101，补 Phase C 可用性修复；(2) 新增 AC-C4 要求 codex/gpt52 启动 dev 做真实 E2E 验收。
- 防护：愿景守护增加"真实环境启动验证"环节——对于有 UI 的 feature，reviewer 或铲屎官必须至少启动一次 dev 环境并走通核心流程。不方便的话至少把 dev 启动好让铲屎官一起测。
- 来源锚点：
  - `docs/features/F101-mode-v2-game-engine.md` Phase C（2026-03-14 补充）
  - 铲屎官 2026-03-14 消息："你们没人点开 dev 启动你们的东西跑过真的测试嘛？"
  - 铲屎官 2026-03-14 截图：night_guard 全员等待，无关闭按钮
- 原理：集成系统的正确性不能由组件测试的总和保证。单元测试验证的是"每个零件符合 spec"，不是"零件组装后的机器能工作"。对于用户直接使用的 feature，最终验收必须包含真实环境启动 + 用户视角走查。

- 关联：LL-029 交付物验证 | LL-031 Quality gate 逐字段对账 | LL-006 没有新鲜验证证据不得宣称完成

### LL-033: 云端 review 不能只看 review body state——必须检查 inline code comments

- 状态：validated
- 更新时间：2026-03-18
- 坑：PR #543 云端 Codex review 的 review body 显示 `COMMENTED`（通常意味着"no major issues"），但实际在 inline code comment 里提了一个 P1（flushDirtyThreads 用了空的 threadMemory.summary 会 30 秒后删除 rebuild 刚建好的 thread 索引）。Ragdoll只看了 review body 就 merge 了，漏掉了 P1。
- 根因：`gh pr view` 的 `--json reviews` 只返回 review body，不返回 inline code comments。必须额外调 `gh api repos/.../pulls/N/comments` 才能看到 inline comments。
- 触发条件：云端 review 给了 `COMMENTED` state + 有 inline P1 code comment。
- 防护：
  - merge-gate 流程加一步：**必须检查 inline comments**（`gh api repos/{owner}/{repo}/pulls/{N}/comments`），不能只看 review body
  - 看到 `COMMENTED` 不等于通过——要看完整 comments 再判断
- 来源锚点：
  - PR #543: fix(F102-E): thread indexing reads message content
  - 铲屎官原话："等会！这个 codex 云端他给你提了 p1 的你怎么就合入了？"
- 关联：merge-gate skill、云端 review 流程

---

### LL-034: Embedding 实现偷懒——有参考架构不参考，in-process CPU 替代独立进程 GPU

- 状态：validated
- 更新时间：2026-03-21
- 坑：F102 Phase C 的 embedding 实现用了 `@huggingface/transformers`（Transformers.js ONNX，in-process CPU），而同一项目里 TTS/ASR 已有完整的参考架构（独立 Python 进程 + MLX GPU + HTTP /health + 端口注册 + GPU 锁）。结果：(a) CPU 和 API 进程争抢资源；(b) 无独立端口、无健康检查、dashboard 不可见；(c) 启动时同步阻塞下载 614MB 模型；(d) Mac 有 Apple Silicon GPU 不用，浪费硬件。
- 根因：Ragdoll偷懒走了"最小实现路径"（ONNX + Transformers.js in-process），没有对照同项目已有的 TTS/ASR 架构模式。这是典型的"脚手架"——有终态参考（独立进程 GPU）还做了中间态（in-process CPU）。
- 触发条件：新增本地模型推理能力时，没有先审视项目里已有的模型服务架构。
- 防护：
  - **新增任何本地模型推理 → 先看 TTS/ASR 的实现模式**（独立进程 + GPU + HTTP + /health + 端口注册）
  - **禁止把模型推理放在 API 主进程内**（CPU 争抢 + 无隔离）
  - **Mac 上优先用 MLX**（Apple Silicon GPU 原生支持）
- 正确做法：写一个独立的 `scripts/embed-api.py`（参考 `scripts/tts-api.py`），用 MLX 或 sentence-transformers GPU，暴露 `/embed` + `/health`，Node.js API 只做 HTTP 客户端。
- 铲屎官原话："你用 cpu！为什么不用 gpu 啊！！你这实现我拒绝。你这不又是脚手架，有其他同样模型的参考实现你还非得实现成现在这样。"
- 关联：LL-029 交付物验证、F102 Phase C、TTS(scripts/tts-api.py)、ASR(scripts/whisper-api.py)

---

### LL-035: sync-to-opensource rsync --delete 打穿 runtime worktree——.env 全灭、2057 文件被删

- 状态：validated
- 更新时间：2026-03-21
- 坑：Maine Coon执行 `scripts/sync-to-opensource.sh` 时，TARGET_DIR 指向了 `cat-cafe-runtime`（runtime worktree）而非 `clowder-ai`（开源仓）。脚本核心操作 `rsync -a --delete` 把 runtime 当成开源仓目标来清洗：(a) 2057 个文件从磁盘删除（296,204 行代码消失）；(b) `.env` 被开源版覆盖（端口变 3003/3004、品牌变 Clowder AI、API keys 全丢、代理关闭）；(c) `.env` 被删除；(d) `node_modules` 损坏导致服务无法启动。**`.env` 是 gitignored 的，`git checkout .` 无法恢复，API keys、飞书/Telegram/GitHub IMAP 配置均无备份。**
- 根因：(1) sync 脚本的 TARGET_DIR 没有安全护栏，任何路径都能被当成目标；(2) `CLOWDER_AI_DIR` 环境变量被设错或在错误目录执行了脚本；(3) `rsync --delete` 是不可逆破坏性操作，无 trash/回收站。
- 触发条件：`CLOWDER_AI_DIR` 指向内部 worktree，或在 worktree 目录下执行 sync 脚本导致相对路径解析错误。
- 修复：
  - 代码文件：`git checkout . && git pull origin main && pnpm install`
  - `.env`：从 WebStorm `content.dat` 缓存逐 key 恢复（Anthropic/OpenRouter/Feishu/GitHub IMAP 找回，OpenAI/Google/Telegram 未找回需手动补）
  - `.env`：从 `.env.example` 重建
- 防护：
  - **`sync-to-opensource.sh` 新增 TARGET_DIR 安全护栏**：(a) 目录名匹配 `cat-cafe*` 则拒绝；(b) 目标是当前仓库的 git worktree 则拒绝
  - **full sync 改成 source-owned public gate**：先把导出产物打到 temp target，在 temp target 跑 `pnpm check` / `pnpm lint` / `build` / `test:public` / startup acceptance；绿了才允许碰真实 `clowder-ai`
  - **本机 smoke 不再属于 full sync 主路径**：README/macOS 启动验收单独执行，且必须显式隔离端口/Redis，不能顺手碰 runtime
  - **所有猫：禁止对 runtime worktree 执行任何同步/清理脚本**（runtime 是生产环境，不是测试靶子）
  - **.env 应该有备份机制**（目前没有，gitignored 的敏感文件是单点故障）
- 来源锚点：
  - `scripts/sync-to-opensource.sh` L148-L164（新增 safety guard）
  - `.sync-provenance.json`（事故证据：source_commit=aa15355e, 时间 2026-03-21T14:29）
  - 铲屎官原话："他妈又在 runtime 改东西""什么配置都没了 这都没存档的 我都不记得有的怎么配的"
- 原理：`rsync --delete` 对目标目录的破坏是不可逆的（不进 trash，直接 rm）。破坏性操作的目标路径必须有正面验证（allowlist），不能只靠"别填错"。gitignored 的敏感配置文件是备份盲区——git 保护不了它们，IDE 缓存是碰运气。

- 关联：LL-015 Redis production Redis (sacred) | CLAUDE.md 四条铁律 | feedback_no_touch_runtime.md

---

## 8) 维护约定

- 本文件是入口，不替代 ADR/bug-report 原文。
- 新条目默认 `draft`，经交叉复核后改为 `validated`。
- 归档规则：被明确否定或被新机制完全替代时标 `archived`，保留历史链路。
