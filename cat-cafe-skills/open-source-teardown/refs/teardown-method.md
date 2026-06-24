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

## GitNexus 加速：Step 1 架构地图

GitNexus 是本地代码知识图谱工具（基于 LadybugDB），可以**把"手工 rg/find 几十次画架构图"加速到几次 CLI 查询**。仅用于 Step 1 架构地图绘制；Step 2 明星特性追链路、Step 3 算法剥皮、Step 4 反馈链 **仍需人工读源码**——图谱是"地形图"，不是"质量审计"。

### 何时启用 / 不启用

| 启用 GitNexus | 不启用 |
|---|---|
| 仓库 ≥500 个源文件 | <500 文件直接 `rg` / `find` 更快 |
| Python / JS / TS / Go / Rust / Java / C# 等主流语言 | 非主流语言 / 二进制项目 / 配置仓 |
| 需要"被引用最多的 hub 节点 / 调用链路 / 影响面" | 只需要看 ls 顶层结构 |
| 不想读 README 就想知道入口在哪 | 已经知道入口 |

### 5 分钟 setup（一次性，全局）

```bash
# 装包（npm 11.x 用 pnpm，npx 对 native 依赖有 bug）
npm install -g gitnexus
# 或：pnpm install -g gitnexus

# C++ 编译报错时跳过可选 grammar
GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 npm install -g gitnexus

# 验证机器能力（图存储/全文搜索/向量索引应该都 available）
gitnexus doctor
```

### 单次拆解流程

```bash
# 1. 准备目录（不污染主仓库）
mkdir -p ~/workspace/teardown && cd ~/workspace/teardown

# 2. clone：用显式 HTTPS URL，绕过代理 SSH fakeip 问题（见 LL-088）
# ⚠️ 不要写 `gh repo clone {owner}/{repo}` —— 当用户配过 `gh config set git_protocol ssh` 或
#   `gh auth login --git-protocol ssh` 时，gh 会回退到 SSH，还是撞 fakeip
gh repo clone https://github.com/{owner}/{repo}.git
# 或纯 git：
# git clone https://github.com/{owner}/{repo}.git
cd {repo}

# 3. 索引（中等项目 1.5k 文件实测 13 秒）
gitnexus analyze
# warning "FTS extension unavailable; continuing without FTS" 可忽略——影响关键词排序，不影响图查询

# 4. 看索引规模（决定后续查询深度）
gitnexus list  # 看 nodes / edges / clusters / processes 数量
```

### Step 1 架构地图查询模板（按顺序跑）

```bash
# A. 找所有 main 入口（项目骨架的第一信号）
gitnexus query "main entry point CLI startup"

# B. 拿到候选 uid 后，看具体入口的 360 度（调用/被调用/进程）
gitnexus context "Function:{path}:{name}"
# 注意：name 单独传会触发 ambiguous（如 "main" 可能 20 个候选）
# → 必须用完整 uid 精确指定

# C. 按业务关键词探流程（query 自动识别 process）
gitnexus query "order placement live trading execution"
gitnexus query "agent loop iteration tool execution"
gitnexus query "data ingest pipeline preprocessing"

# D. 影响面分析（修改某符号会波及谁）
gitnexus impact "Function:{path}:{name}"

# E. 调用链路径（A 怎么调到 B）
gitnexus trace "{from-uid}" "{to-uid}"

# F. 文件系统补充（gitnexus 不索引 README / CHANGELOG / YAML preset）
ls -1 src/ && head -80 README.md CHANGELOG.md
ls -1 src/{interesting-module}/  # YAML / config / preset 列表
```

### Cypher 查询的实战注意

GitNexus 的 LadybugDB 不是完整 Cypher 方言 — **不要照搬 Neo4j 语法**：

| 失败模式 | 修正 |
|---|---|
| `Cannot find property kind for n` | 不要假设属性名，先 `gitnexus context` 看返回 JSON 的字段名 |
| `function SPLIT does not exist` | 用字符串前缀匹配代替 `split()` |
| `Cannot find property summary for p` | 同上，跑前 `query` 看属性形态 |

**实用 pattern**：复杂统计能用 `gitnexus query` + 文件系统 `ls / find` 完成的，**别上 cypher**。

### 收尾选项

```bash
# 留着索引继续问深的（占盘小，安全）
# 不用操作

# 完全撤掉
gitnexus clean              # 删当前 repo 的 .gitnexus/
rm -rf ~/workspace/teardown/{repo}
# 全局卸载（不推荐，除非确定不再用）
npm uninstall -g gitnexus
```

### 局限提醒

GitNexus 索引的是**代码符号关系**，不索引：
- README / CHANGELOG / SECURITY.md / LICENSE（业务定位、风险声明、license 都得人读）
- YAML 配置 / preset / 数据文件（关键业务逻辑常在配置里）
- 注释（设计意图常在注释）
- 跨语言桥接（部分支持，但不可全信）

→ Step 2 明星特性追链路时，gitnexus 给你 "这个 claim 关联到哪些代码"，**但你仍要 Read 源文件**判断 claim 是否成立（见 SKILL.md "硬规则"：LLM judge 不是算法）。

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
