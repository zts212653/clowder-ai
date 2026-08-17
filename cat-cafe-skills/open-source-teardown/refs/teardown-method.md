# Teardown Method Reference

## 十二个审计镜头

| 镜头 | 目的 | 典型命令/动作 |
|------|------|---------------|
| 空目录探测法 | 找 vaporware / placeholder | `find . -type d -empty` |
| 反馈链路验证法 | 验证 training/eval 是否回流 runtime | `rg "skill|memory|prompt|state|reward" environments tools agent` |
| Reward 形态分析 | 判断 eval 覆盖的任务边界 | 读 `compute_reward` / tests / verifier |
| 状态突变点追踪 | 找真正改变系统未来行为的函数 | `rg "write|save|update|patch|delete|commit|insert"` |
| 闭环验证 | 判断 self-improving 是否成立 | 画 `signal -> decision -> mutation -> future behavior` |
| 算法剥皮 | 防止把 prompt/规则包装成算法 | 建算法表 |
| 只读 telemetry 识别 | 防止 dashboard 被误解成治理 | 看 usage 是否被 ranking/stale 消费 |
| Tradeoff 论证 | 防止把哲学选择误报为落后 | 写 Learn/Gap/Do Not Follow |
| 社区情报 | 验证宣传 vs 用户实际痛点 vs 官方 roadmap | `gh issue list --search "..." --json number,title,labels,reactions` |
| 决策边界账本 | 防止 true-but-incomplete 与跨量纲总分 | 固定 workload/时间窗，列 lifecycle cost + coupled outcomes + unknowns |
| 输入谱系 | 防止论文、代码默认值与复现实验其实不是同一输入 | 对齐 paper/code/reproduction config、data、checkpoint、commit |
| 原始输出核验 | 防止 best score、loss 和平均数藏住崩溃与尾部失败 | 抽 raw output/log、失败 run、per-task/per-seed 分布 |

## 常用命令

```bash
# repo version
git status --short
git log -1 --date=iso --pretty='%H %ad %s'
git tag --sort=-creatordate | sed -n '1,10p'

# architecture surface
git ls-files | sed 's#/.*##' | sort | uniq -c | sort -nr
find . -type d -empty
rg -n "class |def |function |interface |protocol |Provider|Plugin|Manager|Registry" .

# state mutation and feedback
rg -n "write|save|update|patch|delete|insert|commit|persist|lock|hash" .
rg -n "reward|score|eval|benchmark|success_rate|stale|expire|last_used|rollback" .

# claim validation
rg -n "{claim-keyword}" .

# experiment inputs and released artifacts
rg -n "dataset|split|seed|checkpoint|base_model|learning_rate|batch_size|config" .
git diff {paper-or-release-config} {reproduction-config}

# raw outputs, failures, and tails
find . -type f \( -name "*.log" -o -name "*result*" -o -name "*output*" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*"
rg -n "fail|error|nan|diverge|timeout|crash|seed|per_task" {artifact-paths}

# community signals
gh issue list --limit 50 --search "{keyword} sort:reactions-+1-desc" --json number,title,labels,reactions,state
gh issue list --limit 50 --search "bug OR enhancement" --json number,title,labels,reactions,state
```

占位符命令必须替换成已核验的显式路径后再运行；不要把未知路径、glob 或论文里的命令原样
当成安全可执行输入。

## Input Provenance Matrix

| Layer | Version / identity | Model + data/split | Prompt/config/seed | Availability | Mismatch / claim impact |
|-------|--------------------|--------------------|--------------------|--------------|-------------------------|
| Paper + appendix | DOI/arXiv version | ... | reported | yes/no/partial | ... |
| Released artifact | repo SHA/tag | ... | actual defaults | yes/no/partial | ... |
| Reproduction | environment + command | ... | effective values | exact/partial/changed | ... |

规则：

- `paper-config`、`code-config`、`reproduction-config` 不合并成一栏；默认值也是输入。
- data、base model 或 checkpoint 不可得时记 `unknown/unavailable`，并下调相应 claim ceiling。
- “能按现有 artifact 复现”与“作者报告结论真实”是不同 claim，分别给 verdict。
- 老论文、跨域论文和经典教材负责提供反事实与 comparator，不因资历跳过适用性审计。

## Raw Output Inspection Contract

能取得运行实物时，至少检查：

```text
one representative success + one failure/tail case
raw transcript/output/log + aggregate metric
per-run/per-seed/per-task distribution + aborted/missing runs
selection rule + reported checkpoint/run relationship
```

- 原始输出不可得：写 `output evidence unavailable`，不要假装汇总分覆盖了失败形态。
- aggregate 与 raw case 冲突：先描述冲突和适用范围，不用一个总分抹平。
- 复现崩溃：先排输入/环境差异，再判断方法稳定性；保留失败 run，不静默删除。
- run/seed 选择性汇报需要候选 run、选择规则或等价过程证据；comparator / tuning budget
  不对等可由论文表格和公开 config 的明确差异成立。一次复现失败本身不证明其中任何一种。

## Algorithm Peel Table

| Mechanism | Input | Output | Type | Code path | Mutates future behavior? |
|-----------|-------|--------|------|-----------|---------------------------|
| ... | ... | ... | true algorithm / engineering algorithm / LLM judge / heuristic / rule / external service | ... | yes/no |

## Feedback Loop Test

A claimed learning loop must answer all four:

```text
signal -> decision -> state mutation -> future behavior
```

Examples:

- `tests failed -> reward -> model weights update -> next rollout changes`: real training loop.
- `tool calls >= 10 -> LLM review -> SKILL.md patch -> future skill_view changes`: procedural memory loop, but quality is not proven.
- `last_used_at displayed -> no consumer`: telemetry, not lifecycle governance.

## Performance / Cost Decision Ledger

不要追求不存在的“完整世界账本”，而要冻结当前决定的坐标系：

```text
workload + provider/model/version + comparator + time horizon
  -> measured construct + numerator/denominator/exclusions
  -> ingest/extract + query/retrieval + generation + cache + maintenance/human
  -> quality + coverage + latency + reliability + privacy/risk
  -> unknowns + source verdict + decision fit
```

规则：

- benchmark 分数只证明其测量构念内的结果；迁移到产品决策要另判 `decision fit`。
- cache 命中/写入/失效读取 provider usage；没有 usage 就保留 `unknown`。
- 不同量纲保留为向量或约束；没有显式权重、单位换算和决策场景，不生成总分。
