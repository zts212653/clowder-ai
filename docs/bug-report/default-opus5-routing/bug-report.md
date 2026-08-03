---
feature_ids: []
topics: [routing, roster, opus-5]
doc_kind: bug-report
created: 2026-08-03
tips_exempt: existing routing-policy bugfix; no new user-facing capability or discovery path
---

# 默认协作猫仍路由到已禁用 Opus

## 报告人与复现

- 报告人：co-creator 在协作中发现；砚砚（`@codex`）复现并调查。
- 前置状态：runtime roster 中 `opus.available=false`，`opus-5.available=true`；旧 `opus` 不在当前可路由集合。
- 复现路径：进入需要架构协作的提示或 Hub 路由策略，观察默认目标仍显示/生成 `@opus`；直接 mention 旧猫时只能依赖投递层事后告警。
- 期望：默认生成 canonical `@opus-5`；显式 mention 旧猫仍 fail-closed 并把 successor 放在 alternatives 首项；没有有效 successor 时不猜同族版本，并显示结构化告警。
- 实际：公开 seed、默认 resolver、MCP 示例、routing policy 与活跃教学入口仍绑定旧 catId。

## 诊断胶囊

| 栏位 | 内容 |
|------|------|
| 现象 | runtime roster 已禁用 `opus` 并启用 `opus-5`，但公开 seed、默认猫 resolver、MCP 示例、routing policy 和活跃教学入口仍生成 `@opus`。 |
| 证据 | runtime `getDefaultCatId()` 实测返回 `opus`；`cat-template.json` 中 `opus.available=true` 且没有 `opus-5`；代码 fallback 命中 `McpPromptInjector.ts` 和 `session-resolvers.ts`。 |
| 根因 | 猫目录演进后，默认选择和认知示例仍绑定旧 catId；`getDefaultCatId()` 的首 breed fallback 未校验 availability，routing alternatives 也没有稳定 successor 真相字段。 |
| 诊断策略 | 对照 runtime catalog 与公开 template，逆向 `template -> registry -> default resolver -> prompt -> parser` 数据流，并把每个生成面固化为回归测试。 |
| 超时策略 | 若需要三处以上独立 successor fallback，停止点修，回到 roster 单一真相字段设计。 |
| 预警策略 | 通过版本号猜 successor、复制私有 runtime catalog、或全局替换历史 `@opus` 都说明方向错误。 |
| 用户可见修正 | 新安装和现有 overlay 都优先显示、示例化并路由到可用的 `@opus-5`；无有效 successor 时保留结构化告警，不静默改投。 |
| 验收 | template 状态、默认 catId、disabled alternatives、MCP prompt、routing policy、A2A parser 与活跃教学入口全部通过回归。 |

## 根因分析

数据流为 `cat-template/catalog -> registry -> default resolver -> prompt/roster -> parser/UI`。目录升级只完成了 runtime 实例配置，以下生成面没有统一迁移：

1. 公开 `cat-template.json` 仍把旧 `opus` 标为可用，Ragdoll 默认 variant 也仍指向旧模型。
2. `getDefaultCatId()` 接受 breed 默认值时没有验证 availability；runtime override 和 `DEFAULT_CAT_ID` 也没有稳定替代规则。
3. prompt、MCP 示例和 Hub policy 直接保存/显示旧 catId，认知层会继续先写已禁用句柄。
4. 投递层虽然会返回 disabled warning，但 alternatives 没有 roster 级 successor 真相源，只能在错误发生后补救。
5. feat-index 的隐式 owner metadata 仍按旧身份标签解析；旧猫禁用后，`owner: 布偶猫` 会失去 `ownerCatId` 和建议路由。

canonical mention 由 `pickVariantMention()` 优先精确匹配 `@${catId}`，因此 `opus-5` 的稳定显示句柄是 `@opus-5`；`@opus5` 仅保留为兼容 alias。

## 修复方案

在 roster entry 上记录可选 `successor`，由 availability-aware resolver 统一消费。公开 seed 只同步 Opus 5 的公开字段；runtime 私有头像、别名和实例状态不复制。历史 feature/architecture 记录不做全局替换。

稳定规则：

- 仅源猫显式 `available=false` 时解析 successor。
- successor 必须已注册且可用；不按版本号或同族排序猜测。
- 默认目标、runtime override 与 `DEFAULT_CAT_ID` 统一使用同一 resolver。
- 显式 mention 禁用猫不静默改投，仍返回 `cat_disabled`，但 alternatives 首项为有效 successor。
- 无有效 successor 时默认 resolver 返回 `__none__`，prompt/UI 剔除或禁用目标并暴露告警。

## 放弃的备选

- 不从 runtime catalog 整体复制配置：其中含私有 aliases、头像和实例 tombstone，公开 seed 只移植必要 delta。
- 不把 `@opus-5` 硬编码到各 resolver：会在下一次成员演进时再次漂移。
- 不自动挑选同 family 的最高版本：family 与版本号不构成稳定 successor 契约，误投比 fail-closed 风险更高。
- 不全局替换历史 `@opus`：旧 feature、architecture 与 fixture 是当时事实，只修当前规范性/教学入口。

## 改动范围

- 配置：共享类型和 loader 支持 `roster[*].successor`；公开 seed 增加 Opus 5 variant/roster/model，并禁用旧 `opus`。
- resolver：默认猫、目标 alternatives、prompt roster、MCP 示例统一按显式 successor 和 availability 解析。
- API/UI：`GET /api/cats` 透传 roster metadata；Hub 读取 successor、保存 canonical catId，并提供无替代者错误态。
- 协作 metadata：feat-index 的隐式 owner 标签只在存在唯一显式有效 successor 时迁移；显式 `@opus` 路由语义不变。
- 认知入口：README 三语、`docs/TIPS.md`、callback prompt 与 `cross-thread-sync` 当前示例改为 `@opus-5`。
- 回归：覆盖正常 successor、未知/禁用 successor、默认 override、A2A mention、MCP prompt、API metadata 与 Hub policy。

## 验证结果

### 自动化

| 检查 | 结果 |
|------|------|
| A2A mention 回归 | 68/68 通过 |
| cat config / successor 回归 | 102/102 通过 |
| target/default/MCP 聚焦集 | 49/49 通过 |
| MCP injector 单文件 | 12/12 通过；历史 `teammates=["opus"]` 会优先解析到 successor，不受无关 runtime default 干扰 |
| prompt fail-closed | 2/2 通过 |
| `/api/cats` successor metadata | 1/1 通过 |
| Hub successor policy | 4/4 通过 |
| AgentRouter successor + `POST /api/messages` disabled warning | 5/5 通过；旧 participant/last-replier 在 peek/persist 两条路径均保留优先级并解析到 `opus-5`；显式 `@opus` 无目标时先广播 successor warning，再返回 `NO_TARGETS` |
| Public CI 受影响 fixture（19 文件） | 402/402 通过；旧 HEAD 的 74 个失败已全部覆盖 |
| feat-index 隐式 owner 聚焦集 | 16/16 通过；`布偶猫` 等旧身份标签解析到唯一有效 successor |
| 受影响 20 文件合并回归 | 537/538；唯一失败为 `callback-routes.test.js` 的既有 Windows absolute-path 断言（实际 `G:\...`，测试只接受 Unix `/...`） |
| `pnpm lint` | exit 0；仅仓库既有 warning |
| 改动代码 Biome | 25 个代码/JSON 文件 lint exit 0；14 个 LF-safe 文件 formatter exit 0 |
| Skill 门禁 | `check:skills:manifest` + `check:skills:surfaces` 通过；5 个既有 MCP advisory；完整 `check:skills` 另被 worktree 的 185 个 skill mount 异常阻塞 |
| `pnpm check:capability-tips` | 通过；7 个既有 sourceRef warning |
| `pnpm build` | 清除继承的 `NODE_ENV` 后 exit 0 |
| `git diff --check` | exit 0 |

全仓 `pnpm check` 在 Windows checkout 上被 4499 个 CRLF 格式错误阻塞，命中大量未改文件。包级 `pnpm --filter @cat-cafe/api test` 在进入测试前被 Windows 不支持的 `VAR=... command` 语法阻塞；改用 Bash 后又分别命中参数列表过长和长时 callback/hold-ball 基线用例，已终止并清理仅属于本 worktree 的残留测试进程。`pnpm --filter @cat-cafe/web test` 的包装脚本也存在既有 `spawn pnpm ENOENT`。本 PR 用 355/356 受影响 API 集、17/17 核心路由聚焦集、4/4 Hub Vitest、TypeScript lint、改动文件 Biome 和全构建覆盖对应风险，不声称这些 Windows runner 基线问题已修复。

### Dogfood-Your-Slice

Scope verdict: 必做；这是用户和猫都可感知的路由 bugfix。

- 隔离环境：worktree `fix-default-opus5-routing`，Web `http://localhost:3101`，API `http://localhost:3102`，`MEMORY_STORE=1`，`REDIS_URL` 清空，template/global config/log 全部指向系统临时目录；未触碰 runtime `3003/3004` 或 Redis `6399`。
- 正常态：`GET /api/cats` 返回 `opus.available=false`、`opus.successor=opus-5`、`opus-5.available=true`；页面显示“避开 `@opus-5` / 优先 `@opus-5`”，开关和保存可用。
- 真实保存：勾选架构优先并点击保存，`PATCH /api/threads/default` 返回 200；回读得到 `routingPolicy.scopes.architecture.preferCats=["opus-5"]`。
- fail-closed：临时模板移除 successor 后重启隔离 API；页面显示“未找到可用的架构猫替代者”，两个开关和保存按钮全部禁用，核心 cats/thread/session 请求均为 200。
- 视觉证据：1440x1000 正常态、390x844 移动端、1440x1000 fail-closed 截图；移动端 `scrollWidth=clientWidth=390`。另有 15 秒实时页面 WebM。
- 证据目录：`%TEMP%/cat-cafe-evidence/default-opus5-routing/`，不进入仓库。
- 同页 usage 统计在 memory acceptance 环境返回既有 501/404；路由面板依赖的 `/api/session`、`/api/cats`、`/api/threads/default` 全部成功，未发现本次 slice 的 Console/page error。

## Quality Gate

- 原始需求覆盖：动态 successor 优先、单一真相源、无替代 fail-closed、canonical handle、历史 preferred policy/participant/last-replier/MCP teammate 迁移、回归与活跃入口全部落实。
- Public CI 回归：旧 HEAD 暴露的 74 个禁用 `opus` fixture 已迁移到当前可路由 `opus-5`；旧 `@opus` 的显式 fail-closed 用例保留。
- 交付完整性：本次修复已闭环，不依赖另一个 PR 或重写。
- Architecture cell：现有 cat config / dispatch routing；Map delta: none。新增 roster 字段，不新增 Store/Queue/Router 边界。
- Fallback audit：产品代码没有同文件新增三层 fallback；successor 解析是单一显式契约，未知/不可用直接返回 null。
- Tips Contribution：豁免，原因见 frontmatter；这是既有路由策略修复，没有新能力或发现入口。
- Design：`designs/**/*.pen` 没有匹配 `opus/routing/default` 的设计稿；UI 复用既有 settings 组件与语义 token。
- Artifact hygiene：截图与录屏均在系统临时目录；仓库根目录没有新增媒体/设计工件。
- Skill 质量：`cross-thread-sync` 仅修正现有示例的 canonical 目标，不改变 description、触发边界、副作用或流程结构；manifest 与 first-party surface 两项阻塞门禁已通过，完整挂载看板的 worktree 异常单独记录。
- 门禁脚本缺口：当前 baseline 不含 `scripts/check-fallback-layers.mjs`、`scripts/check-hotfix-pattern.mjs` 和 architecture ownership 脚本，以上项目按 diff 手工审计并在此记录。
