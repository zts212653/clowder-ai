---
name: worktree
tips_exempt: Developer isolation workflow with no end-user capability or useful Hub discovery moment.
description: 为代码、脚本、API 与第一方执行面创建隔离 Git worktree，并配置 Redis 6398；classifier 放行的 co-creation docs direct push 不进入本流程。
triggers:
  - "开始开发"
  - "新 worktree"
  - "开 worktree"
renamed-from: using-git-worktrees
---

# Worktree

开始任何非 trivial 的功能开发前，必须拉 worktree 隔离，不要直接在 main 上改代码。Skill / MCP description 如果改到 API route、localhost、script、CLI command、第一方执行面，即使是 ≤5 行，也不按“纯文档免验证”处理：至少 commit 前跑 `pnpm check`；非 trivial 行为改动仍应开 worktree。

## Co-Creation Docs 边界

纯文档不再按行数决定是否进 worktree。用户授权落盘的共创文档先加载 `co-creation-docs`；显然低风险时猫可直接判定，拿不准或准备升到重载体时才运行 `pnpm classify:co-creation-docs`：

- 显然 low-risk 或 `delivery=direct_push` → 不加载本 skill；走轻量文档校验 + 按内容决定 `review=required|reuse|skip` + commit/push。
- `delivery=pull_request` 且 `lane=co_creation_docs` → 独立分支用于冲突/治理 review，但不自动升级 full gate。
- `lane=regular_development` → 正常加载本 skill。

`cat-cafe-skills/**`、`sop-definitions/**`、脚本、CLI 与其他第一方执行面始终属于 regular development；文件扩展名是 `.md` 也不例外。

## 开工前 Recall（F102 记忆系统）🔴

**拉 worktree 前**，先用记忆系统搜一下相关上下文（见 CLAUDE.md 记忆系统段落）：

```
search_evidence("{feature关键词}")
search_evidence("{topic}", scope="all")
```

不搜就开工 = 从零开始，可能重蹈覆辙。

## 目录位置（铁律）

**Clowder AI 项目：`../cat-cafe-{feature-name}`（relay-station/ 同级）**

```bash
git worktree add ../cat-cafe-{feature-name} -b feat/{feature-name}
```

- 🔴 **禁止在项目内部创建**（不要用 `.worktrees/` 子目录）
- 🔴 **`cat-cafe-runtime` 是生产环境，绝对不能删/清理！** 它不是开发 worktree
- 🔴 **禁止在 `cat-cafe-runtime` 里执行 `pnpm start` / `pnpm runtime:start`**（会先 kill 旧 API，等于把在线 runtime 踢掉）
- 🔴 **`localhost:3003/3004` 默认属于 `cat-cafe-runtime`**。如果你要验证当前 worktree 的未合入改动，浏览器 / Playwright / curl 不能直接打这两个端口，除非你明确是在做 runtime 验收而不是开发验证

其他项目：先查 `CLAUDE.md / AGENTS.md` 有没有指定位置 → 有就用 → 没有再问用户。

## 创建前：Main 同步检查（F073 门禁）

开 worktree 前**必须**确认 main 与 `origin/main` 完全同步（双向）。其他猫看的是 `origin/main`，不同步 = 信息不对称。

```bash
# Step 1: 检查是否有未提交的文档变更
git status --porcelain docs/ | head -5
# 如果有输出 → 先 commit 再继续

# Step 2: 检查 main 与 remote 双向同步
git fetch origin main --quiet
AHEAD=$(git rev-list --count origin/main..main)
BEHIND=$(git rev-list --count main..origin/main)
echo "ahead=$AHEAD behind=$BEHIND"
# ahead > 0 → 先 git push origin main
# behind > 0 → 先 git pull origin main
# 两者都 = 0 → 可以继续
```

如果 main 与 remote 不同步：
1. `git add docs/` + commit（如有未提交变更）
2. `git pull origin main`（如果 behind > 0，先拉取其他猫的更新）
3. `git push origin main`（如果 ahead > 0，推送本地更新）
4. 确认 ahead=0 behind=0 后再创建 worktree

## 创建前：查在飞 PR（别和别的猫撞车）🔴

Main 同步只保证你和 `origin/main` 一致，**不告诉你有没有别的猫正在改同一批文件**。开 worktree 修**跨 feature / 共享代码 / incident（回归 / 脏状态 / "看起来没人管的红灯"）**类问题前，查在飞的 PR——**两刀，缺一不可**：

```bash
# 刀 1：列在飞 PR，缩到和你要改的 feature/incident 关键词相关的
gh pr list --state open --search "<关键词>" \
  --json number,title,headRefName --jq '.[] | "#\(.number) [\(.headRefName)] \(.title)"'

# 刀 2：对可疑候选，确认它到底碰没碰你要改的文件
gh pr diff <n> --name-only          # 或 gh pr view <n> --json files --jq '.files[].path'
```

- 🔴 **刀 2 不能省**：`gh pr list` 只给标题 / 分支名，**不显示 changed files**。只跑刀 1 就下"没人在改这个文件"的结论 = 假的安心——这道 pre-flight 自己就成了"名字承诺、覆盖不到"的空门。必须刀 2 核到文件集重叠，才算查过。
- 命中同一文件 → **先去那只猫的归口 thread 打个招呼**（cross_post 一句"我也在看 X"），别闷头重复。
- 修 incident / 回归时补历史链路：`gh pr list --state all --limit 30 --search "<关键词>"`。
- 诊断里列到的分支名（CI 运行表 / `git worktree list`），**凡是匹配你这次关键词 / 同代码区的**，问一句"它在修什么"——别对全仓几百个分支做无差别 triage，那噪音比省下的重复劳动还多。
- 反过来：你开始修一个跨 feature / incident 问题后，也在归口 thread 留一句"我在改 X"。协调是双向的。

> 教训（2026-07-09 intake #2816 连环事故）：两只猫同一天、修同一批 clobber、找同一个 reviewer，互相不知道。其中一只从零重推诊断 + 366 行恢复补丁**全部作废**——只因开工前没跑这两刀。`git grep` 告诉你"代码是什么样"，回答不了"谁正在改它"。

## 创建步骤

```bash
# 1. 创建 worktree
git worktree add ../cat-cafe-{feature-name} -b feat/{feature-name}
cd ../cat-cafe-{feature-name}

# 2. 安装依赖（必须清除 NODE_ENV，否则跳过 devDeps 导致 build 失败！）
env -u NODE_ENV pnpm install

# 3. 创建 .env（Redis 隔离，必须！）
cat > .env <<EOF
REDIS_URL=redis://localhost:6398
NEXT_PUBLIC_API_URL=http://localhost:3102
EOF

# 4. 验证 Redis 隔离
echo $REDIS_URL   # 必须是 redis://localhost:6398，不能是 6399

# 5. 验证与改动风险匹配的基线（示例；不要机械跑无关全仓测试）
pnpm check:skills   # skill surface
pnpm test           # 仅在跨包行为 / high-assurance 需要全量 baseline 时
```

## Redis 隔离（数据安全红线）

| Redis | 端口 | 用途 |
|-------|------|------|
| **用户 Redis** | **6399** | operator的数据，🔴 圣域，只读 |
| **开发 Redis** | **6398** | 猫猫开发测试，随便折腾 |

**Worktree 中启动服务 = 必须用 6398。**
不设置 REDIS_URL 就启动服务 = 回落到 6399 = 数据丢失风险（LL-015）。

## 多 Worktree 并发：WORKTREE_PORT_OFFSET

F182 大赛 / 多猫并发开发时，6 个 worktree 同时跑各自服务不打架。

**OFFSET 必须 ≤ 0**（向下减避 production Redis (sacred)），范围 [-100, 0]，10 倍数。`offset=0` 留给 alpha 默认。

| OFFSET | Redis | API | Web | NEXT_PUBLIC_API_URL |
|---|---|---|---|---|
| 0（alpha 默认） | 6398 | 3102 | 5102 | http://localhost:3102 |
| -10 | 6388 | 3112 | 5112 | http://localhost:3112 |
| -20 | 6378 | 3122 | 5122 | http://localhost:3122 |
| ... | ... | ... | ... | ... |
| -60 | 6338 | 3162 | 5162 | http://localhost:3162 |

派生公式：`非 Redis = base - OFFSET`（OFFSET 是负数 → 端口向上加），`Redis = 6398 + OFFSET`（向下减）。

### 启用方式

```bash
# 1. .env 设置 OFFSET + 禁用 sidecar（多猫并发 worktree 默认）
cat > .env <<EOF
WORKTREE_PORT_OFFSET=-10
PREVIEW_GATEWAY_PORT=0
ANTHROPIC_PROXY_ENABLED=0
ASR_ENABLED=0
TTS_ENABLED=0
LLM_POSTPROCESS_ENABLED=0
EMBED_ENABLED=0
EMBED_MODE=off
EOF

# 2. 启动用 pnpm dev:direct 或 bash scripts/start-dev.sh
#    ⚠️ 不要用 `pnpm dev`！它走 pnpm -r --parallel run dev，绕过 OFFSET preflight
pnpm dev:direct
```

### 优先级（重要）

OFFSET 非 0 时，**派生值优先级高于 `.env` 和 `CAT_CAFE_RESPECT_DOTENV_PORTS`**。即使 `.env` 里硬写了 `REDIS_URL=...:6398` 也会被派生值覆盖。这是 LL-015 防回归——避免"端口数字看起来对了但 ioredis 实际连了 6399"的事故。

### 诊断

```bash
pnpm check:worktree-port-offset   # 验证全部 7 个大赛 OFFSET 派生 + 端口无冲突
```

诊断脚本是 CI 用，**不是唯一 gate**——唯一 gate 是 `start-dev.sh` 内置 preflight（启动时主动派生端口、强制 export sidecar=0、unset Redis dir 让重派生；OFFSET 派生失败 / production data boundary 6399 拒绝启动）。

### Sidecar 处理

多 worktree 并发默认**全禁用** sidecar（Preview Gateway / Anthropic Proxy / Whisper / TTS / LLM Postprocess / Embedding）。OFFSET 模式下 preflight 会**主动 export 0** 这些 sidecar 标志（不依赖用户 .env），即便用户配置了 `EMBED_MODE=on` 或 profile=dev 想拉起 proxy 也会被覆盖——无需用户手动禁用。启用 sidecar 但又不 offset 化 → 端口冲突。

详细设计见 *(internal reference removed)*。

## 合入后清理

分支合入 main 后**当场清理**，不要留到下次：

```bash
git worktree remove ../cat-cafe-{feature-name}
git branch -d feat/{feature-name}
git worktree prune
```

检查是否有积压未清理：
```bash
git worktree list             # 列出所有 worktree
git branch --merged main      # 哪些分支已合入
```

## Commit / Stash 溯源 Footer（F193 Phase E）

当当前 worktree 的改动来自跨 thread 投递、跨 feature 调查、或你预期后续猫需要反查来源 thread 时，在 commit body 或 stash message 末尾加：

```text
Thread-Context: threadId=<threadId> invocationId=<invocationId> catId=<catId>
```

示例：

```text
Why: Add read-side affordance so search/list_recent results show where to cross-post.

[Maine Coon/GPT-5.5🐾]
Thread-Context: threadId=[thread-id] invocationId=0001780508313338 catId=codex
```

规则：
- 只在有明确 thread context 时写；拿不到 `invocationId` 就省略该键，不要猜。
- 不通过 hook 自动改写或拒绝提交；这是降摩擦溯源字段，不是新门禁。
- stash 只写 tracked 临时现场；多 session 工作目录里仍禁止 `git stash -u`，避免清掉别人未跟踪产物。

## Codex `apply_patch` 陷阱（开发猫必读）

`apply_patch` 落点由**会话默认工作目录**决定，不跟着 `cd` 走。

**避免方式：**
- patch 文件名用绝对路径（指向目标 worktree）
- 或者改用 `sed/perl` 在目标 worktree 执行

## 浏览器 / 端口护栏（这次事故补的）

“我以为我在测 dev，实际打到了 runtime” 这种事故，根因通常不是命令本身，而是**CWD / worktree / URL 三者脱钩**。

验证当前 worktree 改动前，必须先明确两件事：

1. **我在哪个仓/哪个 worktree？**
   - `pwd`
   - `git branch --show-current`
2. **我要打哪个 URL？**
   - 如果目标是 `localhost:3003/3004`，默认按 **runtime** 处理
   - 如果目标是当前 worktree 的未合入改动，必须使用该 worktree 对应的独立实例/端口

一句话铁律：**未合入改动的验证，不得拿 runtime 的 3003/3004 冒充开发环境。**

## 安全核查

创建前：
- [ ] **Main 文档双向同步**（`git status --porcelain docs/` 无输出 + ahead=0 + behind=0，F073 门禁）
- [ ] 目录放在 relay-station/ 同级（不在项目内部）
- [ ] 不是 `*-runtime` 命名
- [ ] `.env` 包含 `REDIS_URL=redis://localhost:6398`
- [ ] 风险匹配的 baseline 通过（targeted 默认；高风险 / 跨包不确定才全量）
- [ ] 当前会话不是 `cat-cafe-runtime` 的运行态验收会话（验收会话默认只读，不做重启命令）
- [ ] 验证目标 URL 已明确；若是 `3003/3004`，你知道自己在打 runtime，而不是当前 worktree 的本地改动

清理前：
- [ ] 分支已合入 main（`git branch --merged main`）
- [ ] 不是 `cat-cafe-runtime`（永远不删）

## Next Step

行为 / bug 风险 → `tdd`；确定性生成物或现有 checker 已精准覆盖 → 直接以该红灯为 RED 修到绿；复杂度需要时才补 `writing-plans`。
