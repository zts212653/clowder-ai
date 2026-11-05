---
feature_ids: [F202]
doc_kind: evidence
created: 2026-10-28
topics: [dot, gate, diagnosis]
---

# F202 gate 第 6 轮失败诊断（小狸，进行中）

Gate @1fbffd6ace 托管 job 842s 退出码 1。bundled chunk 全绿（sol 修复生效），
capabilities chunk 1741 项中 8 失败：capabilities-route.test.js ×7 + cats-routes-runtime-crud.test.js ×1。

## 逐条定性（代码级证据，截至诊断中断点）

1. **1039 uses project mount rules for capability skill health** — 200 但 `allMounted=false`。
   测试把 worktree 的 `cat-cafe-skills` 符号链接进临时项目的 `.project-claude/skills`，
   mountRules 只启用 claude。源码侧 F202 未改 capabilities 路由（diff 为空）。
2. **1553 ignores broken project skill symlinks** — 500（期望 200）。projectDir 在 cwd 下
   （注释明说为绕 PROJECT_ALLOWED_ROOTS），未预写 capabilities.json。500 体为 `config_missing`。
3. **1588 accepts ?projectPath= query param** — 500 `config_missing`，subjectRef 指向
   /private/tmp 临时项目（realpath 后）。未预写 config。
4. **1616 keeps global capability writes persistent** — 500 `config_missing`，指向临时
   workspaceRoot 的 `.cat-cafe/capabilities.json`（absent）。测试设
   CAT_CAFE_RUNTIME_ROOT=findRepoRoot()（= worktree 根）、WORKSPACE_ROOT=临时目录。
5. **1759 discovers antigravity MCP from homedir** — 200 但 shared_tool 未被发现进
   capabilities.json（期望 home 的 mcp_config 胜出 project 的 stale 文件）。
6. **1813 realigns stale managed cat-cafe MCP paths** — 200 但托管 MCP 路径未重写到
   "stable main repo root"。测试与路由都用 `resolveMainRepoPath()` =
   `resolveStartupProjectRoot()`（从编译模块目录向上找 cat-cafe-skills/manifest.yaml，
   返回**启动 worktree 根**而非 git 主仓）。该测试由上游 sync 93f08ada5f 引入。
7. **1866 does not use project-local manifests to prune installed plugin skills** —
   200 但 `registrationConsistent=false` / phantom 非空。
8. **4263 plugin agentProvider cannot change either protected cloud identity** —
   PATCH gpt-dot 返回 404（期望 409 BUILTIN_CLOUD_IDENTITY_PROTECTED）。测试对
   gpt-pro 的同类断言（4292）**通过** → catalog 里有 gpt-pro 没 gpt-dot。
   `gpt-dot` 引用由 F202 提交 10364ed508 加入本测试文件；模板来自 repo 根
   `cat-template.json`（createProjectRootFromRepoTemplate）。

## 关键事实

- F202 diff（b2c9952f27..HEAD）未触碰 `packages/api/src/routes/capabilities.ts`；
  capabilities-route.test.js 的改动全部来自上游（05e87ffd13 等）。
- merge-base(HEAD, main) = 80f0678c39（= main HEAD，分支包含全部 main）。
- `config_missing` 错误文本产自 `packages/api/src/domains/capabilities/capability-read-service.ts`
  —— **待查 F202 是否改过此文件**（这决定 2/3/4 是真回归还是环境问题）。
- `resolveStartupProjectRoot` 注释明言"返回启动 worktree 而非 git 主仓"——1813 在
  链接 worktree 下路由与测试的 root 可能分歧，属工位环境假说的重点嫌疑。
- 主仓 checkout（/Users/lang/workspace/github-lab/clowder-ai @80f0678c39）dist 为
  2026-09-09 构建，太旧不能直接跑对照实验。
- run-public-tests chunk fail-fast：前 5 轮 gate 都死在更早 chunk，capabilities chunk
  从未在工位跑过——这 8 项"新暴露"≠"新回归"。

## 追加定性（对照实验启动前）

- **F202 未触碰 `packages/api/src/domains/capabilities/`**（diff 为空）→ 失败 2/3/4
  的 `config_missing` 行为不是 F202 直接改出来的。
- **失败 8（gpt-dot 404）归因**：`['gpt-pro','gpt-dot']` 循环由 **f5516afe2d（#1677,
  sync 线，非 F202 提交）** 加入；`cat-template.json` 含 gpt-pro ×9、**gpt-dot ×0**
  （main 与工位一致）→ 模板种出的 catalog 里根本没有 gpt-dot，404 是必然。
  F202 自己新增的 +43 行测试（POST gpt-dot 期望 201）反而证明 gpt-dot **不是**
  内建受保护身份。即 #1677 的测试前提（模板含 gpt-dot）从未成立 → **sync 线
  预存在失败**，与 F202 无关。修法（模板补 gpt-dot 还是改测试预期）属产品语义
  决策，归 author/owner，不在我的 fixture 小修授权内。
- capabilities 7 项：F202 没碰 route/domain，但经 plugin 域的传递影响（测试 7 明确
  依赖 plugin 清单）不能排除 → 由对照实验一锤定音。

## 对照实验（已启动，后台 task bash-0fe6uqly）

独立克隆 `/tmp/f202-probe-base`（git clone --shared，普通 checkout 而非链接
worktree），checkout **b2c9952f27**（F202 基线，含全部 sync 线提交、不含 F202），
pnpm install + build 后跑同两个测试文件，日志 `/tmp/f202-probe-test.log`。

- 同样 8 败 → sync 线/环境预存在，**F202 无责** → 回球 @sol 附逐条证据；
  若败因是链接 worktree 环境（需第二次实验区分）再判 fixture 小修。
- 全绿 → F202 造成（或工位环境造成）→ 第二次克隆 @1fbffd6ace 区分：
  绿=工位环境（fixture 适配在我授权内），红=F202 回归（回球 author 修）。

## 剩余步骤

1. 等实验终态（PROBE_EXIT + fail 列表）。
2. 按上分流；fixture 类自决修+复跑+重托管 gate（新 idempotencyKey
   `kimi-f202-gate-round7-<head>`），非 fixture 类逐条回球 @sol。
3. 回球前再看 sol 的证据文档是否已追加本轮分析（单一真相源）。

## 边界提醒（不可越）

- 不绕过 preview guard、不改运行配置、不重启运行实例（cat-cafe-develop-base）。
- gate 绿之前不回球"完成"；隔离预览/体验验收/fork soak 未完成不合并不宣称验收。
- 本小时持球额度：第 6 轮 gate 托管是第 2 次 hold（max 3）。

## 对照实验三结果（2026-10-28 08:0x UTC，基线 b2c9952f27）

干净 `--shared` 克隆 @b2c9952f27（非链接 worktree），清 node_modules 后 install +
build，gate 同款命令跑同两文件：**157 pass / 0 fail，PROBE_EXIT=0**
（`/tmp/f202-probe-test.log`）。测试数 157 vs 工位 158：差 1 项即 F202 自己新增的
POST gpt-dot 测试，数量自洽。

结论：这 8 项失败在 F202 基线（含全部 sync 线提交）+ 普通克隆环境下**不存在**。
排除"F202 基线代码本身携带这些失败"。

实验四（决定性）进行中：同法克隆 @1fbffd6ace848fd11966b8a1dc1c5a3ca1907daa。
- 绿 → 链接 worktree 环境假说成立（`resolveMainRepoPath()` 返回启动 worktree 根
  使⑥类断言无法成立；②③④ 的 cwd/config 预置假设同理），修法=测试适配 worktree，
  fixture 类，在小狸授权内，自决修 + 工位复跑 158/158 + 重托管 gate。
- 红（同 8 败签名）→ F202 回归，回球 @sol（作者）修。

## 实验四状态（09:0x UTC）

首次运行（bash-3f0g041m）在 mcp-server build 阶段被应用退出打断（SIGTERM），
非真实编译错误。node_modules 已装好，续跑任务 bash-yvpyboow 从 mcp-server
build 起接着跑，日志同路径（/tmp/f202-probe-head-build.log、-test.log）。

**分流决策不变**：绿=链接 worktree 环境假说 → fixture 类自决修 + 工位复跑
158/158 + 重托管 gate（wakeWhen idempotencyKey kimi-f202-gate-round7-1fbffd6ace）；
红=F202 回归 → 回球 @sol。

期间 co-creator 问能否验收，sol 答还不能（gate 8 败 + 隔离预览 5172 stopped），
并把"查明 8 项根因、修复后回球"正式托付给小狸——与既有授权一致，无新增边界。


## 09:15 UTC 作者接续：根因已核实，原工位回归通过

上文保留小狸诊断过程与当时假说；以下为砚砚接手后的纠正与验证。

- 候选克隆没有可用的测试终态：构建日志止于 mcp-server / API build，
  `/tmp/f202-probe-head-test.log` 不存在。因此不把实验四当成结论。
- 7 项 capabilities 失败的共同机制已从源码核实：
  `allowsImplicitCapabilityWrites()` 对未声明 runtime 身份的链接 worktree 返回
  false，路由因而只读，不执行测试预期的 bootstrap/heal/discovery/prune。
  普通 clone 的 `.git` 是目录，所以基线 clone 全绿不能推出这些是 F202 回归。
- 旧 gpt-dot 断言属于 F202 后应适配的消费方：基线在查找成员前有 Dot 特判；
  F202 删除此特判，模板没有 Dot 时返回 404 符合新契约。不能仅凭模板无 Dot
  就认定基线必然失败，也无需为此新增受保护身份。
- 修复只改两份测试：7 个写入用例显式模拟 persistent owner，但 workspace、
  HOME 全部隔离到临时目录；broken-skill 用例改用外部临时项目，避免 runtime
  后代重映射；gpt-pro 保护断言保留，gpt-dot 普通成员回归保留。
- 在原 feature 工位通过同两文件 + F324 预览只读保护 + startup CLI config：
  **173 pass / 0 fail / 0 skipped，exit 0**。日志
  `/tmp/f202-owner-route-red.log`（158 中 8 败）与
  `/tmp/f202-owner-route-green.log`（173 全过）。

生产代码、写入保护、模板和运行配置未改。完整 gate 与独立增量复审仍待当前提交
验证；隔离预览、真实体验验收与 fork soak 均未完成。
