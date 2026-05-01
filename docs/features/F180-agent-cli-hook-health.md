---
feature_ids: [F180]
related_features: [F050, F070, F113, F145, F179]
topics: [hooks, onboarding, desktop, installer, cli-config, devex]
doc_kind: spec
created: 2026-04-29
community_issue: "https://github.com/zts212653/clowder-ai/issues/614"
---

# F180: Agent CLI Hook Health and Sync

> **Status**: in-progress (Phase A+B merged via PR #1476; Phase C AC-C5 merged via PR #1477; Phase C AC-C1~C3 merged via PR #1478; Phase C AC-C4 + Phase D field repair station merged via PR #1479; AC-D4/open-source closure pending) | **Owner**: Maine Coon/Maine Coon | **Priority**: P1

## Why

Cat Cafe 的用户级 SessionStart/Stop hooks 已经是我们自己出征时的基础纪律：启动时提醒 `cat_cafe_search_evidence` recall，收尾时检查闭环。但这套能力现在主要靠本机 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 已经手动/同步过来维持。开源用户、桌面安装包用户、升级后的老用户都可能完全没有这层 hook。

team lead连续确认了两点：安装流程可以补，但不能只覆盖新 clone 的源码安装；安装包和现有用户也必须能被运行时检测并一键修复。否则开源社区里的 agent 会继续看似接了 MCP，实际缺少开工 recall 和收尾纪律。

## What

### Phase A: Hook Health Contract ✅

定义 user-level hook 的期望态和检测结果：

- Hook target 真相源直接复用 `scripts/sync-system-prompts.ts:buildTargets()`；F180 只在其上增加 selector、health status mapping 和 API surface，不重新维护第二份 target 列表。
- Claude: `~/.claude/hooks/session-start-recall.sh`、`~/.claude/hooks/session-stop-check.sh` 存在且与 `buildTargets()` 渲染结果字节级一致；`~/.claude/settings.json` 挂载 `SessionStart` / `Stop`。
- Codex: `~/.codex/hooks.json` 存在且指向同一组 hook 脚本；其中脚本绝对路径必须在目标机器上即时解析到当前用户 home，不得从仓库或 installer 预生成。
- 检测结果以 `HealthResult` 扩展既有 `DriftResult`，区分 `missing` / `stale` / `configured` / `unsupported` / `error`。

### Phase B: One-Click Sync API ✅

把 `scripts/sync-system-prompts.ts` 里的 hook target 生成和同步逻辑抽成可复用模块，给 Hub/API 提供：

- `GET /api/agent-hooks/status`
- `POST /api/agent-hooks/sync`

模块边界必须 re-export / 复用 `buildTargets`、`checkDrift`、`applySync`，并按 target `name` selector 过滤 `hooks/*` 与 `codex-hooks`。写 user home 配置在 runtime 中必须是显式用户动作触发；检测可以自动，修复不能静默。

Phase A+B 都是后端 health contract / sync module 范围，可以在同一个 implementation worktree 里落地；spec 保留两段是为了把 contract 和 API surface 分开验收。

### Phase C: Source Install and Desktop First-Run Coverage

覆盖三条入口：

- source install: `scripts/install.sh` / `scripts/setup.sh` 调用同一同步逻辑，并用 hook selector 只同步 `hooks/*` 与 `codex-hooks`，不顺手改写 AGENTS/GEMINI prompt；
- Windows installer: `desktop/scripts/post-install-offline.ps1 -AgentHooksOnly` 在 original-user context 下预装一次 user-level hooks/settings；失败不得阻塞安装；
- macOS DMG / desktop upgrade: App first-run / Hub health check 必须兜底，因为 DMG 不会跑源码 installer。
- outbound sync: `sync-manifest.yaml` 必须放行 `.claude/hooks/user-level/`，并以模板形式携带 `.claude/settings.json` 的 hook 段；模板不得包含本机绝对路径。

### Phase D: In-App Health Surface

在新 thread / project setup surface 增加 Agent CLI Hook Health：

- OQ-1 Design Gate 已按team lead对 ProjectSetupCard 治理入口的判断收敛：Agent Hook Health 的主入口与项目治理初始化同栖，避免用户带病开工；Hub 能力中心可以后续承载深诊断，但不是本片阻塞项。
- OQ-2 已由Siamese于 2026-04-29 Design Gate 追认：当前片的 inline compact summary（target + status + diff message）足够作为现场急救站的 patch preview；完整 settings JSON patch modal 留给 Hub 大本营 deep-dive panel / UX polish。
- Hub 启动 / first-run 时做一次 status 检测并缓存到当前 app session；新线程 / 项目切换可以复用缓存或触发轻量 refresh，但不能在每条消息上重复检测。
- 缺失或过期时显示可操作提示；
- 点击同步后重新检测并显示 green；
- 不把 user-level hook 写入外部 project bootstrap，避免混淆 F070 governance pack 的项目级职责。

## Acceptance Criteria

### Phase A（Hook Health Contract）

- [x] AC-A1: 后端能检测 Claude user-level hook scripts 是否存在、是否与 repo 模板一致；内容一致性对 shell scripts 使用与 `checkDrift` 相同的字节级相等比较，对 `hooks.json` 使用 `JSON.parse` + canonical stringify 后比较，避免缩进/换行差异误报 stale。
- [x] AC-A2: 后端能检测 `~/.claude/settings.json` 是否挂载 SessionStart/Stop。
- [x] AC-A3: 后端能检测 `~/.codex/hooks.json` 是否存在，并且命令路径解析后指向当前用户 home 下的 `~/.claude/hooks/{name}`，对应脚本文件存在。
- [x] AC-A4: 新建 `HealthResult` 类型扩展 `DriftResult`：`drifted=true + target file does not exist` 映射 `missing`，`drifted=true + content differs from rendered shards` 映射 `stale`，`drifted=false` 映射 `configured`；`unsupported` 用于 CLI 未安装/目录不存在等非错误状态，`error` 用于读取失败/权限异常等真实错误，并包含可展示的人类可读原因。
- [x] AC-A5: `missing` / `stale` 结果返回 diff-like 摘要；shell scripts 提供前后行号摘要，JSON config 提供字段路径摘要。

### Phase B（One-Click Sync API）

- [x] AC-B1: Hook target 生成、drift 检测、写入逻辑从 `scripts/sync-system-prompts.ts` 抽成 `packages/api/src/agent-hooks/` 或等价可测试模块，CLI 和 API 共用 `buildTargets` / `checkDrift` / `applySync`；API 只通过 selector 过滤 `hooks/*` 与 `codex-hooks`，不重新实现 target 列表。
- [x] AC-B2: `POST /api/agent-hooks/sync` 能写入/更新 Claude hook scripts、Claude settings hooks、Codex hooks.json；写 `~/.claude/settings.json` 时只增删 Cat Cafe managed hook command entry，保留未知 user-defined hook entries。
- [x] AC-B3: 写入 user home 前有明确 API action，不在项目 bootstrap 中静默触发。
- [x] AC-B4: 同步后立刻重新检测，返回最新 status。
- [x] AC-B5: `pnpm exec tsx scripts/sync-system-prompts.ts --apply` 与 `POST /api/agent-hooks/sync` 的 hook scripts / Codex hooks.json 写入结果字节级一致。

### Phase C（Source Install and Desktop First-Run Coverage）

- [x] AC-C1: source install/setup 路径会尝试安装 hook，并在失败时给出非致命 warning；安装阶段视为用户已经对安装流程授权的延展同意。
- [x] AC-C2: Windows installer 会用 original-user best-effort step 尝试安装 hook/settings，失败不阻塞安装；安装阶段写入失败必须由 Hub first-run health check 兜底。
- [x] AC-C3: macOS DMG / desktop first-run 能通过 Hub health check 发现缺失并一键修复。
- [x] AC-C4: 现有用户升级后打开 Hub 或任意 thread 能看到缺失/过期提示；status 检测由 Hub 启动/first-run 触发一次并缓存到当前 app session，不能在每条消息上触发 N+1 检测。
- [x] AC-C5: outbound sync 后，开源仓能找到 `.claude/hooks/user-level/session-start-recall.sh`、`.claude/hooks/user-level/session-stop-check.sh`，以及不含本机绝对路径的 `.claude/settings.json` hook 模板。

### Phase D（In-App Health Surface）

- [x] AC-D1: 前端有 Agent CLI Hook Health UI，展示 Claude/Codex 分项状态。
- [x] AC-D2: 点击同步按钮后，UI 从 warning/error 变为 configured green。
- [x] AC-D3: 外部 project governance bootstrap 仍只处理 `CLAUDE.md` / `AGENTS.md` / skills，不写 user-level hooks。
- [ ] AC-D4: 开源同步后 `clowder-ai#614` 可以用 fixed-internal → synced → close 的链路收口。

## Dependencies

- **Evolved from**: F050（系统提示词两层一源，同步 `~/.codex/AGENTS.md` / hooks）
- **Related**: F070（Portable Governance Pack，项目级 bootstrap）
- **Related**: F113（Multi-Platform One-Click Deploy，source install/setup）
- **Related**: F145（MCP Portable Provisioning，本机 capability health + repair 模式）
- **Related**: F179（Desktop Installer Release Pipeline，安装包入口）

## Risk

| 风险 | 缓解 |
|------|------|
| 静默改写用户 `~/.claude/settings.json` / `~/.codex/hooks.json` 引发不信任 | Runtime 检测自动、修复必须由用户点击；source install / installer 阶段视为安装同意的延展，失败不阻塞；API 返回 diff-like summary |
| Claude settings JSON 里已有用户自定义 hooks，被覆盖 | 合并写入，只管理 Cat Cafe 自己的 command entry，不删除未知 hooks |
| 安装包 post-install 权限或路径失败 | elevated post-install 不写 user profile；user-level hook sync 作为 original-user best-effort step 单独跑；Hub first-run health check 是兜底 |
| Codex hooks 支持版本差异 | `hooks.json` 写入与 CLI feature 检测分离；unsupported 作为诊断状态而不是安装失败 |
| 开源仓缺少 hook 真相源导致 health check 无模板可比 | F180 implementation 必须更新 `sync-manifest.yaml`，放行 `.claude/hooks/user-level/` 与 settings hook 模板 |
| Codex hooks.json 携带本机绝对路径导致跨机器失效 | 仓库/installer 不预生成 `hooks.json`；目标机器每次由 sync module 根据当前 home 即时渲染 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 安装脚本是优化路径，Hub runtime health check 是兜底路径 | 安装包、升级用户、权限失败都可能绕过 install.sh | 2026-04-29 |
| KD-2 | User-level hook 不放进 project governance bootstrap | F070 管项目级治理，hook 是用户级 agent runtime 配置 | 2026-04-29 |
| KD-3 | Runtime 检测自动，修复显式点击；source install / installer 阶段可 best-effort 自动写入 | Runtime 写用户 home 配置必须可见、可解释；安装阶段已有用户对安装流程的延展同意，失败由 Hub first-run 兜底 | 2026-04-29 |
| KD-4 | Hook target 真相源是 `scripts/sync-system-prompts.ts:buildTargets()` | 避免 API / CLI 双写 target 列表，后续 hook 内容变更只改一处 | 2026-04-29 |
| KD-5 | Codex hook 配置里的脚本绝对路径必须在目标机器即时解析 | `~/.codex/hooks.json` 是本机解析态，不是可跨机器 ship 的静态模板；沿用 F145 声明式期望态 vs 本机解析态模式 | 2026-04-29 |
| KD-6 | Hook Health 的可见入口跟 ProjectSetupCard 治理初始化同栖，并在任意 thread 对异常状态给出轻量预警 | Hook 是用户级 runtime 前置条件，但风险暴露发生在开新 thread / 项目开工时；放在治理入口比藏在 Hub 更符合用户发现路径 | 2026-04-29 |

## Review Gate

- Phase A/B: 需要后端 + 配置安全 review，重点看 user home merge 写入和路径边界。
- Phase C/D: 需要桌面安装包路径 review + 前端 in-context observability review。
