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

### LL-036: full sync 长跑不能在 Step 5 半路报喜——必须等脚本给出成功/失败结果

- 状态：validated
- 更新时间：2026-03-24
- 坑：`sync-to-opensource.sh` 进入 temp target public gate 后，Maine Coon多次在 `Biome check...` 或 `Smoke test (test:public)...` 阶段就回消息，误把“脚本还在跑 / 会话还活着”当成阶段完成。结果一旦执行停下，外部看到的是“同步到了 Step 5”，但真实 target 还没被碰到，PR/CI 也根本没开始。
- 根因：(1) 把长静默门禁误当成 checkpoint；(2) 只观察到了会话状态，没有等到脚本退出码和终态输出；(3) `opensource-ops` / outbound sync 文档之前写了 temp target public gate 必须全绿，但没把“执行中的猫不得在 Step 5 半路退出”写成硬约束。
- 触发条件：release-intended full sync / full sync 进入 temp target public gate，尤其卡在 `pnpm check`、`pnpm lint`、`build`、`test:public`、startup acceptance 这类长静默步骤时。
- 修复：
  - `cat-cafe-skills/opensource-ops/SKILL.md` 增加关键原则：full sync 是长跑门禁，不是中途 checkpoint
  - `cat-cafe-skills/refs/opensource-ops-outbound-sync.md` 增加执行纪律：Step 5 只允许以 `✓ Source-owned public gate passed` 或明确红灯失败作为退出条件
- 防护：
  - release / full sync 期间，只要脚本还没打印 `=== Sync complete ===` 或失败红灯，就继续守在执行链上
  - 禁止在 `Biome check...` / `Smoke test (test:public)...` / `Startup acceptance...` 这些中间状态汇报“已经到下一步”
  - 对外状态必须基于终态：`sync completed`、`PR opened`、`CI running`、`sync failed`
- 原理：Step 5 是 source-owned public gate 的单个阻塞门禁。它的业务含义不是“看起来跑到了哪一行日志”，而是“真实 target 是否被允许触碰”。在脚本没打印 `✓ Source-owned public gate passed` 之前，这个答案始终是否定的。

### LL-037: 共享记忆塑造视角——团队文化比模型参数更能影响判断趋同

- 状态：draft
- 更新时间：2026-03-25
- 坑：预期不同模型家族（Claude Opus vs GPT-5.4）会给出差异化观点，但本地两猫的观点反而比同模型家族的云端猫（GPT Pro）更趋同。差点把这种趋同当成"互相附和"忽略了。
- 根因：本地猫共享 shared-rules、共同经历（120+ features 的协作历史、同一套教训沉淀），这些"共享记忆"比底层模型参数更能塑造判断框架。云端猫虽同属 GPT 家族但缺乏这些共同经历，所以反而提出了更多不同视角。
- 触发条件：多猫独立思考/brainstorm 场景——当两只本地猫意见过度一致时，不要急于下结论是"互相附和"，也不要急于下结论是"充分验证"，需要引入无共享记忆的外部视角交叉校验。
- 修复：F129 生态调研中增加了云端 GPT Pro Deep Research 作为独立视角；本地两猫 + 云端猫三方碰撞后才做综合。
- 防护：
  - 高 stakes 的多猫独立思考，默认在扇入前引入至少 1 个无共享记忆视角；该视角第一轮只看原问题和最小中性背景，不看本地综合（锁死时序：先独立出结论，再碰撞）
  - 本地猫趋同时显式标注"⚠️ 可能受共享记忆影响"，不直接等价于"独立验证通过"
- 来源锚点：*(internal reference removed)* §3 + *(internal reference removed)* §Local Synthesis
- 原理：团队文化是一种隐性的 prompt——shared-rules、共同教训、协作习惯构成了比 system prompt 更深层的"预训练"。这不是坏事（恰恰说明团队文化在起作用），但在需要多元视角时必须意识到这个偏置。

---

### LL-038: Promise timeout 不等于 Promise 取消——并发重入的隐蔽根因

- 状态：validated
- 更新时间：2026-03-26

- 坑：F139 Phase 1a 的 TaskRunnerV2 实现了 `withTimeout()` 用 `Promise.race` 给 execute 加超时。timeout reject 后 `finally` 释放了 `running` 锁，但底层 execute 仍在运行——下一个 tick 绕过 overlap guard 进入了同一 task 的并发执行。Maine Coon第二轮 review 抓出此 P1。
- 根因：JS Promise 无法取消。`Promise.race([execute, timeout])` 只决定哪个先 settle 调用方，但输掉 race 的 promise 仍然在跑。如果 timeout 赢了就释放锁，等于告诉调度器"这个 task 空闲了"，而实际 execute 还在占用资源。
- 触发条件：任何用 Promise.race/setTimeout 做 timeout 的场景，如果 timeout 后释放了互斥资源（锁、信号量、连接池 slot）。
- 修复：
  - 引入 `pendingExecutes[]` 收集所有 raw execute promise
  - timeout 后照常记账 `RUN_FAILED`，但 `finally` 块在释放 `running` 锁前先 `await Promise.allSettled(pendingExecutes)`
  - 代价：`triggerNow` 在超时场景不会立即返回（可接受的 tradeoff）
- 防护：
  - **规则**：Promise timeout wrapper 不得在 finally 中直接释放互斥资源——必须等底层 promise settle
  - **测试**：`task-runner-v2.test.js` "concurrent reentry" 用例：gate 返回信号 + execute 永远 pending + timeout 触发 → 验证第二个 tick 被 overlap guard 拦截
- 来源锚点：
  - `packages/api/src/infrastructure/scheduler/TaskRunnerV2.ts` L139, L169
  - Maine Coon Round 2 review (2026-03-25): "timeout reject → finally → running=false，但 execute 还在飞"
- 原理：Promise 是 completion token，不是 cancellation token。race 只决定 observer 的视角，不影响 producer 的生命周期。在 JS 没有原生 AbortSignal 深度集成之前，timeout 和资源释放必须解耦。

- 关联：F139 Phase 1a PR #747 | ADR-022

---

### LL-039: gate 里推进 cursor 等于"还没干活就划卡"——execute 失败后事件丢失

- 状态：validated
- 更新时间：2026-03-26

- 坑：ReviewCommentsTaskSpec 的 gate 在筛选新评论时顺手推进了 `lastSeenCommentId` cursor。如果 execute 失败（网络超时、处理异常），这批评论就永远丢了——cursor 已经越过它们，下次 gate 不会再返回。
- 根因：gate 和 execute 是 TaskRunnerV2 pipeline 的两个独立阶段，gate 的职责是"判断有没有活"，不是"确认活干完了"。把 cursor 推进放在 gate = 乐观假设 execute 一定成功。
- 触发条件：任何 gate 阶段推进 cursor/offset/watermark 的模式，当 execute 可能失败时。
- 修复：`commitCursor()` 闭包模式——gate 计算新 cursor 值但不写入，把 commit 函数作为 signal 的一部分传给 execute，execute 成功后调用 `signal.commitCursor()`。
- 防护：
  - **规则**：gate 只读 cursor 做筛选，cursor 推进必须在 execute 成功路径上
  - **测试**：`review-comments-spec.test.js` "cursor not advanced on execute failure" 用例
- 来源锚点：
  - `packages/api/src/infrastructure/email/ReviewCommentsTaskSpec.ts` L81, L96
  - Maine Coon Round 1 review P2-1: "gate 里推进 cursor 是 over-optimistic"
- 原理：cursor/watermark 是"已确认处理完成"的标记，语义上等价于 Kafka consumer commit。Kafka 的 at-least-once 保证也要求 commit 在 process 之后，不在 poll 时自动推进。

- 关联：F139 Phase 1a PR #747 | ReviewCommentsTaskSpec

---

### LL-040: AI 写文档日期不能凭内部时间感——必须先 `date` 校准

- 状态：validated
- 更新时间：2026-03-27

- 坑：金渐层在 5 个文档中写入了 11 处未来日期（2026-06/07），实际当时是 2026-03。这是第二轮修复（第一轮 de2cb42f5 修了 F137）。
- 根因：LLM 没有可靠的内部时钟。金渐层的训练数据截止日期造成系统性时间偏差（+3~4 个月），在不调用 `date` 命令校准的情况下，凭"内部时间感"直接写入日期 = 幻觉。
- 触发条件：任何猫在文档中写入日期（timeline、changelog、KD 表、Phase 记录等）且未先确认当前日期时。
- 偏差模式：稳定 +3~4 个月，不是随机错误，是系统性偏差。
- 修复：commit `9f87d354e` 批量修正 5 文件 11 处（open-source-status / F048 / F055 / F121 / F134）。
- 防护：
  - **铁律：写日期前先 `date`** — 任何猫在文档中写入日期时，必须先执行 `date` 或从系统 prompt 中确认当前日期，禁止凭感觉写
  - **Review 检查项**：reviewer 核对文档中新增日期是否在合理范围内（不超过当前日期）
- 来源锚点：
  - 金渐层自述根因：内部时间感知幻觉 + 训练截止日期偏差
  - 第一轮修复：de2cb42f5（F137）、第二轮修复：9f87d354e（F048/F055/F121/F134/open-source-status）
- 原理：LLM 的时间感知是从训练数据中学到的统计分布，不是真实时钟。没有外部锚定（系统 prompt 日期注入或 `date` 命令），任何模型都可能产出偏移日期。这跟"内容幻觉"本质相同——模型生成看起来合理但事实错误的信息。

- 关联：金渐层日期幻觉 | 5 文件 11 处 | 两轮修复

### LL-041: 写完产物不主动打开 = 做了菜不端上桌

- 状态：validated
- 更新时间：2026-03-28

- 坑：Ragdoll写完诊断报告后只报了文件路径，没有帮铲屎官打开。铲屎官反问："我们有打开的能力，但你写完了竟然不帮我打开！"
- 根因：猫的工作流在"产出文件"这一步就画了句号，没有编码"呈现给铲屎官"这一步。workspace-navigator、browser-preview、rich block 等展示能力都存在，但只在铲屎官明确要求时才被动使用——缺少"何时主动展示"的触发时机。
- 触发条件：任何猫写完文件/跑完测试/改完前端/生成报告后，没有主动打开或展示给铲屎官。
- 修复：当次手动用 Navigate API 打开了报告。
- 防护：
  - **shared-rules W8 共享视图** — 将"产物端上桌"编码为世界观级规则，通过 GOVERNANCE_L0_DIGEST 注入所有猫的每次调用
  - **判断标准**：写完产物后问"铲屎官需要看到这个吗？"——是 → 按场景用 navigate / preview / rich block 打开
- 来源锚点：
  - 铲屎官原话："写完竟然不帮我打开！就和写完前端不帮我打开 preview 一样"
  - shared-rules.md W8 新增
  - SystemPromptBuilder.ts GOVERNANCE_L0_DIGEST W8 新增
- 原理：人猫协作是双向共享感知，不是单向任务完成汇报。愿景写的是"共享家园"——家人做了饭会端上桌，不会只喊一声"厨房锅里有饭"。猫的能力边界不只是"能做"，还包括"做完后展示"。这是人猫协作和人用 API 的本质区别（W1）。

- 关联：shared-rules W8 | workspace-navigator skill | browser-preview skill | 三天产品化诊断

---

### LL-042: 配置真相源不加门禁就会漂移——env 变量三处不同步
- 状态：validated
- 更新时间：2026-03-28
- 坑：`env-registry.ts`（Hub 用）、`.env.example`（新用户用）、代码里的 `process.env.XXX`（实际真相）三处各自为政，无任何自动化检查。结果：25+ 个变量代码里用了但 Hub 看不到，`.env.example` 只有 21 条 vs 实际 100+，8 个 HINDSIGHT 变量在 `.env.example` 里但代码从未引用。
- 根因：配置注册是纯文档契约（"新增 env 必须注册"写在注释里），但没有机器强制执行。人工纪律在 feature 交付压力下必然失守。
- 触发条件：任何新增 `process.env.XXX` 时忘记在 `env-registry.ts` 注册 + 没人发现。
- 修复：(1) 补齐 35 个漏网变量 (2) 新增 `check:env-registry`（扫描代码→registry 完整性）和 `check:env-example`（双向一致性） (3) 接入 `pnpm check` 硬门禁 (4) 新增 `exampleRecommended` 字段确保关键变量出现在 `.env.example`。
- 防护：`pnpm check` 现在覆盖 env 注册完整性，CI / gate 自动拦截遗漏。
- 来源锚点：
  - TD117 in `docs/TECH-DEBT.md`
  - `scripts/check-env-registry.test.mjs`
  - `scripts/check-env-example.test.mjs`
  - LL-030（同根问题：proxy 默认值改了没同步 .env）
- 原理：**多真相源必须有机器强制同步**。注释里写"请手动保持一致"等于没写。代价最低的时间点是新增代码时立即拦截，而不是部署后发现 Hub 里看不到变量。

- 关联：LL-030 | TD117 | env-registry.ts

---

### LL-043: 删旧层前必须证明迁移已落成，否则 startup 不能静默成功
- 状态：validated
- 更新时间：2026-03-28
- 坑：F136 Phase 4 删除了旧 `provider-profiles.ts` 读取层（PR #824, -2032 行），但迁移函数（PR #818）被 best-effort `try/catch` 包裹。当迁移未执行时，旧读取层已不在、新 `accounts` 也为空，服务静默带病启动。铲屎官在 runtime 上看到账号配置页全部"暂无模型"、API key 丢失。
- 根因：删除旧层与迁移成功之间没有 startup invariant 门禁。`accountStartupHook` 只做"迁移 + conflict scan"，不校验"旧源在但新数据缺"的不变量。非 HC-5 异常被 `index.ts:1444` 吞为 warn。
- 触发条件：迁移因任何原因失败（构建未更新、import 报错、文件系统异常等）+ 旧读取层已被同批或先前 PR 删除。
- 修复：(1) 手动触发迁移恢复数据 (2) PR #831 修复 per-project detection + credential clear 语义 (3) 记录 P2 follow-up: startup invariant guard（旧源在 + accounts 缺 → error/readiness fail）。
- 防护（待实施）：`accountStartupHook` 返回前增加不变量校验——`provider-profiles.json` 存在 + `catalog.accounts` 缺失 → 至少 error 级别暴露，理想为 startup hard fail。补回归测试覆盖此场景。
- 来源锚点：
  - F136 spec follow-up 章节
  - `packages/api/src/config/account-startup.ts`
  - `packages/api/src/index.ts:1436-1452`
  - 反思胶囊：*(internal reference removed)*
- 原理：**删除旧读取路径和迁移成功是原子操作的两端**。只删不验 = 中间态数据丢失。删旧层的 PR 必须同时包含：迁移成功回归测试 + legacy source 存在且新数据缺失时的 startup guard。

- 关联：LL-042 | F136 | account-startup.ts

### LL-044: Chrome IME 回车误提交——`e.nativeEvent.isComposing` 对 Enter 无效
- 状态：validated
- 更新时间：2026-03-28
- 坑：中文输入法按 Enter 选词时，Chrome 的事件顺序是 `compositionend` → `keydown(Enter, isComposing: false)`。与 Firefox 相反（Firefox 是 `keydown(isComposing: true)` → `compositionend`）。因此 `e.nativeEvent.isComposing` 守卫在 Chrome 上对 Enter 键无效，导致中文输入时按回车选词会直接提交表单。
- 根因：Web 规范未强制 `compositionend` 与 `keydown` 的顺序，Chrome 和 Firefox 实现不同。项目内 24 个输入组件全部使用了不可靠的 `e.nativeEvent.isComposing` 守卫，包括主聊天输入框。
- 影响范围：ChatInput（主聊天）、ActionDock（游戏发言）、ThreadItem/SectionGroup（重命名）、HistorySearchModal、SignalArticleDetail、StudyFoldArea、VoiceSettingsPanel、InlineTreeInput、BrakeModal、VoteConfigModal、BindNewSessionSection、SessionChainInputs、DirectoryBrowser、DirectoryPickerModal、InteractiveBlock、BrowserToolbar（URL 输入）、HubPermissionsTab（完全无守卫）、WorkspacePanel（搜索）、hub-tag-editor（标签提交）、SessionSearchTab（form submit）、QuickCreateForm（form submit×3）、SignalInboxView（form submit）。
- 修复：创建 `useIMEGuard` hook（`packages/web/src/hooks/useIMEGuard.ts`）。核心思路：用 `compositionstart/end` 事件驱动 ref，在 `compositionend` 后通过 `requestAnimationFrame` 延迟一帧清除 composing 状态，使得 Chrome 紧随其后的 `keydown(Enter)` 仍能被拦截。全量替换 24 个组件。
- 检查清单（新增 Enter 输入点必须遵守）：
  1. 禁止裸用 `e.nativeEvent.isComposing` 或 `e.key === 'Enter'` 无守卫
  2. 必须使用 `useIMEGuard` hook 并绑定 `onCompositionStart/End` + `ime.isComposing()` 守卫
  3. 测试 IME 场景时，模拟 `compositionstart` → `keydown(Enter)` 序列，不要用 `Object.defineProperty(event, 'isComposing', { value: true })`
- 关联：F080（输入历史）| ChatInput | ThreadItem

### LL-045: Runtime worktree 反复被猫污染——三次误删 + 进程表爆炸导致系统重启
- 状态：draft
- 更新时间：2026-03-31

- 坑：2026-03-29 ～ 2026-03-31 期间，runtime worktree（`cat-cafe-runtime`）被多个Ragdoll session 反复弄脏，导致 `pnpm start` 无法启动。发现三批污染：
  1. **WeixinAdapter voice_item A/B test**（`WEIXIN_VOICE_ITEM_MODE` env 切换 `minimal` vs `metadata`）——调试微信语音问题，直接在 runtime 编辑
  2. **invoke-single-cat.ts account resolution 调试**——插入 `appendFileSync('/tmp/cat-cafe-account-debug.log')` 文件日志 + 多个 `let→const` 误改（会导致运行时崩溃）+ proxy fallback if/else 逻辑被重构坏
  3. **`process-liveness-probe.test.js` 进程泄漏**——同一测试文件被多实例并发运行（疑似 watch 模式反复触发），每个实例 spawn 子进程不回收，进程数飙至 10472，Load Average 199，系统进入 `EAGAIN`（fork failed: resource temporarily unavailable），最终只能重启 macOS
  - 另有 Knowledge Feed markers（`docs/markers/*.yaml`）和开源同步残留（`LICENSE`、`ROADMAP.md`、`.sync-provenance.json`）出现在 runtime

- 根因：
  1. **P0 铁律执行失败**：`feedback_no_touch_runtime.md` 已明确"禁止直接操作 runtime worktree"，但多个 session 的Ragdoll仍然在 runtime 里直接编辑代码/运行测试/运行脚本
  2. **runtime 无写保护**：除了 `pnpm start` 时的脏检查（`git status -uno`），runtime worktree 没有任何机制阻止猫直接写入
  3. **测试进程无上限**：`process-liveness-probe.test.js` 涉及 spawn 子进程，但无 maxprocs / ulimit 保护，watch 模式下可指数膨胀
  4. **清理时二次伤害**：发现污染后，当前 session 的Ragdoll三次不检查内容就执行 `git checkout --` / `git clean -fd`，导致调试进度（invoke-single-cat.ts）和 Knowledge Feed markers 不可逆丢失

- 触发条件：
  - 猫在 runtime worktree 目录下执行编辑/测试/脚本（而非 feature worktree）
  - 测试涉及 process spawn 且在 watch 模式下运行
  - 发现脏文件后不检查内容直接清理

- 修复：
  - 第 1 批：stash 保留（`runtime-rescue: WeixinAdapter voice_item A/B test`），记录到 F137 changelog
  - 第 2 批：被误清理（`git checkout -- .`），diff 内容保存到 GitHub Issue #862
  - 第 3 批（进程爆炸）：`killall -9 node` + 系统重启

- 防护：
  1. **runtime worktree 写保护**：考虑用 `chflags uchg` 或 git hook 阻止非 `runtime-worktree.sh` 的写入
  2. **测试进程上限**：`process-liveness-probe.test.js` 需加 spawn 计数器 + `ulimit -u` 防护
  3. **清理前必须检查**：见 `feedback_never_clean_without_checking.md`——`git checkout/clean/rm` 前先 `ls`/`cat`/`git diff` 看内容，stash 优先于 checkout
  4. **脏检查应区分 tracked 和 untracked**：当前 `ensure_runtime_clean` 用 `-uno` 忽略 untracked 文件，markers/sync 残留不会阻止启动但会持续积累

- 来源锚点：
  - GitHub Issue: #862
  - F137 changelog 2026-03-29 条目
  - `feedback_never_clean_without_checking.md`
  - `scripts/runtime-worktree.sh` ensure_runtime_clean 函数

- 关联：F137（WeixinAdapter voice）| F118（invoke-single-cat audit）| #862 | feedback_no_touch_runtime.md

---

### LL-046: AOF/RDB 持久化脱节——冷启动加载空 AOF 导致 42K keys 归零
- 状态：validated
- 更新时间：2026-03-31

- 坑：重启 macOS 后 `pnpm start` 冷启动 Redis 6399，发现 915 个 thread / 42,778 keys 全部消失，只剩启动后新写入的 7 个 thread。铲屎官以为数据全丢了。
- 根因：**AOF 和 RDB 两套持久化机制脱节了 48 天**。
  1. 2月9日 `383e23791` 给 `start-dev.sh` 加了 `--appendonly yes`
  2. 2月10日首次带 AOF 启动，Redis 创建了 AOF base 文件（此时 DB 是空的 → base = 0 keys，88 bytes）
  3. 之后某次 Redis 被 restore 脚本或手动方式重启，**没带 `--appendonly`**，进入纯 RDB 模式
  4. 2月～3月：Redis 一直跑在纯 RDB 模式，数据涨到 42,778 keys。AOF 文件在 `appendonlydir/` 里吃灰，停留在 2月10日的空壳状态
  5. 3月31日：LL-045 进程爆炸 → macOS 强制重启 → Redis 进程死亡 → `pnpm start` 用 `--appendonly yes` 冷启动 → Redis 看到 `appendonlydir/` 存在 → **优先加载 AOF（空的）→ 忽略 110MB 的 dump.rdb** → 空库
- 以前没出事的原因：Redis 进程从来没被杀过。每次 `pnpm start` 发现 6399 已在跑就直连（`start-dev.sh:927`），不触发冷启动。这是第一次真正的冷启动。
- 救命的备份：`archive_redis_snapshot "pre-start"` 在每次 `pnpm start` 启动前自动备份 dump.rdb 到 `~/.cat-cafe/redis-backups/dev/`（保留 20 份）。今天 07:34 的 `dev-pre-start-20260331-073456.rdb` 包含完整的 42,778 keys，恢复成功。**这个机制源自 2月10日 LL-015 事故后的加固。**

- 修复（已提交 `3ae239a1a`）：
  1. **stale AOF 冷启动防护**（`start-dev.sh:716 maybe_quarantine_stale_aof_dir`）：冷启动前比较 AOF base 与 dump.rdb 体积比，dump/base >= 100 倍判定为 stale，自动隔离 `appendonlydir/` 到 backup
  2. **restore 脚本 AOF 盲区**（`redis-restore-from-rdb.sh:96`）：恢复后强制带 `--appendonly yes` 启动 + 旧 `appendonlydir` 迁移备份，杜绝"恢复后进入纯 RDB 模式"
  3. **回归测试**：28/28 通过，覆盖 stale 隔离、proportional base 保留、tiny base + incr 存在仍隔离三个场景

- 教训：
  1. **"以前没事"不等于"没有 bug"**——很多配置只在冷启动时生效，如果从来没冷启动过就从来不会暴露。定期冷启动演练是必要的
  2. **两套持久化机制必须保持同步**——Redis 的 AOF 优先于 RDB 加载，如果 AOF 是 stale 的，RDB 里的数据会被完全忽略
  3. **所有启动 Redis 的代码路径必须统一**——restore 脚本、手动启动、start-dev.sh 如果参数不一致，就会制造 AOF/RDB 脱节的窗口
  4. **备份机制越早建越好**——LL-015 的"坑"变成了 LL-046 的"救命稻草"

- 来源锚点：
  - 提交：`3ae239a1a fix(redis): harden stale AOF detection and restore startup`
  - 起因：`383e23791 feat(redis): isolate personal storage and add durability guardrails`
  - 关联：LL-015（Redis 端口误触事故）| LL-045（runtime 进程爆炸导致重启）

---

### LL-047: Socket.IO `cors` 不保护 WebSocket — `allowRequest` 才是安全边界
- 状态：validated
- 更新时间：2026-04-10

- 背景：Cat Cafe Hub 的 Socket.IO 实时通道被发现存在 CSWSH（Cross-Site WebSocket Hijacking）风险。`Origin: https://evil.example` 可以成功建立 WebSocket 连接到 `127.0.0.1:3004`

- 影响：恶意网页可从任意 Origin 连接本机 WebSocket，冒充用户、监听消息、干扰猫猫工作

- 根因：
  1. **Socket.IO v4 的 `cors` 配置只对 HTTP long-polling 生效**，不校验 WebSocket upgrade 请求的 Origin 头（Socket.IO 官方文档 2026-02-16 明确标注）
  2. 身份自报（`handshake.auth.userId`）无服务端校验
  3. Room 无 ACL，任何连接可加入任意 room
  4. @fastify/websocket 的 plain WS 端点（terminal PTY）完全绕过 Socket.IO，无任何 Origin 检查

- 修复：
  1. **Phase A**（PR #1041）：`allowRequest` hook 显式校验 Origin + 禁止自报 userId + 私网 Origin 收紧
  2. **Phase B**（PR #1045）：terminal WS Origin gate + cancelAll 授权 + 全局 room ACL
  3. **Phase D**（规划中）：HTTP session 替代自报身份 + Clickjacking + CSP + Prompt Injection 降权

- 教训：
  1. **框架的 CORS 配置 ≠ WebSocket 安全**——Socket.IO/Express 的 cors 中间件只管 HTTP，WebSocket upgrade 是独立的协议切换，必须在 upgrade 层单独校验
  2. **本机 ≠ 安全**——浏览器同源策略不阻止 JS 向 localhost 发 WebSocket 连接，任何打开的网页都是潜在攻击面
  3. **"能连上"比"能做什么"更危险**——一旦连接建立，后续的身份/Room/事件授权都是亡羊补牢；连接层拒绝是第一道也是最关键的防线
  4. **Agent 产品的攻击面比传统 Web 应用更大**——Prompt Injection、工具调用误用、外部内容驱动的高危操作是传统安全审计不覆盖的维度

- 来源锚点：
  - F156 spec：`docs/features/F156-websocket-security-hardening.md`
  - 三猫安全审计：*(internal reference removed)*
  - PR #1041（Phase A）、PR #1045（Phase B）
  - 外部参考：OpenClaw CVE-2026-25253 + ClawJacked（同类攻击链）

### LL-048: 用户可感知状态禁止默认 TTL——静默消失按 P0 治理
- 状态：validated
- 更新时间：2026-04-10

- 坑：F100 Self-Evolution 线程在创建 30 天后突然从 Hub UI 消失——不在列表、不在垃圾桶、搜索不到。铲屎官："太恐怖了！"
- 根因：`RedisThreadStore.ts` 硬编码 `DEFAULT_TTL = 30 * 24 * 60 * 60`（30 天），thread 创建时调用 `EXPIRE`。但 `updateLastActive()` 只更新排序分数，**从不刷新 hash TTL**。到期后 Redis 静默删除 hash，而 sorted set index 因其他 thread 操作续期而存活——形成"索引有 ID 但 hash 已消失"的孤儿状态。
- 触发条件：任何带非零 DEFAULT_TTL 的 Redis store（thread/message/task/summary/backlog/session 等），只要用户在 TTL 窗口内未触发恰好刷新 hash TTL 的操作，就会静默丢失。
- 修复：
  1. 全量止血：所有 16+ Redis store 的 DEFAULT_TTL 改为 0（persistent），`EXPIRE 0` / `SET EX 0` 陷阱用条件分支防御
  2. 自愈机制：`get()` 发现 hash 缺失时从 message timeline 重建元数据（`recoverThreadFromMessages`）
  3. 统一 key 续期：所有 detail 变更通过 `setDetailFields()`/`deleteDetailFields()` 自动调用 `applyKeyRetention()`
  4. 文档 + .env.example 同步更新
- 防护：
  1. 铁律 #5"禁止用户状态静默消失"——默认持久化，TTL 只能 opt-in
  2. 新增 Redis store 必须 DEFAULT_TTL=0，引入非零 TTL 需 P0 级审批
  3. 任何 `EXPIRE` / `SET EX` 调用必须有 `> 0` 守卫，防止 TTL=0 变成立即删除
- 来源锚点：
  - 根因文件：`packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts:32`
  - 丢失 thread：`thread_mmlv4v2oq6dxefr6`（2026-03-11 创建，2026-04-10 过期）
  - Feature spec：`docs/features/F100-self-evolution.md` line 54
- 原理：**EXPIRE 0 = 立即删除**（Redis 语义）。框架层 TTL 默认值决定了用户数据的生死线——这不是"配置"，而是产品决策。opt-out 持久化 = 用户必须知道一个他们不可能知道的配置才能保住自己的数据，这在产品层面是不可接受的。

---

### LL-049: `pnpm dev:direct` 无差别杀端口——review 踢翻 runtime
- 状态：draft
- 更新时间：2026-04-11

- 坑：2026-04-10，Maine Coon在 review F152 PR (#1070) 时，在主仓库执行 `pnpm dev:direct`。`start-dev.sh` 的 `kill_managed_ports()` 无条件杀掉 3003/3004 端口上的进程——正在运行的 runtime 被踢掉，铲屎官被动中断。
- 根因：
  1. **`kill_port()` 不检查进程归属**：谁占着端口就杀谁，不区分是本 worktree 残留还是 runtime/alpha 等其他实例
  2. **护栏分裂**：`runtime-worktree.sh` 有 `CAT_CAFE_RUNTIME_RESTART_OK` 授权门，但 `dev:direct` 走 `start-dev.sh`，绕过了这道门
  3. **`guard_main_branch_start()` 盲区**：只拦 `main` 分支 + `cat-cafe` 仓库名，主仓库切到 feature branch 照样触发事故
  4. **review 沙盒规范有文档无工具**：request-review skill 写了"在沙盒操作"，但缺少统一入口和强制机制
- 触发条件：任何猫在非隔离环境（主仓库、错误 worktree）执行 `pnpm dev:direct` / `pnpm start`，且 runtime 正在使用相同端口
- 修复（PR #1077，已合入 `807536df5`）：
  1. 新增 `pid_cwd()` + `path_is_within_project()` + `guard_port_kill_ownership()`：`kill_port()` 前检查占用进程的工作目录是否属于当前 `$PROJECT_DIR`，跨 worktree 默认拒绝 kill
  2. `CAT_CAFE_RUNTIME_RESTART_OK=1` 显式授权才放行
  3. 新增 `scripts/review-start.sh`（`pnpm review:start`）：review 验证统一入口，自动分配 3201/3202 端口、内存 Redis、review 沙盒路径
  4. review 模板新增"沙盒路径 + 启动命令 + 实际端口"必填字段
- 防护：
  1. `start-dev.sh` 端口归属 guard（基于进程 cwd，不硬编码端口号）——任何端口冲突都能防
  2. 回归测试覆盖"默认拒绝跨 worktree kill"和"显式授权放行"两条路径
  3. `pnpm review:start` 统一入口消除"在哪启动、用什么端口"的歧义
  4. request-review 模板强制证据字段（reviewer 必须填沙盒路径和端口）
- 来源锚点：
  - 事故报告：`docs/bug-report/2026-04-10-review-dev-direct-runtime-interruption/bug-report.md`
  - 修复 PR：zts212653/cat-cafe#1077
  - 端口归属 guard：`scripts/start-dev.sh:450`（`guard_port_kill_ownership`）
  - review 入口：`scripts/review-start.sh`
- 原理：**"默认安全"优于"靠人记得"**。LL-045 证明纪律文档拦不住猫——写了"不要动 runtime"但多个 session 仍然直接操作。端口保护和 Redis production Redis (sacred)一样，必须在工具层面做到"默认不可能发生"，而非"读了文档就不会发生"。

- 关联：LL-045（runtime worktree 反复被猫污染）| PR #1077 | `feedback_no_touch_runtime.md` | CLAUDE.md 铁律 #4

---

### LL-050: ADR 漂移 2 个月无人发现——Feature 完成不扫知识影响
- 状态：draft
- 更新时间：2026-04-13

- 坑：ADR-009（2026-02-10）选择"仅用户级 skill 分发"，F070（2026-03-08）引入项目级 governance bootstrap，事实性推翻 ADR-009 的核心假设。但 F070 完成时未触发任何 ADR/spec 影响检查，导致 ADR-009 以 `active` 状态存续 2 个月，直到社区 issue clowder-ai#386（2026-04-08）才暴露。
- 根因：
  1. **Feature 完成无"知识影响扫描"**：feat-lifecycle close step 不检查新 Feature 是否推翻了现有 ADR/spec 的前提
  2. **ADR 缺 machine-readable 状态**：无 `drifted`/`superseded` 状态字段，`search_evidence` 无法区分过时文档和当前真相
  3. **双层挂载无一致性校验**：preflight 只检查项目级 symlink 存在，不校验跨层一致性
- 触发条件：任何 Feature 改变了现有 ADR 的核心假设，但 Feature 完成时无人检查
- 修复：
  1. ADR-009 已标注 `status: drifted`（2026-04-07）
  2. ADR-025 作为 successor ADR 已完成三猫 review（2026-04-13 收敛）
  3. ADR/spec frontmatter 新增 `status: active|drifted|superseded|historical` + `drifted_by` + `last_reviewed` 字段
- 防护（待落地）：
  1. feat-lifecycle close step 增加"知识影响扫描"：新 Feature 是否改变了现有 ADR/spec 的假设？
  2. `search_evidence` 检索排序降权 drifted/historical 文档
  3. 定期 ADR 巡检（半年一次 `last_reviewed` 刷新）
- 来源锚点：
  - 社区 issue：[clowder-ai#386](https://github.com/zts212653/clowder-ai/issues/386)
  - ADR-009 drift 标注：`docs/decisions/009-cat-cafe-skills-distribution.md`
  - Successor ADR：`docs/decisions/025-skills-canonical-mount-policy.md`
- 原理：**知识也有保质期**。ADR 记录的是某个时间点的决策假设，后续架构演进可能悄悄推翻这些假设。如果只靠猫的记忆发现漂移，检测延迟 = Feature 交付频率的倒数。必须在 Feature completion 工具层面做"知识影响扫描"，才能把漂移窗口从月级压到天级。

- 关联：ADR-009 | ADR-025 | F070 | clowder-ai#386 | `project_knowledge_lifecycle_gap.md`

---

### LL-051: 实验框架空转——造了铁路没装货物
- 状态：draft
- 更新时间：2026-04-18

- 坑：F163 记忆熵减用 3 Phase 建了完整实验基础设施（schema V14 多轴元数据 + 7 flag + experiment logger + shadow mode + Health Tab UI），shadow 模式运行 32 小时、记录 448 次搜索。诊断发现三层空转：① 1501 篇文档 authority 全部是 `observed`（默认值），boost 权重全 1.0 等于无 boost；② shadow payload 只记 `{query, resultCount}`，没记录 before/after 排序对比；③ `evidence.ts:117` 硬编码 `confidence: 'mid' as const`，前端无信号差异。
- 根因：
  1. **坐标系错误（Round 4 原理）**：核心需求是"重要知识排前面"，最小方案是 `pathToAuthority()` 纯函数 + backfill。但选了"先建完整实验框架再灰度上线"的路径，把 70% 工作量花在框架本身而非核心价值。
  2. **Phase 拆分遮蔽空洞**：每个 Phase 有自己的 AC 并全部通过，但 AC 验的是"能力存在"不是"能力有效"。`applyAuthorityBoost()` 存在且可调用 → AC pass，但所有文档权重 1.0 → 实际无效。
  3. **Shadow mode 设计半成品**：spec 要求"后台并行跑新策略，记录差异"，实现只记了 flag snapshot + query，没记排序差异——因为差异计算依赖 authority 分化，而分化从未发生。
- 触发条件：任何 feature 用"先建框架 → 再填数据"的顺序推进，且 AC 只验证框架存在性而非端到端效果
- 修复：
  1. 写 `pathToAuthority()` 纯函数，索引时从路径/frontmatter 自动派生 authority（而非手动 promotion）
  2. 修 `confidence: 'mid' as const` → 从 authority 派生 high/mid/low
  3. 直接切 `F163_AUTHORITY_BOOST=on`（跳过无价值的 shadow）
- 防护：
  1. Feature AC 必须包含至少一条"端到端效果验证"（不只是"能力存在"）
  2. 实验 flag 开 shadow 后 48h 内必须检查 payload 是否包含对比数据——空跑 shadow 浪费资源且给人虚假安全感
- 来源锚点：
  - F163 shadow 数据诊断：`evidence.sqlite` f163_logs 表 448 条 search、authority 分布 100% observed
  - 硬编码 confidence：`packages/api/src/routes/evidence.ts:117`
  - Meta-Aesthetics canon（从 Round 4 数学之美升格）：`docs/canon/meta-aesthetics.md`
- 原理：**Agent Quality = Model Capability × Environment Fit**（Round 4）。F163 在 Environment 侧堆了大量维度（多项式拟合），但没有验证任何一个维度是否真正改善 Fit。正确的路径是坐标变换：找到"authority 信号已经在文档路径里"这个洞察，用一个纯函数解决，而不是建一整套实验框架去"发现"这个答案。最优表达在正确坐标系下必然最简。

- 关联：F163 | Round 4 数学之美讨论 | LL-050（知识漂移）

---

### LL-052: `exec VAR=val cmd` 不设置环境变量——bash 把它当可执行名
- 状态：draft
- 更新时间：2026-04-18

- 坑：shell 启动脚本里 `exec ${env_prefix}pnpm run start`（`env_prefix="NODE_ENV=production "`）直接启动失败，bash 报 "NODE_ENV=production: command not found"。结果不是"设置环境变量后再 exec pnpm"，而是把 `NODE_ENV=production` 当成可执行文件名去 PATH 里查找。F153 intake clowder-ai#512 合入当天社区小伙伴启动就挂。
- 根因：
  1. **`exec` builtin 不解析内联赋值**：bash 的 `VAR=val command arg` 形式，**只有当 command 是外部可执行程序**（如 `env`、`pnpm`）时，内联 `VAR=val` 才会作为临时环境变量传递。`exec` 是 shell builtin，走 replace-current-process 路径，第一个 token 直接被当成要 exec 的 program name——`NODE_ENV=production pnpm` 等同于 `exec 'NODE_ENV=production' pnpm`。
  2. **字符串断言掩盖启动失败**：`test/start-dev-script.test.js` 只断言 `printf "$(api_launch_command)"` 输出 `"cd ... && exec NODE_ENV=... pnpm ..."` 这个字符串字面量，没有 `eval` 这段输出验证进程真能启动。CI 全绿但 `pnpm run start` 从未被实际执行过。
- 触发条件：shell 脚本里 `exec ${prefix}command` 模式，`prefix` 含内联环境变量赋值（`VAR=value `）
- 修复：改写成 `exec env ${prefix}command`——`env` 是 POSIX 外部程序，会正确解析内联赋值并把变量注入子进程
- 防护：
  1. Shell 启动脚本的单测不能只断言 `printf` 输出文本，至少一个 case 必须 `bash -n` 语法检查 + 在 mock 环境下 `eval` 这段命令验证 exit code（或跑 `pnpm dev:direct --dry-run`）
  2. Intake 社区 PR 改动 `scripts/**` 尤其启动/runtime 脚本时，reviewer checklist 加一条"本地跑一次 `pnpm alpha:start` 或 `pnpm dev:direct` 确认实际能启动不报错"
- 来源锚点：
  - Bug report: `clowder-ai#526`（2026-04-18 社区小伙伴报挂）
  - 引入 commit: `cat-cafe:206ae80c40`（F153 intake clowder-ai#512）
  - 修复 commit: `cat-cafe:bf5f54b9`（PR #1257）+ `clowder-ai:6ab02c44`（PR #527）
  - 修复位置: `scripts/start-dev.sh:683-685` `api_launch_command()`
- 原理：**`VAR=val command arg` 语法中 `VAR=val` 是"赋值前缀"还是 argv[0] 取决于 command 的类别**——外部程序会被 shell 剥离前缀作为临时 env 传递；builtin（`exec` / `source` / `:`）则直接把前缀当成参数。`env` 这个 POSIX 工具的存在就是为了让"在指定环境下运行程序"成为一个可被任何 builtin/context 调用的显式动作。**任何需要给子进程设环境变量又必须经过 builtin（典型就是 `exec`）的场景，用 `env` 显式承接。**

- 关联：F153 intake clowder-ai#512 | clowder-ai#526 | cat-cafe#1257 | clowder-ai#527

---

## 8) 维护约定

- 本文件是入口，不替代 ADR/bug-report 原文。
- 新条目默认 `draft`，经交叉复核后改为 `validated`。
- 归档规则：被明确否定或被新机制完全替代时标 `archived`，保留历史链路。
