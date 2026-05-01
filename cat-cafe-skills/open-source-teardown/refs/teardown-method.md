# Teardown Method Reference

## 八个审计镜头

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

# community signals
gh issue list --limit 50 --search "{keyword} sort:reactions-+1-desc" --json number,title,labels,reactions,state
gh issue list --limit 50 --search "bug OR enhancement" --json number,title,labels,reactions,state
```

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
