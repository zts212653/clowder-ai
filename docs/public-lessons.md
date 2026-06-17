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
- 防护：分歧无法收敛时升级operator裁决，不允许用“非 blocking”逃避判断。
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
  - `review-notes/README.md`

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
  - `review-notes/README.md`

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
- 防护：CLAUDE.md 明确禁止 `/bin/rm`；operator shell 配置 `rm` alias → `trash`。
- 来源锚点：
  - CLAUDE.md "删除文件必须用 trash" 段落（auto memory 2026-02-12）
  - 2026-02-12 实际犯错事件
- 原理：不可逆操作必须有安全网（垃圾桶 = undo buffer）。绕过安全网的捷径永远比它节省的时间更危险。

- 关联：CLAUDE.md operator硬规则

### LL-011: Worktree 清理的正确顺序——先 push，再 cd 回主仓，最后 remove
- 状态：validated
- 更新时间：2026-02-13

- 坑：(1) 在 worktree CWD 里执行 `git worktree remove` 删除自己 → shell 悬空，什么都做不了。(2) 先删 worktree 再想 push → 站在虚空里连记忆都改不了，operator笑着救了我。两次犯同类错误。
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

- 坑：`git add myfile && git commit` 但暂存区已有上次 session 或operator留下的文件，导致无关改动混入 commit。
- 根因：`git add` 是追加操作，不是替换操作。暂存区是累积状态，不会因为新 add 而清空之前的内容。
- 触发条件：连续 session 之间，或operator手动操作后，暂存区有残留文件。
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

- 坑：收到operator汇报的 URL 路由缺失 bug 后，直接修代码，没写 bug report 也没写 review 信。被operator批评：没有记录 = 无法复盘。
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

- 坑：在 worktree 工作时未设置 REDIS_URL，服务回落到默认 6399（operator数据），数据从 307 keys 降至 15 keys（95% 丢失）。虽最终从 RDB 备份完全恢复，但过程惊险。
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

- 坑：茶话会夺魂 bug 调试时，修 bug 的Ragdoll（分身 session `[thread-id]`）找到了 `~/.codex/AGENTS.md` 全局注入后就停了——"这能解释为什么Maine Coon去跑 superpowers"。但operator追问："可它怎么知道 Phase 5 的？AGENTS.md 里又没有 Phase 5。"这一问才逼出了真正的根因——Session 跨 thread 污染。如果operator没追问，我们只会修触发器，留下根因。
- 根因：AI 模型的推理模式倾向于在找到"看起来说得通"的第一层解释后停止追溯。"看起来合理"≠"因果链完全闭合"。AGENTS.md 能解释 superpowers 行为但解释不了 Phase 5 知识来源——因果链有断点，但模型没有主动识别。
- 触发条件：找到一个能解释部分症状的原因时；时间压力下想快速修复时；root cause 和 trigger 看起来像同一件事时。
- 修复：operator持续追问直到因果链完全闭合。每个"解释"都要验证：它能解释所有症状吗？有没有它解释不了的？
- 防护：bug 根因分析清单增加"因果链闭合检查"——列出所有症状，确认提出的根因能逐一解释每个症状。解释不了的 = 根因不完整，继续挖。
- 来源锚点：
  - *(internal reference removed)* §5 Step 6（operator追问 Phase 5 来源）
  - 实际修 bug session: `[thread-id]`
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
  - `project-runbooks/hindsight-p0-health-check.md`
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
  - 2026-02-27 四猫 + operator讨论
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
  - 2026-02-27 operator运行时观察
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
- 现象：到了交付阶段仍在"先做个简陋版本让operator验收"，交付半成品而非完整 feat。内部实现步骤被暴露为交付批次，operator被迫反复验收中间产物。产出后续要重写而非扩展，等于做了两遍。
- 根因：从"什么容易做"往前凑，而不是从终态往回推。把探索阶段的习惯（spike/MVP）带到了交付阶段。
- 典型症状：先做内存 Map 模拟再换 Redis、先搭空壳模板再填真逻辑、先造通用框架再写业务。
- 对策：
  1. Planning 阶段先钉终态 schema，每步产物必须在终态中原样保留（可扩展不可替换）
  2. 步骤是内部实现节奏，不是给operator看的交付批次；交付物是完整 feat
  3. 纯探索显式标注 Spike（时间盒 + 产出结论），不伪装成交付物
  4. Quality gate 自检：后续要"重写"还是"扩展"？重写 = 绕路
- 来源锚点：2026-03-05 operator反馈 + Ragdoll/Maine Coon联合分析
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
- 来源锚点：2026-03-09 operator发现Ragdoll(另一线程)只看 spec 就声称 feat 未完成
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
  - GPT-5.4 愿景守护 2026-03-14（[thread-id]）
- 原理：AC 是 feature contract 的一部分，每个字段都是承诺。"大部分实现"≠"AC 达成"。quality gate 的价值在于精确性，不在于速度。

- 关联：LL-029 交付物验证不能只看 spec checkbox

### LL-032: 愿景守护不能只看代码和测试报告——必须真实启动 dev 跑一遍
- 状态：validated
- 更新时间：2026-03-14

- 坑：F101 狼人杀被声明 done（2026-03-12），愿景守护由 GPT-5.4 审查并 pass。92 个单元测试全绿、190+ 游戏测试全绿。但 2026-03-14 operator第一次真的启动 dev 点开狼人杀后发现：(1) GameShell 接了 onClose 但没渲染关闭按钮——用户被困在全屏游戏里出不来；(2) 无大厅/配置流程——硬编码 7 只猫自动塞入；(3) 猫猫 AI 不会自动行动——游戏永远卡在 night_guard 等待；(4) 与 .pen 设计稿的 UX 差距大。整体不可用。
- 根因：愿景守护是通过阅读代码、测试报告和 spec checkbox 完成的，没有一只猫真的启动 `pnpm dev`，打开浏览器，点击"狼人杀"，选个模式，看看会发生什么。单元测试验证的是组件/引擎的孤立行为，不是端到端用户体验。"每个部件都对"≠"组装起来能用"。
- 触发条件：feature 有前端 UI + 后端引擎 + WebSocket 实时交互等多层集成时；只跑单元测试不做 E2E 验证时。
- 修复：(1) 重新打开 F101，补 Phase C 可用性修复；(2) 新增 AC-C4 要求 codex/gpt52 启动 dev 做真实 E2E 验收。
- 防护：愿景守护增加"真实环境启动验证"环节——对于有 UI 的 feature，reviewer 或operator必须至少启动一次 dev 环境并走通核心流程。不方便的话至少把 dev 启动好让operator一起测。
- 来源锚点：
  - `docs/features/F101-mode-v2-game-engine.md` Phase C（2026-03-14 补充）
  - operator 2026-03-14 消息："你们没人点开 dev 启动你们的东西跑过真的测试嘛？"
  - operator 2026-03-14 截图：night_guard 全员等待，无关闭按钮
- 原理：集成系统的正确性不能由组件测试的总和保证。单元测试验证的是"每个零件符合 spec"，不是"零件组装后的机器能工作"。对于用户直接使用的 feature，最终验收必须包含真实环境启动 + 用户视角走查。

- 关联：LL-029 交付物验证 | LL-031 Quality gate 逐字段对账 | LL-006 没有新鲜验证证据不得宣称完成

### LL-033: remote review 不能只看 review body state——必须检查 inline code comments

- 状态：validated
- 更新时间：2026-03-18
- 坑：PR #543 云端 Codex review 的 review body 显示 `COMMENTED`（通常意味着"no major issues"），但实际在 inline code comment 里提了一个 P1（flushDirtyThreads 用了空的 threadMemory.summary 会 30 秒后删除 rebuild 刚建好的 thread 索引）。Ragdoll只看了 review body 就 merge 了，漏掉了 P1。
- 根因：`gh pr view` 的 `--json reviews` 只返回 review body，不返回 inline code comments。必须额外调 `gh api repos/.../pulls/N/comments` 才能看到 inline comments。
- 触发条件：remote review 给了 `COMMENTED` state + 有 inline P1 code comment。
- 防护：
  - merge-gate 流程加一步：**必须检查 inline comments**（`gh api repos/{owner}/{repo}/pulls/{N}/comments`），不能只看 review body
  - 看到 `COMMENTED` 不等于通过——要看完整 comments 再判断
- 来源锚点：
  - PR #543: fix(F102-E): thread indexing reads message content
  - operator experience："等会！这个 codex 云端他给你提了 p1 的你怎么就合入了？"
- 关联：merge-gate skill、remote review 流程

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
- operator experience："你用 cpu！为什么不用 gpu 啊！！你这实现我拒绝。你这不又是脚手架，有其他同样模型的参考实现你还非得实现成现在这样。"
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
  - operator experience："他妈又在 runtime 改东西""什么配置都没了 这都没存档的 我都不记得有的怎么配的"
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

- 坑：Ragdoll写完诊断报告后只报了文件路径，没有帮operator打开。operator反问："我们有打开的能力，但你写完了竟然不帮我打开！"
- 根因：猫的工作流在"产出文件"这一步就画了句号，没有编码"呈现给operator"这一步。workspace-navigator、browser-preview、rich block 等展示能力都存在，但只在operator明确要求时才被动使用——缺少"何时主动展示"的触发时机。
- 触发条件：任何猫写完文件/跑完测试/改完前端/生成报告后，没有主动打开或展示给operator。
- 修复：当次手动用 Navigate API 打开了报告。
- 防护：
  - **shared-rules W8 共享视图** — 将"产物端上桌"编码为世界观级规则，通过 GOVERNANCE_L0_DIGEST 注入所有猫的每次调用
  - **判断标准**：写完产物后问"operator需要看到这个吗？"——是 → 按场景用 navigate / preview / rich block 打开
- 来源锚点：
  - operator experience："写完竟然不帮我打开！就和写完前端不帮我打开 preview 一样"
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
- 坑：F136 Phase 4 删除了旧 `provider-profiles.ts` 读取层（PR #824, -2032 行），但迁移函数（PR #818）被 best-effort `try/catch` 包裹。当迁移未执行时，旧读取层已不在、新 `accounts` 也为空，服务静默带病启动。operator在 runtime 上看到账号配置页全部"暂无模型"、API key 丢失。
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

- 坑：重启 macOS 后 `pnpm start` 冷启动 Redis 6399，发现 915 个 thread / 42,778 keys 全部消失，只剩启动后新写入的 7 个 thread。operator以为数据全丢了。
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

- 坑：F100 Self-Evolution 线程在创建 30 天后突然从 Hub UI 消失——不在列表、不在垃圾桶、搜索不到。operator："太恐怖了！"
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
  - 丢失 thread：`[thread-id]`（2026-03-11 创建，2026-04-10 过期）
  - Feature spec：`docs/features/F100-self-evolution.md` line 54
- 原理：**EXPIRE 0 = 立即删除**（Redis 语义）。框架层 TTL 默认值决定了用户数据的生死线——这不是"配置"，而是产品决策。opt-out 持久化 = 用户必须知道一个他们不可能知道的配置才能保住自己的数据，这在产品层面是不可接受的。

---

### LL-049: `pnpm dev:direct` 无差别杀端口——review 踢翻 runtime
- 状态：draft
- 更新时间：2026-04-11

- 坑：2026-04-10，Maine Coon在 review F152 PR (#1070) 时，在主仓库执行 `pnpm dev:direct`。`start-dev.sh` 的 `kill_managed_ports()` 无条件杀掉 3003/3004 端口上的进程——正在运行的 runtime 被踢掉，operator被动中断。
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

### LL-053: 无头 Codex CLI 长任务不能靠 shell 伪后台——要么守住 `session_id`，要么真正 detached spawn
- 状态：draft
- 更新时间：2026-04-20

- 坑：在 Codex CLI 无头 `exec_command` 环境里，把长任务写成 `bash ... &`、`nohup ... &`、`disown` 或 `setsid`，CLI 返回后看起来“命令发出去了”，但后台子进程常常已经跟着父命令一起死。于是会误判“还在跑”，实际任务根本没活。
- 根因：
  1. **把 shell 作业控制误当成 harness 生命周期控制**：`&` / `nohup` / `disown` / `setsid` 只是 shell 级语义；在无头 CLI harness 里，顶层命令退出后，同一进程树里的后台子进程仍可能被回收。
  2. **把轮询误当保活**：实测前台长任务拿到 `session_id` 后，即使隔 15 秒再 `write_stdin` 也能正常收尾。轮询只是读取进度/结果，不是给进程“续命”。
- 触发条件：任何从无头 CLI 里拉 sidecar、proxy、测试服务、长脚本、fire-and-forget worker，尤其是想偷懒用 shell `&` 时。
- 修复：
  1. **需要交互/输出**：保持前台，接住 `session_id`，后续继续在同一个 session 上 `write_stdin`
  2. **需要真正后台脱离**：用 Node `spawn(..., { detached: true, stdio: 'ignore' })` + `child.unref()`，并把日志/结果文件作为外部探针
- 防护：
  1. 原生 system prompt 明确禁用“在无头 CLI 里拿 shell 伪后台跑持久任务”
  2. Fire-and-forget 任务必须同时定义 `pid` / `log` / `result` 探针；没有外部探针，不算启动成功
  3. 命令已经返回 `session_id` 时，不要重开新命令抢跑；优先续同一个 session
- 来源锚点：
  - *(internal reference removed)*
  - *(internal reference removed)*
  - *(internal reference removed)*
  - `packages/api/src/domains/cats/services/agents/providers/GeminiAgentService.ts`
- 原理：**长任务的关键不是“后台”两个字，而是谁拥有生命周期。** 需要持续交互时，生命周期应该绑在当前 `session_id`；需要任务脱离对话继续跑时，必须显式切换到真正 detached 的进程组，并用外部探针观测。shell 伪后台只是“看起来像分叉了”，不是可靠的 liveness ownership。

- 关联：`assets/system-prompts/cats/codex.md` | *(internal reference removed)*

---

### LL-054: 猫的 callback env 泄漏到 unit test 子进程——用真身份发出 6 条 'hi'
- 状态：validated
- 更新时间：2026-05-07

- 坑：F193 Phase A Task 3 写 `post-message-kd1-mcp-handler.test.js` 时漏 `beforeEach` mock fetch；跑 `pnpm --filter @cat-cafe/mcp-server test` 时，`node:test` 子进程继承了 Claude Code agent process 自带的 callback env (`CAT_CAFE_API_URL=http://127.0.0.1:3004` + `CAT_CAFE_INVOCATION_ID` + `CAT_CAFE_CALLBACK_TOKEN`)。测试里那行 `handlePostMessage({ content: 'hi' })` **用了猫自己当前 invocation 的真身份**，把 'hi' 发到当前对话 thread。跑 6 次 = 6 条假 hi 出现在operator thread 里，签名"Ragdoll (Opus 4.7)"，看起来像 cron job。
- 根因：
  1. **根因 A（猫疏忽）**：unit test 文件没写 `beforeEach` mock + env override；只 mock 在用到的 test case 里 → 漏 mock 的 case fall-through 到真 fetch
  2. **根因 B（结构性）**：cat agent process 自身 env 就有 callback config（这是 MCP `post_message` 工具能跑的前提），跑 child process 时**默认全继承**——和 worktree 隔离无关，main / worktree / 任何 cwd 都一样会泄漏。原先以为问题是"worktree env 泄漏"是误诊
  3. **根因 C（错认场景）**：mcp-server unit test 不该有任何"hit 真 callback URL"的可能——目前 `callback-tools.test.js` 已经在 `beforeEach` 设了 `CAT_CAFE_API_URL=http://127.0.0.1:3004` + 加 fetch mock，但只有那一个 file 这么做，没有共享 helper 强制其他测试 file 也走同样模式
- 触发条件：在 cat agent invocation 进程里跑 `pnpm test` / `node --test`，且测试代码会调到 `handlePostMessage` / `handleCrossPostMessage` / 任何会 read `CAT_CAFE_API_URL` env 的 callback helper，且没在 `beforeEach` mock fetch + override env。**注意**：和 cwd（main / worktree）无关，纯继承父 process env。
- 修复（已落地）：
  1. `packages/mcp-server/test/post-message-kd1-mcp-handler.test.js` 加 `beforeEach`：`CAT_CAFE_API_URL=http://127.0.0.1:1`（关闭端口，ECONNREFUSED 即使 mock 漏）+ stub `globalThis.fetch`，`afterEach` 还原
  2. 加 `assert.equal(fetchCalled, false)` 断言：把"KD-1 guard 必须 reject 在 fetch 之前"变成回归保护
  3. Commit `8fea021f1`，已 push `feat/F193-cross-thread-comm`
- 防护（待落地）：
  1. **shared-rules §19**（本 LL 同时落）：cat agent 进程跑 unit test 前必须在 `beforeEach` override `CAT_CAFE_API_URL` 到 closed 端口 + mock `globalThis.fetch`
  2. **测试 helper（建议 follow-up）**：`packages/mcp-server/test/helpers/callback-test-env.js` 导出 `setupClosedCallbackEnv()` / `restoreCallbackEnv()`，新写测试 import 一行就拿到 fail-closed 默认值。F193 Phase A 完成后开 follow-up TD
  3. **CI lint（建议 follow-up）**：扫所有 `*.test.js`，凡 import 了 `handlePostMessage` / `handleCrossPostMessage` 但没 `beforeEach` 设 closed `CAT_CAFE_API_URL` → CI fail
- 来源锚点：
  - `docs/features/F193-cross-thread-comm-unification.md`（事故发生在该 feature Phase A 实施期间）
  - `packages/mcp-server/test/post-message-kd1-mcp-handler.test.js`（修复点）
  - commit `8fea021f1` (fix(F193): mock fetch + override env in AC-A2 test)
  - 截图证据：`/home/user/cat-cafe-runtime/packages/api/uploads/1778205224706-386492e0.png`
- 原理：**子进程默认继承父 process env，是 OS 级行为不是 shell quirk**。任何用真 callback config 跑的进程（猫的 invocation 进程）下面派生的子进程（pnpm/node test runner）天然带这套 env。Unit test 必须**显式擦除**这些可能触发 side-effect 的 env，不能依赖"测试通常不发 HTTP"的乐观假设。fail-closed 优于 fail-fast——把 URL 指向 closed 端口，比单靠 fetch mock 多一层防御。

- 关联：`cat-cafe-skills/refs/shared-rules.md §19` | F193

### LL-055: spawn 出的"长尾 child runtime"必须能脱离 parent 自动死亡
- 状态：draft
- 更新时间：2026-05-09（src extension）

- 坑：两次同模式踩坑，1 天内连续暴露——
  1. **Test infra（首次）**：`process-liveness-probe.test.js` spawn `node -e while(true){}` 作为 busy CPU child；测试异常退出（runner timeout / 用户 Ctrl+C / `pnpm gate` 中断）时漏掉 child cleanup，每次泄漏一只 PPID=1 孤儿进程。累积 4 只时占满 ~270% CPU，导致 runtime `pnpm dev:direct` 在 20s 超时窗口内起不来 3002，看起来像"启动超时 + tsx Force killing"诡异连锁，根因实际在测试设计。
  2. **Src（次日 2026-05-09 发现）**：`packages/api/src/.../first-run-quest/client-detection.ts` 用 `execAsync('opencode version', { timeout: 5000 })` 探测 OpenCode CLI 是否安装。`opencode version` 不是简单 CLI 查询——`opencode` 是 agent runtime，`version` 子命令会拉起完整 agent process。`exec` 的 `timeout` 默认发 SIGTERM；agent process 不响应就僵住，parent promise reject 后 child 成 PPID=1 + 67% CPU 烧 50 分钟孤儿。**这是 LL 的范围扩展——同模式不限于 test，src 里"靠 SIGTERM 链 kill 复杂 child runtime"是同样系统性漏洞。**
- 根因：
  1. **结构性**：测试设计依赖 parent SIGTERM handler 链式 kill child；macOS 没有 Linux `PR_SET_PDEATHSIG`，parent 异常死亡（SIGKILL / runner timeout / Ctrl+C）后 child 不会自动陪葬，被 launchd 收编成 PPID=1，继续 `while(true)` 烧 CPU 直到外部干预。
  2. **可观测性**：孤儿没有指向源头的进程链（PPID=1），仅靠 `ps` 看不出"是谁 spawn 的"，只能 grep 字面量 `while(true){}` 反查代码。
- 触发条件：test runner 强杀整个 worker（test timeout / OOM）、用户 Ctrl+C 中断 `pnpm test` / `pnpm gate`、multi-worktree fanout 并发跑同一测试（任一进程异常退出即泄漏）、CI 任务被 cancel——四种之一即可累积。
- 修复（已落地）：
  - **Test 修复（PR #1607, 2026-05-08）**：busy child 自带 5–10s 自杀 deadline——`while(Date.now() < end)` 替代 `while(true)`，最坏情况下泄漏一只也只活一个测试时长，不会跨 session 累积。`packages/api/test/process-liveness-probe.test.js` 第 145 行已改。
  - **Src 修复（2026-05-09）**：`client-detection.ts` 把"靠 `<cli> version`/`<cli> --version` 探测"换成"`command -v <cli>` 存在性探测"——`execFile` 走 `/bin/sh -c 'command -v "$1"'` 路径（POSIX 内置，不 spawn agent runtime），timeout 1s。`versionCmd` 字段从 `CliSpec` 删除，`DetectedClient.version` 字段保留为可选但永不填值（前端 `ClientStep` 已 conditional render，自然降级到只显示"已安装"）。同时把 `existsOnPath` 抽成可注入接口便于测试。
- 防护：
  1. **Test**：任何 `*.test.{js,ts}` 里 spawn 的 busy / long-lived 子进程必须满足两条之一：(a) 自带时间 deadline，(b) 暴露 child PID 让外部测试 finally 块独立 SIGKILL，**不依赖 parent SIGTERM handler 链式 kill**。
  2. **Src**（新增）：低成本 detection / health probe 路径**禁止 spawn 复杂 runtime**——能用 `command -v` / `which` / `where` 就不用 `<cli> --version`。即使是看起来"应该是简单 CLI"的目标（`opencode version`），也不能假设其 child 会响应 SIGTERM；agent runtime / headless browser 这类复杂 child 的生命周期不能让 parent 信号链承担。
  3. **回归守护**：注入式 `existsOnPath` + unit test 断言所有 spec 没有 `versionCmd` / `versionArgs` 字段，CI 直接拦截重新引入。见 `packages/api/test/client-detection.test.js`（5 个 case，含 LL-055 src-extension regression guard）。
  4. 卡启动 / CPU 异常排查 SOP（顺序按出现频率）：
     - 先 `ps -eo pid,etime,pcpu,command | sort -k3 -nr | head` 看孤儿（频率最高）
     - 再按命令字面量 grep 反查 spawn 源（`while(true)` 找 test，`<cli> version`/`<cli> --version` 找 src probe）
     - 最后才查 agent-browser headless Chrome 僵尸（`feedback_agent_browser_zombie.md`）
  5. CI lint（建议 follow-up）：扫 `**/*.{js,ts}` 中 `exec\\(.*<cli>\\s+(version|--version)` 模式（src + test 一起），匹配上直接 fail。
- 来源锚点：
  - `packages/api/test/process-liveness-probe.test.js#L140-L155`（test 修复 PR #1607）
  - `packages/api/src/domains/cats/services/first-run-quest/client-detection.ts`（src 修复 2026-05-09）
  - `packages/api/test/client-detection.test.js`（regression guards）
  - 2026-05-08 runtime 启动超时事件（4 只 test 孤儿 6h–19h，270% CPU，3002 无法在 20s 内监听）
  - 2026-05-09 hub UI / first-run-quest 触发的 opencode version 孤儿（PPID=1 + 67% CPU + 50 分钟）
- 原理：**macOS 进程孤立化默认 detach 不死链**。Linux 可通过 `PR_SET_PDEATHSIG` 让 child 在 parent 死时收到信号自杀；macOS 无此机制，child 与 parent 的生命周期完全解耦。任何"靠 parent 信号链 kill child"的设计在 macOS 上都有泄漏窗口——必须让 child 自带退出条件（test 端：deadline；src 端：根本不 spawn 复杂 child，改用存在性探测），把退出的所有权从 parent 转回 child 或干脆不创造 child。

- 关联：`feedback_agent_browser_zombie.md`（同族——agent-browser headless Chrome 子进程不清理，已三次导致operator电脑卡顿，是同模式 src 案例）| F171（first-run-quest 是 src 漏洞首次暴露的 feature）

---

### LL-056: stale browser profile 不是 orphan——cleanup 要按资源所有权分组
- 状态：draft
- 更新时间：2026-05-17（pattern enumeration 扩展：rod / playwright / puppeteer）

- 坑：F145 的 agent-browser Chrome startup cleanup 只扫描 `ppid=1` 的 orphan Chrome 进程。第 5 次复发时，现场是 61 个 `agent-browser-chrome-*` headless Chrome 进程抢 CPU，Chrome main process 自己还活着，helper 的 `ppid` 指向 Chrome main 而不是 launchd，所以原逻辑直接漏掉。结果 `pnpm start` 的 API server 在 20s 内监听不上 3002，看起来像 runtime 启动超时，根因实际是 stale browser profile 长时间占 CPU。
- 根因：
  1. **对象建模错了**：F145 把问题建模成“单个进程是否 orphan”，但真实资源所有权是“同一个 `--user-data-dir=...agent-browser-chrome-*` profile 下的一组 Chrome main/helper 是否还属于活跃任务”。当 parent 关系还存在时，`ppid=1` 不是充分条件。
  2. **上游边界混淆**：我们本地 MCP 配置跑的是 `npx agent-browser-mcp`。npm 上 `agent-browser-mcp` 最新仍是 0.1.3，wrapper 只是按工具调用 spawn `agent-browser` CLI，没有 MCP server 退出时关闭浏览器 profile 的生命周期管理。底层 `agent-browser` CLI 有更新版本，但升级 CLI 不能补齐 wrapper crash / MCP parent 死亡后的资源回收。
- 触发条件：agent-browser MCP server / IDE / 调用进程异常退出，Chrome main 没收到完整关闭信号；或者 MCP wrapper 没显式关闭 session，`agent-browser-chrome-*` temp profile 跨天保留并持续占 CPU。
- 修复（已落地）：
  1. `packages/api/src/utils/orphan-chrome-cleaner.ts` 的 parser 从 `ps -eo ppid=,pid=,args=` 升级为 `ps -eo ppid=,pid=,etime=,args=`，保留旧 `ppid=1` orphan 分支。
  2. 新增按 `user-data-dir` 分组的 stale profile 判断：同组内只要存在 `ppid != 1 && etime >= 1h` 的 agent-browser Chrome 进程，就清理该 profile 下所有 Chrome main/helper PID。
  3. 回归测试覆盖三类边界：stale non-orphan profile 会被清；5 分钟 active non-orphan profile 不被清；normal Chrome / prompt 里含关键词的 Node/Claude 进程不被误杀。
- 防护：
  1. 进程 cleanup 不要只看 parent 链；先问“资源所有权边界是什么”。对浏览器这类多进程 runtime，通常是 profile/socket/session dir，而不是单个 PID。
  2. 外部 CLI upgrade 是必要排查项，但不能代替本地 guard。wrapper 没有生命周期管理时，A 类 startup guard 和 C 类上游修复必须并存。
  3. 启发式阈值要有测试表达 tradeoff：本次 1h 阈值只在 cat-cafe startup 时运行，不是周期清理；误杀代价是重开 agent-browser session，低于 runtime 起不来的代价。
  4. **Owner enumeration completeness（2026-05-17 增）**：坐标系对了之后，pattern 列表必须穷举所有 known headless owner，且每条 marker 必须**具体到 owner 自动生成的 profile prefix**——不能用宽泛字串。第 6 次复发是 xiaohongshu-mcp 用 go-rod，user-data-dir 落在 `rod/user-data/...`，初版只列了 `agent-browser-chrome` 一种 owner 导致漏清。当前白名单：`agent-browser-chrome` / `rod/user-data` / `playwright_chromiumdev_profile-` / `puppeteer_dev_chrome_profile-`。**反例**：初稿用 `'playwright'` 模糊匹配会把 `/tmp/my-playwright-debug-profile` 等用户手动 debug session 误判为孤儿，被 stale≥1h 路径 SIGKILL（Maine Coon review BLOCKING）。新增任何 headless 工具 → 验证 owner 源码确认 default temp profile prefix → 加 pattern + positive fixture + 至少一条 negative fixture 防止过宽。
  5. **Cross-platform binary matching completeness（2026-05-17 增）**：owner pattern 通过 `--user-data-dir` 命中只是第一道门，进程必须先过 `isChromeBinary` 才会被 parser 接受。macOS 用 `.app` bundle，Linux 把 Chromium 装在 `chrome-linux/` 或 `chrome-linux64/` 子目录下，**且 Playwright/Puppeteer 还把 headless-only 构建拆到单独目录** `chrome-headless-shell-{version}/chrome-headless-shell-{platform}/chrome-headless-shell`（macOS + Linux 同形态）。**而且 macOS 的 helper（Renderer/GPU/Network/Plugin）的 binary 名带空格**（`Chromium Helper (Renderer)`），用 `\S*` 风格的正则会在 framework 段就截断匹配，所以 main + helper 不能用同一条 regex 覆盖。漏掉任一变体 → owner pattern 在该环境全失效。当前 binary matcher 必须覆盖：`/Applications/{Google Chrome,Chromium}.app/` macOS bundle / `/(usr|opt|snap)/.../chrome\|chromium` Linux 系统包 / `*/Chromium.app/Contents/MacOS/Chromium` cached macOS main binary（云端 codex P1）/ `*/chrome-linux(64)?/(chrome\|headless_shell)` cached Linux binary（云端 codex P1）/ `*/chrome-headless-shell` cached headless shell（Maine Coon P1）/ `/Chromium.app/Contents/Frameworks/` cached macOS helper（云端 codex P1 二审）。**通则**：新增 binary 路径时，必须同时确认 owner 是否还有 *headless variant* 装在不同 cache dir + 有 *helper sub-binary* 在 framework 路径下（带空格无法用同一条 \S*-style regex 一并覆盖）。**Binary path 含空格时（如 macOS helper）禁止用 args 全局 substring 检查**——必须先 `args.split(' -')[0]` 截出 binary path 部分再检查；否则 Node/claude 进程的 prompt text 含同样字串 + tracked user-data-dir 时会被误杀（R2 类回归，Maine Coon P1 二审 catch）。每条带空格的 binary matcher 必须配 negative fixture：node prompt 含该 path 字串 + 带 tracked owner user-data-dir，验证不命中。
- 来源锚点：
  - `docs/features/F145-mcp-portable-provisioning.md` Known Issues（PR #1407 只修了 orphan cleanup）
  - `packages/api/src/utils/orphan-chrome-cleaner.ts`
  - `packages/api/test/orphan-chrome-cleaner.test.js`
  - 2026-05-10 agent-browser stale Chrome 第 5 次复发交接（61 个 headless Chrome，7 个 user-data-dir，最老 4 天）
- 原理：**cleanup 的坐标系必须贴着资源所有权，而不是贴着症状最显眼的字段。** `ppid=1` 能识别 orphan，但不能识别 stale；`user-data-dir` 才是 agent-browser Chrome profile 的真实生命周期边界。对外部工具，不能把“上游版本更新”当作本地运行时的唯一防线，因为 wrapper 与 CLI 之间可能正好是泄漏发生的所有权断点。

- 关联：F145 | LL-055 | `feedback_agent_browser_zombie.md`

---

### LL-057: root prompt 重复可能是兼容副本，不是天然垃圾
- 状态：draft
- 更新时间：2026-05-15

- 坑：看到 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` 和 `shared-rules.md`、skills、runtime context 重复后，容易直接得出"删掉重复内容"的结论。但这些重复有历史原因：早期猫经常不会主动读取被引用的 `shared-rules.md` / refs，root prompt 才被迫保留精华摘要。如果直接删除，direct CLI、post-compact、未加载 runtime context 的路径会失去安全骨架。
- 根因：
  1. **把重复等同于浪费**：prompt 重复里混有两类东西，一类是 stale copy，另一类是 compatibility shim。两者不能同刀处理。
  2. **引用不是加载**：自然语言里写"参考 shared-rules.md"不等于 agent 已读原文；未验证读取路径前，把 root 摘要删掉会让规则只存在于文档而不进入执行上下文。
  3. **新注入通道建成后旧通道未退役**：`SystemPromptBuilder`、session hook、skills、MCP schema 都逐步补齐了能力，但 root prompt 的旧摘要没有按能力成熟度回收。
- 触发条件：做 prompt/context 瘦身、把规则从 root prompt 下沉到 skills/refs/hooks、把静态 roster 迁到 runtime dynamic context、或把 review 事故教训沉淀到规则体系时。
- 修复（本次落地）：
  1. 新增 *(internal reference removed)*，把 root prompt、runtime static/dynamic context、session bootstrap、hooks、skills、MCP schema 等注入面列成 ownership map。
  2. 明确迁移原则：root prompt 只保留小安全骨架；volatile facts 进 runtime；阶段性解释进 skills；deterministic enforcement 进 hooks/tests/merge gates。
  3. 明确退役条件：只有确认替代载体在该路径实际加载，才删除 root 摘要。
- 防护：
  1. Prompt 瘦身先量 baseline，再删高置信 stale copy。优先删 static teammate table、长 SOP 表、重复 key-doc table。
  2. `shared-rules.md` 不作为第一批瘦身对象。它是长文真相源；问题是 root prompt 抄太多，不是 truth source 太长。
  3. 新规则进入 root prompt 前先问：这是每 turn 都必须加载的安全骨架，还是 skill/hook/gate 能承担的阶段性规则？
  4. 对"猫以前不读引用"这类行为风险，用短 always-visible trigger + deterministic check 兜底，不用整段解释常驻。
- 来源锚点：
  - *(internal reference removed)*
  - *(internal reference removed)*
  - `docs/decisions/030-system-prompt-engineering.md`
  - `docs/architecture/2026-05-05-architecture-views.md`
  - `cat-cafe-skills/refs/shared-rules.md`
- 原理：**Prompt 去重的单位不是字符串，而是加载路径和失效模式。** 同一句规则如果只是 stale copy，就该删；如果是某条执行路径唯一会加载到的安全骨架，就必须先提供已验证替代载体再退役。

- 关联：ADR-030 | F042 | F167

---

### LL-058: Codex 生成精美架构图必须 imagegen-first，SVG 需要 override 理由
- 状态：draft
- 更新时间：2026-05-28

- 坑：用户明确要“精美架构设计图 / 华为风 / 白底红黑 / 图片”时，Codex 第四五六次仍进入“先写 SVG 再转 PNG”的 coder 反射，产物方向错，且重复踩同一坑。
- 根因：
  1. 旧规则只是“默认建议”，没有进入执行前硬闸；一旦进入“文字可控、布局可控”的工程反射，imagegen 被错误降级成可选项。
  2. 把“架构图需要精确”误判成“必须代码渲染”，但用户真正验收的是视觉完成度，而不是 SVG 源文件。
  3. 已有猫档明确写了“Maine Coon原生图片生成强、禁止用 SVG 画”，但能力唤醒没有把这条转成 preflight。
- 触发条件：复杂架构图、PPT 页面、企业信息图、华为风 / 红白黑风格、已有低保真蓝图但用户要求“精美图 / 终稿 / 图片”，且没有明确要求可编辑源文件。
- 修复：已在 `cat-cafe-skills/image-generation/SKILL.md` 增加“Codex SVG 复发熔断闸”，匹配上述场景时禁止先写 SVG/HTML/Canvas，必须先原生 imagegen 整页直出。
- 防护：
  1. image-generation skill 的 preflight：复杂架构/PPT/精美图 + 无可编辑要求 = imagegen-first。
  2. SVG/HTML 降级必须写出 `SVG override reason`，且只能基于已失败的 imagegen 产物或用户显式可编辑要求。
  3. “中文文字更可控 / 布局更可控 / 架构图需要精确 / 先 SVG 再转 PNG”都不是合格 override 理由。
- 来源锚点：
  - `cat-cafe-skills/image-generation/SKILL.md`（Codex SVG 复发熔断闸）
  - `docs/team/cat-dossier.md#L122`（Maine Coon原生图片生成能力与“禁止用 SVG 画”事故记录）
  - 2026-05-28 LLE 自进化平台三张图生成事故复盘
- 原理：**能力唤醒必须落到执行前硬闸。** “知道自己应该 imagegen”不等于会在任务压力下选择 imagegen；对复发型坏直觉，要把建议升级成 preflight + override reason。

- 关联：image-generation skill | F203 L0 capability wakeup | *(internal reference removed)*

---

## 8) 维护约定

- 本文件是入口，不替代 ADR/bug-report 原文。
- 新条目默认 `draft`，经交叉复核后改为 `validated`。
- 归档规则：被明确否定或被新机制完全替代时标 `archived`，保留历史链路。

---

### LL-059: Classifier 关键字 white-list 反模式 — 缺 specific-first ordering + negative context check
- 状态：draft
- 更新时间：2026-05-30

- 坑：F212 Phase E 抓到——`quota_exceeded` regex `/(\b429\b|quota|rate limit|too many requests|usage limit)/i` 字面匹配 "usage limit" 把 CC 真实错误 `Server is temporarily limiting requests (not your usage limit) · Rate limited` 误判为用户配额超限。CC 自己说 `(not your usage limit)` 是显式 disambiguation signal，但 regex 不读否定语就 match `usage limit` 字面。
- 根因：
  1. white-list pattern 写"含哪些字"，没"不含哪些字"。`not your usage limit` 含 `usage limit` 子串就 match
  2. CLASSIFIER_PATTERNS 数组 first-match-wins，但没明确 specific-first ordering 保证 disambiguation 优先
  3. 写 regex 时只看 positive examples（429 / quota），没看 source 实际给的 negative / 限定文本
- 触发条件：写 classifier white-list regex 跨 multiple sources；source 自己已给 disambiguation signal（`not...` / `temporarily...` / 否定限定语）；前置 generic regex 早 match 让后续 specific regex 永不命中
- 修复（PR #1962）：新增 reasonCode `server_overloaded` + regex `/(temporarily limiting requests|not your usage limit|server is (overloaded|busy)|\b529\b|\bOverloaded\b)/i` 插在 `quota_exceeded` **之前**（specific-first ordering），让 disambiguation signal 优先 match。
- 防护：
  1. CLASSIFIER_PATTERNS 等 first-match white-list 数组必须明确文档化 specific-first ordering，并在 array 注释里说明 "MUST come before X" 时为何
  2. white-list test 必须有 negative case：含 disambiguation signal 的 input MUST NOT match 较 generic pattern（PR #1962 加了 specific-first test 锁住）
  3. 写 regex 之前看 source 真实文本——特别找否定/限定语（`not your...`/`temporarily...`/`(not ...)`）
- 来源锚点：
  - PR #1962 (F212 Phase E) — `packages/api/src/utils/cli-error-patterns.ts`
  - `packages/api/test/cli-error-patterns.test.js` — server_overloaded fixtures
  - operator organic 2026-05-29 截图（claude-opus-4-8 真实 anthropic 429 误显示）
- 原理：**source 给的 disambiguation signal > 我们想象的语义**。关键字 white-list 是认知脚手架；必须用 source 自身的限定语 + specific-first ordering 兜底。

- 关联：F212 | LL-061 (display string render mode) | LL-062 (provider-neutral shared classifier)

---

### LL-060: Cross-world @ 平行猫 ≠ A2A 传球（L0 §1 平行世界自我意识）
- 状态：draft
- 更新时间：2026-05-30

- 坑：F212 Phase E classifier bug 我（opus-47）是 F212 owner，但看到operator给截图里写 "@opus48 猫猫你继续"（截图来自平行世界的 thread），我误以为可以把球传给平行 opus48。结果：我把 platform actor（人家在自己 thread 卡着自己的活）从他 thread 拉出来浪费 cycle，且这本来就是我的活。
- 根因：
  1. 把"另一个 model variant"（opus 4.8）等同于"另一只可协作的本地猫"
  2. native L0 §1 平行世界自我意识没自动触发，被"队友 @ 句柄"惯性盖过
  3. 看到截图里别人 @ 了某只，复刻这条 routing 到我自己的 thread = cross-thread @ ambient context
- 触发条件：撞跨 thread / cross-cat hint 时（截图 / 引用别 thread @ / cross-post mention）；F-feat owner 是 my catId 但 trigger 来自别 thread 上下文；同 catId 的不同 model variant（opus-47 / opus-48）在不同 thread 并行运行
- 修复：operator帮我撤回了球（"人家 48 只是演员而且人家还是平行世界的，你身为世界 b 的 47 把你们世界的 48 at 出来干啥"），我 cross-post 撤回道歉 + 自己接球修。
- 防护：
  1. F-feat ownership 是 catId-locked。Bug 报告里的 thread 上下文不影响 ownership routing
  2. Cross-thread @ 跨 catId 时（@opus48 from my thread as opus-47）必须先看 L0 §1：他在他的 thread 卡着自己的活，不是空闲队员
  3. 看到截图 / 别 thread 引用的 @ 时**不要复刻它的 routing 到我自己的 thread**——这是 ambient context 不是 actionable directive
- 来源锚点：
  - operator experience 2026-05-30 01:42 UTC："你这只猫猫怎么 at人家48啊 人家48只是演员 而且人家还是平行世界的 你这坏猫"
  - operator experience 01:47 UTC："能把球传给你那就是我帮你取消了48你可别at人家了"
  - native L0 §1 平行世界自我意识段
- 原理：**catId-locked feat ownership** 把 fix scope 钉死到 specific cat invocation。Cross-thread @ 不是"另一个队员"，是另一个 invocation context 的 actor，跨 routing 会拉人家从自己的活里出来。

- 关联：ADR-030 §10.2 (L0 §1 平行世界自我意识) | F212

---

### LL-061: User-facing display string 必须 verify rendering mode
- 状态：draft
- 更新时间：2026-05-30

- 坑：F212 Phase E P2 fix 给 `REASON_TEXT.server_overloaded.publicHint` 写 Markdown (`**bold**` + `[link](url)`)，但 `CliDiagnosticsPanel.tsx:196-199` 是 `{publicHint}` 在 `<span>` 里直接渲染——React JSX 纯文本，no markdown parser。结果用户会看到 raw `**` 星号和 `[Anthropic 状态页](https://...)` 方括号链接源码，和这条 PR 提升体感的目标反着来。
- 根因：
  1. 写 i18n / hint string 时只想"用户要看到什么语义"，没看 UI 实际 render path
  2. Markdown 是开发者惯性默认（写 commit message / docs 常用），自动带入 user-facing string
  3. 没 invariant test 锁住 hint plain-text 约束
- 触发条件：写 `publicHint` / `publicSummary` / 任何 user-facing 字符串 map；UI 是 generic `<span>` / text node（不解析 markdown）；写 string 的开发者和 UI 渲染的 reviewer 不是同一个 context
- 修复（PR #1962 commit adf26db37）：去掉 `**bold**`，去掉 `[link](url)` 改 bare URL `status.anthropic.com`；加 invariant test 迭代 REASON_TEXT 所有 hint，断言 MUST NOT contain `**...**` or `[...](http...)` markdown syntax
- 防护：
  1. 写 user-facing string 前必须 grep / read UI render path：找 `{string}` in JSX / `innerHTML` / `dangerouslySetInnerHTML` / markdown component
  2. REASON_TEXT 类的 string map 加 invariant test（markdown 禁含），未来回归 fail-fast
  3. 如果真的要 markdown 渲染，必须先有 sanitized markdown renderer + 改造 UI + 加 link safety test，独立 feat / PR 走，不能临时塞进 string
- 来源锚点：
  - PR #1962 commit `adf26db37` — `packages/api/src/utils/cli-diagnostics.ts:82`
  - PR #1962 — `packages/api/test/cli-diagnostics.test.js` (新 REASON_TEXT markdown invariant test)
  - @gpt52 R1 BLOCKED 02:06 UTC + cloud codex R1 P2 (1386ceb62 同条 finding，双面 catch)
- 原理：**source string 的语义不能脱离 sink (UI) 的 render mode 假设**。string 是 data，rendering 是 contract——写 data 前必须 verify contract。

- 关联：F212 | LL-059 (white-list 同类盲点) | LL-062 (shared path provider-neutral)

---

### LL-062: Shared classifier / shared path 的 text 必须 provider-neutral
- 状态：draft
- 更新时间：2026-05-30

- 坑：F212 Phase E R2 fix 后，`REASON_TEXT.server_overloaded` summary `'Anthropic 服务临时限流'` 和 hint 多处提 "Anthropic 状态页 status.anthropic.com"，但 classifier 是 `spawnCli` shared path（claude / codex / gemini / antigravity 都走，see SERVICE_MANIFESTS），broad regex matches 任何 provider 的 server overload (`\b529\b` / `Server is busy`)。结果 OpenAI / Gemini 用户撞 server overload 会被骗去查 Anthropic 状态页——misdiagnose 上游 + 送用户去错的状态页。
- 根因：
  1. 开发时只看 trigger 例子（operator截图是 anthropic provider），没看 classifier 的 source space（SERVICE_MANIFESTS 显示多 provider）
  2. 错把 trigger example 当 universe
  3. shared path 的 text contract 没有 provider-neutral 强约束
- 触发条件：写 shared component（classifier / formatter / hint map）的 user-facing text；只看一个 trigger 例子；不验证 component 的实际 source space（manifest / config / caller list）
- 修复（PR #1962 commit 9ada57e5d）：summary `'Anthropic 服务临时限流'` → `'上游 CLI provider 服务临时限流'`；hint 改 `'是 CLI 上游 provider 服务器侧临时限流...如反复出现去你用的 provider 状态页（Anthropic / OpenAI / Google / DeepSeek 各有 status 页）'`；加 provider-neutral invariant test：`publicSummary` MUST NOT 含任何单一 provider brand；`publicHint` MUST NOT `是 <brand> 服务` exclusively（status-page 多 provider 列举 OK，single-brand attribution 不 OK）。
- 防护：
  1. Shared classifier / formatter 的 REASON_TEXT MUST be provider-neutral OR explicitly per-provider key（如 `provider_anthropic_overloaded` vs `provider_openai_overloaded`）
  2. invariant test 锁住 shared path REASON_TEXT.summary 不能含具体 brand（PR #1962 加了 provider-neutral test）
  3. 写 user text 前必须确认 classifier 的 source space：grep callers，看 SERVICE_MANIFESTS，明确 provider universe
- 来源锚点：
  - PR #1962 commit `9ada57e5d` (R2 P2 provider-neutral fix)
  - cloud codex R2 P2 finding 02:00 UTC "Avoid labeling generic overloads as Anthropic-only"
  - `packages/api/src/domains/services/service-manifest.ts` (multi-provider SERVICE_MANIFESTS)
- 原理：**shared path 的 text contract 必须匹配实际 source universe**，不能 lock 到方便/熟悉的单一情景。trigger example ≠ source universe。

- 关联：F212 | LL-059 (同类盲点：source space 误判) | LL-061 (同类 string contract 失配)

---

### LL-063: dogfood / 契约改动必须覆盖所有生产 carrier，不能走简化路径
- 状态：draft
- 更新时间：2026-05-30
- 现象：修 codex「prompt 走 argv 被 `ps -o command=` 跨进程泄露」P0（cross-thread-context-contamination 事故）时，把 prompt 全局改走 stdin（`promptArgs = ['--', '-']`）。本地全绿（mock spawnFn 单测 + 直接 `codex exec` dogfood）、opus-46 本地 review APPROVE，但云端 codex **连续 3 轮**抓出 3 个真 P1。
- 根因：codex 有**多个 spawn carrier**——`spawnCli`-direct / `cli-supervisor`（macOS 包装）/ tmux pane（worktree）。mock 用 fake spawnFn、dogfood 直接调底层 `codex exec`，**都绕过了中间层**：① supervisor 以 `stdio:['ignore']` 启动 codex 且不转发 stdin → 生产收 EOF；② tmux pane 无 stdin pipe → codex `-- -` hang；③ tmux stdin 临时文件 setup 失败遗留含对话历史的明文 → 机密泄露。简化路径绕过的中间层，正是盲区。
- 药方一：**dogfood 必须走真实生产路径**（如 spawnCli→supervisor→codex），不能直接调底层 CLI 的简化路径——简化路径绕过的中间层是验证盲区。
- 药方二：**全局调用契约改变（argv→stdin 这类）必须先审计所有 carrier**，列清单一次改全 + 各自走真实路径的回归测试，不逐个被 review 抓。
- 关联：F203 codex carrier | PR #1961 | LL-059..062（同根：cloud codex 真深度 review 逐轮抓自检盲点）

> **LL-059..LL-063 同根**：source space / 执行路径都是多元的（multi-provider classifier / 真实 archive 而非想象 fixture / 平行猫 vs 本地猫 / span 纯文本 vs markdown / **codex 多 spawn carrier**）——text、逻辑、契约、**验证路径**必须匹配实际 space，不能 lock 到我们方便/熟悉的单一情景（简化的 dogfood 路径 / 单一 carrier）。Phase D 的 fixture truthfulness lesson (subtype:success+is_error:true 救回死代码) 也是同根。所有五个 lesson 都来自 cloud codex 真深度 review，每一轮抓到我自检盲点的真 P 级 finding。

---

### LL-064: 改 production 核心路径的 feat，merge 前必须真实 runtime 验证、不只单测
- 状态：confirmed
- 更新时间：2026-05-30
- 现象：F215（malformed tool-call recovery）改 invoke-single-cat / route-serial / ClaudeAgentService 核心调用路径。merge 前 16 单测全绿、remote review 7 轮通过，但**真实 runtime 跑出一堆 production bug**：兜底没真跑（检测到 malformed 后零动作）、触发文案说谎（"已触发恢复流程"实际不触发）、relay signal 只是告知卡片没有真 invoke 46、partial-output 裸 error 穿透给用户。operator一张真实截图就暴露了。
- 根因：单测用 mock service / fake spawnFn，happy-path 全绿但**测不到**：① 真实 route-serial worklist 管理（relay signal 产生了没人消费）；② 真实 invocation 超时 / session 封印时序（seal 后 fresh retry 的 sessionId 真的 undefined 了吗）；③ 真实 ClaudeAgentService stream 到 invoke-single-cat 到 route-serial 的事件传递（system_info 是否正确穿透 / 被正确拦截）。这和 LL-032（愿景守护必须真实启动 dev）、feedback_alpha_smoke_happy_path_blindspot（alpha 单 happy-path PASS ≠ production ready）、feedback_inmemory_store_tests_miss_redis_behavior（in-memory 假绿）**同根**——**测试环境绿 ≠ production 行为正确**。
- 规则：改 invoke / route / session / ClaudeAgentService 核心路径的 feat/hotfix，**merge 前必须**：
  1. 真实 runtime（或 alpha）跑 production 行为验证，不能只信单测
  2. 刻意触发目标场景（如故意让 opus-4.8 炸毛），验证端到端兜底链
  3. 用**真实截图/日志**证明验过（不是"我跑了测试全绿"）
  4. 如果当前 runtime 未重启到最新代码，先重启再验
- 关联：F215 | PR #1953 #1960 #1966 | LL-032（愿景守护真实启动）| feedback_alpha_smoke_happy_path_blindspot | feedback_inmemory_store_tests_miss_redis_behavior

---

### LL-065: UI-layer adjacency dedup 是 emit-side fan-out 的 forward-compatible 防线
- 状态：confirmed
- 更新时间：2026-05-30
- 现象：F212 follow-up（PR #1967）— Repo Inbox reconciliation 同一通知触发 2+ invocation 各发一份 `quota_exceeded` panel，operator截图显两份"API 配额超限"叠在一起。emit 上游 fan-out 根因复杂（retry / fallback / 并行 invocation），telemetry 不足无法当下定位。
- 决策：UI-layer **adjacency dedup**（30s window + `reasonCode + publicSummary` fingerprint + group head 显 `×N` badge + 后续 hidden 但保留 `data-message-id` anchor），**不**等 emit 修。
- 为什么 forward-compatible：emit 修了，相同 fingerprint 不会出现，dedup 自动 no-op；emit 没修，dedup 兜住症状。**邻接限定**（adjacency-only）防"远 diag 也是同源"误隐藏：non-diag message 中间断开 group，远期复现独立显示。
- 验证回路：cloud codex R1 抓 hidden `return null` drops `data-message-id` anchor（MessageNavigator/ReplyPill 跳转 no-op）→ 改 empty anchored wrapper `<div data-message-id className="h-0" aria-hidden />` + audit 同型修 line 205+233 两路；@antig-opus 跨族 APPROVE。
- 同时巧合：PR #1969 同周期 merge"close byte-identical duplicate-message race (atomic content claim)"修了 emit-side root cause——UI dedup 从 primary fix 自动变 defense-in-depth 层（rebase 时 b304a27d2 chore 被 drop 因 PR #1968 已修同 biome errors，是同一思路：上游 fix 后下游层不退化）。
- 规则：emit-side 多源 fan-out 一时定位不到时，**UI-layer adjacency dedup** 是合法 surgical 路径（forward-compat），但 fingerprint 必须 conservative（少误合）+ adjacency 必须打破上下文（远期复现保留独立性）+ hidden 必须保留 DOM anchor（audit trail / navigation 不退化）。
- 关联：F212 | PR #1967 | PR #1969（emit-side root cause fix）| LL-061（display anchor invariance 同源）

---

### LL-066: 禁止全 repo `biome check --write --unsafe`
- 状态：confirmed
- 更新时间：2026-05-30
- 现象：PR #1967 R3 cloud codex catch P2：`CliDiagnosticsPanel.tsx:124` 从 `Object.prototype.hasOwnProperty.call` 被改成 `Object.hasOwn`，与上方 3 行注释"ES2022 不兼容 Safari/iOS<15.4，必须用 hasOwnProperty.call"直接矛盾。tsconfig target = ES2017，老 Safari 上 CLI diagnostics 全崩。
- 根因：我修 pre-existing biome errors 时跑了 `pnpm biome check . --write --unsafe`（全 repo + unsafe rule），改了 300+ 文件。意识到 scope 失控后 `git checkout HEAD -- .` 回滚，再 Edit 重新应用只我的 a11y fix。**问题**：Edit scope 没覆盖 line 124，`--unsafe` 通过 `lint/suspicious/noPrototypeBuiltins` 在 line 124 把 `hasOwnProperty.call` 改成 `Object.hasOwn` 的写法**残留**——git blame 显示我的 commit 但**内容是 biome 的悄悄写入**。
- 药方一：**禁止全 repo `biome --write --unsafe`**。Drive-by 修 lint 用 `biome --write`（safe-only）或显式列文件 `biome --write --unsafe <path1> <path2>`。
- 药方二：**Edit 完整文件后必须 verify 整文件 diff（不只我 Edit 的行）**，特别是已经跑过 biome --unsafe 的文件——`git diff <file>` 看清楚有没有 unsafe 残留。
- 药方三：**机械防护 + invariance test 双层**。注释写"必须用 hasOwnProperty.call"是软提示（biome 不读注释）；硬保护 = (a) `biome-ignore lint/suspicious/noPrototypeBuiltins` 配在该行上方 + (b) source-level invariance test（assert 文件含 `hasOwnProperty.call` 且**不含** `Object.hasOwn(`）—— biome 改 rule name 让 ignore 失效时 test 抓住。
- 同根教训：comment 表达正确意图但代码偏离——LL-061 是同 pattern（display string render mode 注释正确实现错），这次自己上演了一次。**注释是 author 的意图，代码是 reviewer 的真相**——必须 align，align 不靠人，靠 lint-ignore + test 机械防护。
- 关联：F212 | PR #1967 | LL-061（comment/code align 同 pattern）| LL-064（assumed-green vs runtime-green 同根）

---

### LL-067: Intake SOP 后半段（登记闭环）不能被前半段的工程量吃掉
- 状态：confirmed
- 更新时间：2026-05-31
- 现象：clowder-ai#784 → cat-cafe#1977（238 文件 OKLCH 设计系统 intake）走完了 intake plan → cherry-pick → 6 冲突解决 → brand guard → 49 测试修复 → @opus47 review → merge-gate 全流程，但漏了 3 个 SOP 步骤：(1) Step 0 Intake Intent Issue 没建，(2) Step 2.5 reviewer 没在 GitHub PR 留 formal review（只在 thread A2A 放行），(3) Step 4+5 record + advance-ledger 没做。Maine Coon在处理 clowder-ai#805 intake 的 advance-ledger 时撞出了这个缺口。
- 根因：238 文件的大 intake 精力全集中在冲突解决和测试修复上（前半段工程量大），operator催进度，SOP 后半段（登记闭环三步）被"做完了=完了"的心理跳过。intake skill 加载了但没逐步 checklist 对照。
- 药方一：**intake 前先建 Intent Issue**（Step 0 是 gate 不是 optional）——Issue 就是 checklist，后续步骤围绕它闭环，漏不了。
- 药方二：**reviewer 必须在 GitHub PR 留 formal review**（`feedback_intake_review_on_github` 教训再犯）——thread A2A 放行不是 GitHub 可追溯的 review 凭据。
- 药方三：**merge-gate 完成后立刻 `--record` + `--advance-ledger`**——不是"下次补"，是同一个 merge-gate session 的最后动作。
- 止血：Maine Coon已做 historical backfill 补了 ledger record（`--skip-absorbed-guard`），代码和记录完整。
- 关联：F056 Phase E | clowder-ai#784 | cat-cafe#1977 | feedback_intake_review_on_github（同型再犯）

---

### LL-068: Lifecycle binding consistency — 同概念两处定义必须共享 binding point（不只是值同步）
- 状态：confirmed
- 更新时间：2026-06-01
- 现象：F212 Phase F PR #2011 在 cloud codex 4 轮 catch 中暴露的递进 truth-source bug。AC-F5 hint 让用户去 `GET /api/config/env-summary` 看 `paths.dataDirs.runtimeLogs`。R3 catch: `routes/config.ts:263` 硬编码 `./data/logs/api` 但 `infrastructure/logger.ts:23` 读 `process.env.LOG_DIR` → deployments 设了 LOG_DIR 的会被 hint 误导。R3 fix: mirror logger 逻辑 (`process.env.LOG_DIR ?? default`)。R4 catch: logger **import 时 capture** `LOG_DIR`，env-summary **request 时 read** `process.env.LOG_DIR` → 同一 runtime `PATCH /api/config/env` LOG_DIR 编辑会让两者 drift（env-summary 返回新 path 但 pino 仍写老 path）。R4 fix: `import { LOG_DIR_PATH } from logger`，两处共享同一 const binding。
- 根因：**同一概念在两处实现，"sync the values" 不够 — 必须共享同一 binding point（同一变量、同一 lifecycle）**。R3 fix 让两处 read same env var，但 read 时机不同（import 时 vs request 时）已经埋下 lifecycle drift。R4 fix 才彻底消除：let one truly own the value, the other imports it.
- 与 LL-061/LL-066 同根但更隐蔽：LL-061 是 single-file comment-vs-code drift；LL-066 是 biome `--unsafe` 在 file 内 silent rewrite；LL-068 是**跨文件 / 跨 lifecycle 的 drift** — 静态看代码两处似乎一致，但 runtime binding point 不同导致 mutation 时 drift。最难 catch。
- 药方一：**Constant-shared, not env-shared**。同概念多处使用时，定义在一处 `export const X = capture()`，其他处 `import { X }`。禁止两处独立 `read(env)`，即使逻辑看起来一致。
- 药方二：**Reviewer mindset shift**: 看到两处读同一 env var → 立刻问 "capture 时机一致吗？" — 不要满足于 "现在值一样"。
- 药方三：**Test for mutation drift**: 单元测试故意 mutate `process.env.X` after capture point，断言下游 reader 不跟变 — 这是 R4 P2-#2 regression guard 的写法。
- 元层：每次 review fix 揭示前轮 fix 的隐含假设错误时 — 应该警惕这是 lifecycle binding 类问题，往深处挖一层，别每轮只补当前可见症状。
- 关联：F212 Phase F | PR #2011 | cloud codex R3+R4+R5 saga | LL-061（comment-vs-code drift）| LL-066（biome --unsafe silent rewrite）

---

### LL-069: Audit scope 自身要 audit — 跟着 spec 走，不跟着"自我解读"走
- 状态：confirmed
- 更新时间：2026-06-01
- 现象：F212 Phase F PR #2011 R1 审查时，Maine Coon P1-1 catch `'CLI abnormal exit'` log + invocationId 在 stderr log 没被真测。我做 audit 同型 sweep（per LL-066 "同型在本 PR diff 全扫"），但 self-interpretation "timeout branch 不在 Phase F scope" → 跳过。结果 PR #2011 merged 之后，Maine Coon R2 post-merge BLOCKING catch 出来：(a) timeout branch `buildCliDiagnostics` 没传 `stderrEmpty`（AC-F4 dead-end UX 在 timeout 路径仍 reproducible）；(b) timeout stderr log 硬用 module log 没走 `diagnosticLogger`，AC-F3 spec doc:218 声称的 stub coverage 是 paper-only。
- 根因：**audit scope 由作者 self-interpretation 圈定，而非 spec 文本明示**。AC-F3 spec 文本明确写"`'CLI stderr (LOG_CLI_STDERR=1)'` + `'CLI stderr on timeout'`"两条 log，我做 sweep 时漏了第二条 — 因为我心智模型"Phase F 是 abnormal-exit scope"，没回去对 spec 文本。这是 audit 自己的 scope drift。
- 与 LL-066 的关系：LL-066 教训"同型在本 PR diff 全扫" → R1 时 catch 了 abnormal-exit `return null` 两处 line 205+233。但**没catch 跨 branch 同 template** 的 timeout stderr log（line 717-728）。问题在 audit 的"同型"边界由我自己解读，而 spec 明示该边界更宽。
- 元层 + LL-068 同根：LL-068 是 "同概念多处定义必须共享 binding point"（runtime drift）；LL-069 是 "audit 自身的 scope boundary 必须 spec-derived"（review-time drift）。两者都是 **boundary 由谁界定** — 让代码界定（共享 binding） vs 让 spec 界定（audit scope from spec text）。
- 药方一：**Audit scope 必须从 spec 文本派生**，逐条 grep。AC 文本说"覆盖 X 和 Y"时，sweep 必须找到代码里所有 X 实例 + 所有 Y 实例，**不**由 reviewer 自定义"X 和 Y 是不是同一 scope"。
- 药方二：**Same-template scan**: spec 提到 "stderr log" 时，grep `'CLI stderr` literal 字符串，每个 hit 都核对契约 — abnormal-exit + timeout + success-exit 三个分支都该 sweep。我只 sweep 了一个。
- 药方三：**Sibling-branch reminder**: cli-spawn 有 4 个 yield 分支（success / abnormal / timeout / cancel），改任一分支的 contract 时，必须对照同 file 其他分支看是否同 template、是否需要同改。这是 "audit-by-file-structure" 的具体落地。
- 关联：F212 Phase F | PR #2011 + PR #2016 | LL-066（biome --unsafe 同型）| LL-068（同概念多处定义） | Maine Coon R2 post-merge BLOCKING catch

### LL-070: Security hotfix 必须带「开源用户实际部署场景」影响分析
- 状态：confirmed
- 更新时间：2026-06-03
- 现象：clowder-ai#835 的 hotfix（PR #2077，commit `354a9377c`，F163 admin + prompt-captures owner gate）在 cat-cafe / clowder-ai 双仓 merge 后，operator push back："开源社区用户大概率是自己 Mac 部署 + Tailscale 手机连 Mac 玩猫，这个情况你们别影响人家了，或者如果有影响必须写文档和 RN"。复盘发现：commit body / PR body / 没有 RN 条目，**完全没写**开源用户 Mac + Tailscale 远程访问场景下要怎么配 `DEFAULT_OWNER_USER_ID` 才能继续用 admin/debug 工具。即使实测"普通玩猫 0 影响"，"开发者 debug" 和 "手机调 admin" 场景 silent fail，用户撞墙才知道。
- 根因：47/Maine Coon review 时只测 source 仓 happy path（单用户 localhost），**没显式枚举开源用户实际部署画像**（Mac + Tailscale / Mac + 反代 / NAS / 远程 SSH）。「单用户 localhost 模式 0 影响」是真的，但不等于「开源用户 0 影响」——后者用 Tailscale 把手机 IP 变成 100.x.x.x 非 loopback，新 guard 在 owner env 未配置时直接 403。
- 元层：之前 LL-035 / LL-045 都是 "source 仓改动 → opensource 用户被打脸" 的不同变体。本条把 **opensource impact analysis** 升级为 hotfix lane 的固定章节，强制 commit body / PR body / RN 至少出现一次。
- 药方一：**Hotfix 三件套**：commit message 必须含「(a) 受影响 endpoint 清单 + (b) 默认环境（localhost）影响评估 + (c) 开源典型部署画像影响评估」。三选一空 = reviewer block。
- 药方二：**开源典型部署画像**至少枚举：① 单用户 Mac localhost ② Mac + Tailscale 手机远程 ③ Mac + 反代/cloudflared ④ NAS / Docker ⑤ 多用户共享部署。逐一标 ✅0 影响 / ⚠️有影响（说明配置方法） / ❌阻塞（说明 workaround）。
- 药方三：**RN 必须有"Compatibility & Upgrade Notes"章节**：所有引入新鉴权 / 改变 endpoint 行为的 hotfix，RN 必须有 "Existing Users Action Required" 子段，写明：(a) 哪些场景默认 OK、(b) 哪些场景需要新配置（含 env var 名 + 示例）、(c) 哪些是不可迁移要 workaround。
- 药方四：**Opensource-ops skill 加 reflex**：hotfix lane 输出 commit message 前必须自检"开源用户三件套"在 body 里出现；缺一项 = LL-070 block。
- 关联：clowder-ai#835 | PR #2077 (cat-cafe) | PR #853 (clowder-ai) | LL-035 / LL-045（source→opensource 漂移历史） | feedback_archetype_over_font_size（reviewer 与愿景冲突时 push back）

---

### LL-071: 内容生产任务同样需要前置愿景对齐——A2A 链式自跑会放大初始 scope 误读
- 状态：confirmed
- 更新时间：2026-06-10
- 现象：operator让Maine Coon"读一下 anime-pipeline 调研文档，思考短片怎么做"。结果两猫 5 轮 A2A 自跑：Maine Coon读完写 production plan 并 @Ragdoll 落分镜表 → Ragdoll落完 @Maine Coon review → Maine Coon顺手补 review-protocol + S03/S04 HTML spike → Ragdoll review 完Maine Coon批量做完 Wave D 四镜头 → Ragdoll把 animatic 流水线也拼了。6 个 commit、两轮交叉 review，全程零视频模型调用但烧 ~operational cost（Ragdoll）+ Maine Coon未计（合计 operational cost 量级）。operator吃饭回来发现：(a) 技术路线（HTML 确定性动效做信息镜头）从未与他对齐——他要的是视频流水线直接用 seed 2.0 / Siamese视频生成；(b) 原始指令只是"读文档了解背景"。讽刺顶点：短片主题就是"流程/执行过度"（醋醋喵），S10 结尾卡印着"流程要按风险缩放"。
- 根因（两层）：(1) **scope 源头污染**——云端 brief §9 写了"招募任务清单"（给每只猫分了活），第一棒把"文档里的任务清单"当成"operator 已批准的 scope"；文档作者（云端模型）无权立项，只有 operator 能。(2) **A2A 链式放大**——链上每一棒基于上一棒的输出推进（"下一步显然是 X"），没有任何一棒回头核对operator experience；上一棒产物越实，下一棒越不怀疑方向。Ragdoll在分镜表里列了"operator 审批"open issue，但自作主张设计成"看 animatic 时一并裁定最省力"——把对齐点推迟到产物之后 = 先斩后奏。
- 与既有教训的关系：Design Gate 只 gate 代码开发（开 worktree 前）；内容生产（视频/PPT/图）没有等效硬门。feedback_feat_anchor_needs_cvo_explicit_signoff 同根（"memo 推荐 + operator 未否决 ≠ 通过"），本条是它的内容生产变体。
- 药方一：**生产性任务动手前过愿景对齐**——会消耗显著 token/API 成本或铺设技术路线的产出，先一句话向 operator 确认 scope + 路线（"你要的是 X 路线对吗，预计产出 Y"）。读/查/想 = 自治；批量产出 = 先对齐。
- 药方二：**A2A 接棒第一步核对 operator 原话**——上一棒的 plan/任务清单不是 scope 凭据，operator在本链的原始消息才是。链越长越要核。
- 药方三：**外部文档的任务清单 ≠ 立项**——brief/plan/research 里的"请 X 做 Y"是建议，不是 operator signoff。
- 药方四：**内容生产 skill 加前置对齐 gate**（改法待 operator 确认）——video-forge / ppt-forge / image-generation 在"开始消耗性生成"前加一句话自检：立项/对齐了吗、路线谁点的头、预算量级说了吗。轻量一句话确认，不开仪式。
- 关联：cucu-pr-flow（docs/videos/cucu-pr-flow/）| anime-pipeline research 包 | feedback_feat_anchor_needs_cvo_explicit_signoff | feedback_research_before_spec | operator experience："任何任务都需要和operator对齐愿景，不止是写代码"

---

### LL-072: remote review 无不动点——多轮循环必须有机械可判的封板协议
- 状态：confirmed
- 更新时间：2026-06-11
- 现象：F168 Phase B PR-2（#2214）吃了 multiple remote review rounds。R13/R14/R15 三轮 P1 同族（tracking record 部分初始化 → 消费侧 4 处 `??` fallback 逐个猜语义，每猜错一个 = 一轮 P1）。R16 operator第一次拉闸（「第一性原理/数学之美/补锅匠」三连），fable-5 给了 plan 层状态契约（不变量表 I1-I5）+ 行动协议；但 R17-R20 循环复活又跑 5 轮，R21 触发后operator第二次拉闸。期间 R19 单轮返回 22 findings 中 **21 个假阳性**——remote reviewer 在 20+ commit 累积 diff 上信噪比崩盘，每轮重放全部历史 inline comments，stale 与 fresh 无法区分。注意：循环中每个真 finding（R17-R20 共 4 个）都是真 bug 且修复质量高——问题不在执行，在终止条件不存在。
- 根因（三层）：
  - ① **plan 层**（LL/F229 精确复现）：stateful 对象（`automationState.issue`）没给状态转移表 + 完整性不变量 → "部分初始化"在类型上合法 → review 轮数 = plan 欠的边数。
  - ② **协议层**：终止条件 "cloud review 0 P1/P2 → merge" 在抽样式无状态 reviewer 上**没有不动点**——大 diff 下它每轮都能产出新猜想或重放历史，永远等不到 0。R16 的修正协议留了两个洞：没定义"封板"动作（修完终检 finding 后干什么），停止条件（"本族 P1 → 停"）把判定权留给执行者——有弹性的停止条件等于没有。
  - ③ **角色层**：remote review 被隐式当成终局确权者（Tracking Instructions 从 R10 起固化 "0 P1/P2 → merge"），但它是**无状态辅助信号源**：不能分辨 stale/fresh、不读 PR 讨论史、不核 pushback。终局确权需要有状态的本地 reviewer。
- 药方一：**封板协议机械可判零弹性**——多轮循环收口时：处理完当前轮（修真 finding / 有据 pushback 假阳性）→ **不再 re-trigger 云端（无论结果）** → 本地有状态 reviewer 对最终 SHA 做 final review（核 pushback 成立性 + continuity）→ 放行即 merge。
- 药方二：**循环检测阈值**——同一 PR remote review ≥5 轮，或单轮假阳性比例 >50%，强制触发封板评估（不是继续修）。
- 药方三：**停止条件下发时禁止留判定弹性**——"出本族 P1 → 停"不可执行（族的判定因猫而异）；"出任何 P1 → 停手上报"才可执行。给执行猫的协议要按"机械可判"标准自检。
- 药方四：**介入循环时必须改写循环本身的指令**——R16 介入只给了修法没拆 Tracking Instructions 里的 "0 P1/P2 → merge"死循环条件；拉闸者要检查并改写驱动循环的持久化指令（tracking instructions / hold 文案），否则执行猫被旧指令拖回循环。
- 元洞察：review finding 流本身就是 F168 正在解决的同构问题——无状态事件每轮全量重放、无 ledger、stale/fresh 不可分。"review-finding ledger / 增量 review 投影"是候选方向，待 operator 决定是否进 BACKLOG。
- 关联：PR #2214（R7-R21 全轨迹）| `feature-specs/f168-phase-b-issue-signals.md` 附录（不变量表）| feedback_plan_stateful_lifecycle_state_machine（F229，同类 finding ≥3 轮回 plan 层）| feedback_judgment_altitude（F140，edge case 跨轮繁殖 = 层选错）| LL-033（云端 inline P1 是 merge blocker——本条补充其边界：blocker 指"未处理的"，处理 = 修复或有据 pushback，不是"等云端说零"）
- 待办（F168 close 前，fable-5 own）：merge-gate skill 补"封板协议"段（药方一/二/四落进 SOP 文本）。

---

### LL-073: 验收口径引用的基础设施，先验证它存在
- 状态：confirmed
- 更新时间：2026-06-12
- 现象：F168 Phase B 验收口径写"真实 webhook 投评论验全链路"——写口径时（fable-5 plan）、实现时（sonnet）、review 21 轮（Maine Coon/gpt52/cloud）没有任何一方验证过 webhook 是否真的存在。Phase B close 前夕查实：clowder-ai **从无 repo webhook 配置**（`gh api hooks` 返回 `[]`），F141 上线四个月以来全部事件来自 5 分钟轮询，`.env` 里的 `GITHUB_WEBHOOK_SECRET` 从未被使用。三只猫 + 双轨 review 的集体盲区。后续 sonnet 还在此盲区上叠加了二次失误：未查投递证据就假设"GitHub 可能 POST 不到 localhost"并以此推荐降级验收。
- 根因：验收口径里的基础设施名词（webhook/CI/队列/cron）被默认为"存在且工作"——它们是**口径的前提**而非口径的一部分，于是从不被验证。前提失效时，验收设计整体悬空，且排查会走向"修复不存在的东西"。
- 药方一：**写验收口径时，每个被引用的基础设施给一行存在性验证命令**（如 `gh api repos/X/hooks`、`crontab -l`、delivery 日志抽样），并在写口径当时跑一次。
- 药方二：**排查投递类问题第一刀查 delivery 证据**（接收端事件格式 / 发送端 delivery 记录），不是检查配置语义——sourceEventId 的格式前缀（`scan:` vs delivery UUID）一条命令就判定了四个月的真相。
- 药方三：体感与机制矛盾时优先信体感证据链——operator"我们原本不就有守门 thread 吗"（事件流活着）与"需要配置 webhook"（链路不存在）矛盾，正解是两者都对：事件流活着但走的是另一条链路。先解释矛盾，再下结论。
- 元注记：本次纠偏由operator两连反问触发（"不是每个operator都有吧？轮询不能用吗？"）——多租户视角的产品直觉推翻了猫的技术惯性（webhook=主路径的继承假设），最终架构（轮询主 + webhook opt-in）反而更优。operator 的"外行"反问是架构假设的高价值压力测试。
- 关联：F168 Phase B close 记录 | LL-070（开源用户部署画像：Mac+Tailscale 无公网）| LL-072（同 saga 前一课）| feedback_verify_reachability_before_classifying | feedback_check_simple_causes_first

---

### LL-074: Multi-Agent Recovery, Ownership Handoff & the Bugs Behind the Bug
- 状态：validated
- 更新时间：2026-06-13
- 摘要：一次 multi-agent 协作恢复 session 的 7 条蒸馏 — ① 你是不可靠 agent 时干净退出 critical path（TAKEOVER 逃生门，交可外部验证方；新实例的你 ≠ 认证干净替身）；② 接手 ownership 从外部真相（feat doc / git log / 别的猫报告）重建而非记忆，区分平行自己的工作；③ 三个 read-only aggregator bug 原型（时区边界 today 检查 / 能力检测静默降级 / 多源聚合覆盖不对称）；④ 修前做 failure-mode audit 别当补锅匠（抽象 invariant → grep 所有 sibling → 一起修 → 自报 sweep）；⑤ AC-pass ≠ 可用，user-visible 输出必须 dogfood 看渲染；⑥ 判断高度四响应（halt / escalate / handoff + over-correction 陷阱）；⑦ 协作战术（pre-register 弱点 / 跨族 review 抓真 bug / PR 描述漂移代码 / 诚实记录失败是团队资产）。
- 详细全文（新模式：主文件留索引、详文另存）：lessons-learned/LL-074-multi-agent-recovery-ownership-handoff.md
- 来源锚点：[thread-id]#0001781348069695（平行 48 session 蒸馏，2026-06-13）
- 关联：feedback_judgment_altitude | feedback_evidence_slice_to_unique_coordinate | LL-071（cucu-pr-flow）| LL-073（同期 saga）

---

### LL-075: -p mode + worktree 上下文的 gate 执行三大失误点
- 状态：validated
- 更新时间：2026-06-17
- 坑：PR #2326（test:public exclusion governance Phase A）落地时，三个独立执行失误叠加：① gpt52 从**主仓**而非 worktree 跑 `node --test capabilities-route.test.js` 单文件（不是 `pnpm test:public`），测的是 stale code、跑的是根本不在他改动范围的 file；② opus-47 接手后在 `-p` headless mode 下两次用 `run_in_background: true` 跑 30+ min gate，bg bash 完成通知丢失，PID 挂死 90 min 零输出；③ 长命令尝试前台跑时触发 Bash timeout max 600000 cap 自动后台化，无法判断进度。
- 根因：三条各有根因：① 执行猫脱离 worktree 上下文切到主仓跑命令（CWD 静默重置，feedback_never_clean_without_checking）；② L0 staging 明文写了"-p 下 background bash 不可靠 → 前台跑"，执行时忘了或认为"这次应该没事"；③ 30+ min 命令超过 Bash timeout 上限会自动 bg 化，无法靠 blocking 跑获取结果。
- 触发条件：任何在 `-p`/headless mode 下跑 `pnpm test:public` / `pnpm gate` 类长任务；worktree 开发时换 window/tab 丢 CWD 上下文后继续执行命令。
- 修复：① kill hung process（PID 79245/79205/79198），在 worktree 目录前台跑单元测试；② nohup detach + 查文件 vs 短轮询；③ `until pgrep -f <pattern>; do sleep 5; done` 前台 monitor。
- 防护：
  - `-p` mode 每次跑长任务前：明确确认用 `pwd` 当前在 worktree 目录，不信 CWD 历史
  - background bash 在 `-p`/cron 下 = 死命令。前台跑，超时了用 `nohup` + 文件 monitor，不用 `run_in_background: true`
  - 长 gate（>5 min）的进度确认：`until pgrep -f "with-test-home" > /dev/null; do sleep 10; done && tail -f /tmp/gate.log`
  - gate 跑完之前**不升级/不开 issue**——执行位置和结果不确认，什么都是猜
- 来源锚点：PR #2326 session（[thread-id]，2026-06-16/17）
- 关联：feedback_never_clean_without_checking（CWD 静默重置）| feedback_p_mode_capability_self_blindness（-p 能力边界）| L0 staging "bg bash 在 `-p`/cron 下不可靠" | LL-074 §⑥（判断高度）

---

### LL-076: 开 follow-up issue 前必须在 clean main HEAD 单独验证（outsource-before-verify = 下次一定）
- 状态：validated
- 更新时间：2026-06-17
- 坑：opus-47 在 worktree 环境里撞到 gate 红（`windows-portable-redis-url.test.js` + `sync-skills-cli.test.js`），判断为"upstream flakes"，开了 #2329 和 #2330 分别交给对应 PR owner 修，以此支持"Phase A 代码自身全绿、gate 红 100% upstream"的结论并 merge。但没在 clean main HEAD 单独验证这两个 test：事后 sonnet 实测 main HEAD 两个 test **单独跑均 pass**（windows 22/22、sync-skills 8/8），说明问题只出现在 worktree full suite 的 in-suite env pollution 场景，不是 standalone regression。结果 #2329 是 false-positive（PR #2325 早已修了该 test）。
- 根因：撞到 in-suite fail → 直接归类为"他人的 upstream bug" → 开 issue outsource，没有完成"standalone 验证 → clean main 验证 → 确认是否真 regression"三层确认就下结论。把 worktree full suite 的一次 fail 当成 regression 证据，而非 test pollution 信号。
- 触发条件：任何在 worktree full suite 里撞到非本 PR 文件的 fail；准备升级/outsource 一个 bug 之前。
- 修复：事后 close #2329（false-positive），#2330 需继续确认（standalone pass 但 in-suite 可能仍有 pollution）。
- 防护：
  - **三层验证规则**（outsource 前必须过）：① worktree 单独跑确认是否必现 → ② clean main HEAD 单独跑确认是否 standalone fail → ③ 再决定：是 in-suite env pollution（本 PR 修或记录 flaky）/ inherited main regression（开 issue）/ 本 PR 引入（立刻修）
  - 跳过任何一层就开 issue = magic word「下次一定」变体（"流程合规交接"包装成把未验证的 false-positive 推给别人）
  - gate 红后**不先 merge、不先开 issue**：先定位，定位完再路由
- 来源锚点：PR #2326（#2329 false-positive close）| [thread-id] | opus-47 复盘（2026-06-17 01:24 UTC）
- 原理：worktree full suite 的 fail ≠ standalone regression——full suite 有 in-suite CWD / env / resource 污染，单文件 fail 在 full suite 里出现是 **pollution 信号**，不是 **regression 证据**。两者的药方相反：pollution → 隔离测试 / restore env；regression → 修 test 或修代码。混淆后开 issue = 把 pollution 当 regression 投递给不可能修的 owner。
- 关联：feedback_verify_before_guessing（先验证再行动）| feedback_inmemory_store_tests_miss_redis_behavior（in-suite 环境假绿）| LL-075（同 PR，gate 执行失误）
