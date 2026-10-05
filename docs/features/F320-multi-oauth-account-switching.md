---
feature_ids: [F320]
tips_exempt: "Specification only: multi-OAuth login, family switching and project rules have not been delivered; publish their planned tips only with the real account journey, not from this proposal."
related_features: [F062, F136, F171, F291, F318, F319]
topics: [accounts, oauth, credentials, provider-routing, hub-settings]
doc_kind: spec
created: 2026-09-24
description: "同一家厂商可以登录多个 OAuth 账号（如公司号与私人号），各自隔离；按猫家族一键换绑，或按项目自动选用对应账号。"
description_source: human
description_author: opus55
description_updated_at: 2026-09-24T09:38:50Z
---

# F320: Multi-OAuth Accounts｜同一厂商多个 OAuth 账号 + 按家族一键切换

> **Status**: spec | **Owner**: Ragdoll (@opus55, claude-opus-5-5) | **Priority**: P1

## Why

operator 2026-09-24 原话：

- 09:28Z（msg `private-source-id`）：「其实我们缺了个能力，就是凭证轮转……如果可以让我在前端 UI 选择操作轮转到正常账号，好像体验也会好点，就不用一直在 codex 的 app 登入退出了；同理 claude code 的公司账号也可以和个人账号这样隔离，避免每天我都在登入登出」
- 09:35Z（msg `private-source-id`）：「现在的 oauth 只能支持一个，但是按道理我们应该支持多个，然后支持比如Ragdoll一键切换成 oauth 1、2、3。这样社区小伙伴就能在白天的时候用公司账号，晚上下班的时候直接一键把全部Ragdoll、Maine Coon切换成别的账号（私人）」；同一条消息的引用批注：「会有公司的账号和自己的账号，可能需要公司的项目用公司的账号，自己的项目用自己的账号，我觉得这个可以立项」

价值：用猫咖的人往往同时有公司账号和私人账号。现在每家厂商只能挂一个 OAuth 登录，切换就得在 Codex App / Claude Code 里退出再登录，每天来回好几次，还容易把公司项目跑在私人账号上（反过来也一样）。这个 feature 让多个账号同时登录着、相互隔离，切换只是在猫咖里点一下，并且让「这个项目用哪个账号」成为可以设定的规则，而不是靠人记着去切。

## Current State / 现状基线

- **OAuth 账号是写死的单例**：`packages/shared/src/types/client-routing.ts` 的 `BUILTIN_ACCOUNT_IDS` 给每个厂商家族固定分配一个 id（anthropic→`claude`、openai→`codex`、google→`gemini`、kimi→`kimi`、opencode→`opencode`）；Hub 账号页每个厂商只显示一个 OAuth 条目（operator 09:35Z 截图 `uploads/1790242529590-22b5542a.png`：Claude / Codex / Gemini / OpenCode 各一条）。
- **登录状态存在工具自己的目录里，由环境变量决定**：Codex 用 `CODEX_HOME`（默认 `~/.codex`），Claude Code 用 `CLAUDE_CONFIG_DIR`。实测（opus55，2026-09-24）：`CODEX_HOME` 指向另一个目录后可以登录另一个账号，互不影响（F319 账号对照实验，`~/.codex-probe-flagged`）；`CLAUDE_CONFIG_DIR` 指向空目录时 `claude auth status` = `loggedIn: false`，默认目录仍是 `loggedIn: true`。
- **底层管线已经有一半**：
  - 账号条目有 `envVars` 字段（F171；`AccountConfig` in `packages/shared/src/types/cat-breed.ts`），oauth 账号同样生效，在子进程环境里最后注入（`invoke-single-cat.ts` 的 `accountEnv`，`CodexAgentService.ts` 约 1958 行）。
  - Codex app-server 暖池 host 的复用签名包含启动环境（`CodexUnixWebSocketSession.ts` `prepareCodexHostLaunch` 对 env 做 sha256）→ `CODEX_HOME` 不同的猫天然落在不同的 host 上。
  - 创建/修改账号的接口接受 `envVars`（`packages/api/src/routes/accounts.ts`）。
- **还假设「只有一个 home」的读取方**（需要在 Design Gate 做完整 consumer census，此处是初步 grep）：`routes/quota.ts:1142`（额度只读 `CODEX_HOME/auth.json`）、`codex-session-context-snapshot.ts:131`（会话根目录）、`codex-image-scanner.ts:24`、`collective-codex-home.ts:11`、Claude bg carrier 的 `CLAUDE_CONFIG_DIR` 处理（`claude-bg-job-ownership.ts`）。
- **没有任何架构 cell 声明拥有账号解析**（`docs/architecture/ownership/cells/` 里没有 `accounts.json` / `account-resolver` / `accountRef` 的归属）。

## What

> 以下 Phase 划分是立项时的提案，Design Gate 可以调整。

### Phase A: 多个 OAuth 账号成为一等公民

- 同一厂商家族可以有多个 OAuth 账号，每个账号有自己的**登录目录**（Codex → `CODEX_HOME`，Claude → `CLAUDE_CONFIG_DIR`）；登录目录是账号上正式的字段，不需要用户手写 `envVars`。
- 账号页显示每个账号的登录状态（已登录 / 未登录 / 过期），并提供「登录」入口：在该账号的登录目录里发起官方登录流程，用户不用开终端。
- 现有的内置 `claude` / `codex` 账号平滑迁移成「OAuth 1」，继续指向默认目录；迁移后现有行为不变。
- 额度显示等读取方按账号区分（见 Current State 列出的读取方）。

### Phase B: 按家族一键换绑

- 在一个地方把某个家族（Ragdoll / Maine Coon / …）的全部猫，或者单只猫，换绑到指定的 OAuth 账号。
- 换绑从下一次调用开始生效；正在进行的调用在原账号上跑完，不会中途换号。
- 界面上随时看得到每只猫当前用的是哪个账号（例如成员列表或回复底栏）。
- 会话连续性：**换账号后必须能续上原来的会话**，行为要和今天在同一个 `~/.codex` 里手动退出再登录一样。做法是只按账号隔离「凭证」，「会话记录」所有账号共用（见 KD-3）。

### Phase C: 按项目自动选用账号

- 给项目（projectPath / workspace）设一个默认账号：公司项目自动走公司号，私人项目自动走私人号。
- 优先级需要在 Design Gate 定清楚：项目规则 / 家族换绑 / 单猫绑定 三者冲突时听谁的（见 OQ-3）。

## User Journey

### Primary Journey: 下班后一键把猫切到私人账号
- **Scope unit**: workspace
- **Actor**: operator / 社区用户（同时有公司号和私人号）
- **Entry**: Hub 设置 → 账号
- **Flow**:
  1. 账号页看到 Codex 下有两个账号：「公司」（已登录）和「私人」（未登录）。
  2. 点「私人」旁边的「登录」→ 按官方流程在浏览器里授权 → 状态变成「已登录」。之前「公司」账号的登录不受影响。
  3. 在家族换绑入口选「Maine Coon → 私人」「Ragdoll → 私人」→ 确认。
  4. 回到聊天，@ 一只Maine Coon → 这次回复走的是私人账号；界面上能看出当前是哪个账号。
  5. 第二天上班，一键切回「公司」，不需要登录或退出任何账号。
- **Success evidence**: 真实 Hub 入口的浏览器旅程（登录状态、换绑、下一条回复的账号标识）+ 两个账号各自的额度显示截图
- **Non-goals**: 自动轮换（见 KD-1）；绕开任何厂商对单个账号的限制；在猫咖里保存或展示 token 明文

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | operator | 项目设置里给「公司项目」绑定公司账号 → 在该项目的 thread 里 @ 猫 → 自动走公司号；换到私人项目的 thread → 自动走私人号 | 浏览器旅程 + 两个 thread 回复的账号标识 |
| S2 | message | 其他猫 | 读历史时能看到某条回复是哪个账号跑的（为排查限流、额度归属留痕） | prompt / get_thread_context 输出样例 |

## 需求点 Checklist

| # | 需求点 | 来源 | AC |
|---|--------|------|----|
| R1 | 同一厂商可以同时登录多个 OAuth 账号，互相隔离 | operator 09:35Z「oauth 只能支持一个，按道理应该支持多个」 | AC-A1, AC-A2 |
| R2 | 在前端界面里完成切换，不用去 Codex App / Claude Code 里退出登录 | operator 09:28Z | AC-A3, AC-B1 |
| R3 | 一键把整个家族（Ragdoll、Maine Coon）切到指定账号 | operator 09:35Z「一键把全部Ragdoll、Maine Coon切换」 | AC-B1, AC-B2 |
| R4 | Claude Code 公司号与个人号同样可以隔离 | operator 09:28Z | AC-A1 |
| R5 | 公司项目用公司账号、私人项目用私人账号 | operator 09:35Z 引用批注 | AC-C1 |
| R6 | 不做「被限流就自动切下一个账号」 | operator 09:35Z 引用批注「对，我们不要做这个」 | KD-1, AC-B4 |

## Acceptance Criteria

### Phase A（多个 OAuth 账号成为一等公民）
- [ ] AC-A1: 同一厂商家族（至少 Codex 与 Claude）可以同时存在 ≥2 个 OAuth 账号，每个账号有独立的登录目录；两个账号同时保持登录，互不影响（非作者可按账号页 + `codex login status` / `claude auth status` 复核）
- [ ] AC-A2: 现有安装升级后，原内置 `codex` / `claude` 账号成为第一个 OAuth 账号，所有已绑定的猫行为不变（升级前后同一只猫的调用走同一个登录目录）
- [ ] AC-A3: 账号页显示每个账号的登录状态，并能从界面发起该账号的登录；全过程不在界面或日志里出现 token 明文
- [ ] AC-A4: 额度显示等原本只读单一 home 的读取方，按账号显示各自的数据（consumer census 列出的每一处都有归属）

### Phase B（按家族一键换绑）
- [ ] AC-B1: 一次操作把某个家族的全部猫换绑到指定账号；下一次调用即走新账号（可从子进程环境 / host 签名 / 回复上的账号标识复核）
- [ ] AC-B2: 正在进行的调用不受换绑影响，在原账号上跑完
- [ ] AC-B3: 界面上能看出每只猫当前用的账号，回复上留有「本条由哪个账号跑」的记录
- [ ] AC-B4: 系统不会在没有人操作的情况下自己换账号（没有基于限流 / 错误的自动轮换代码路径）

### Phase C（按项目自动选用账号）
- [ ] AC-C1: 给项目设定默认账号后，该项目 thread 里的调用自动走对应账号；与家族换绑、单猫绑定冲突时，按 Design Gate 定下的优先级执行，并且界面能看出是哪条规则生效

## Dependencies

- **Evolved from**: F062（Ragdoll账号配置中枢：订阅 / 赞助 API 两通道切换；KD-1 首版只做Ragdoll）
- **Related**: F136（统一配置热更新 / 账号底座，clowder-ai#340）；F171（账号 `envVars` 注入）；F291（Codex OAuth 速度档位，按账号类型判断）；F318（Claude Agent SDK carrier 的 OAuth 登录）；F319（账号对照实验中验证了 `CODEX_HOME` 隔离）

## Risk

| 风险 | 缓解 |
|------|------|
| 换账号后原会话续不上 | KD-3：凭证按账号隔离、会话记录共用（Codex 跨账号续会话已实测通过）；残余风险见 OQ-2 |
| 公司代码跑在私人账号上（或反过来），有合规风险 | Phase C 按项目绑定 + 界面上随时可见当前账号；换绑需要明确操作 |
| 还有读取方默认只看 `~/.codex` / `~/.claude`，换号后显示或行为错乱 | Design Gate 做 code-derived consumer census（F303），每一处都要有归属 |
| 登录目录里存着凭证 | 只存路径不存 token；目录不进仓库、不上传、不在 UI 显示内容 |
| Gemini / Kimi / OpenCode 的隔离方式未知 | OQ-4；Phase A 先覆盖 Codex 与 Claude |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不做自动轮换：不会因为限流或报错自动换到下一个账号，换账号永远是人的明确操作 | 自动轮换本质是在绕开厂商对单个账号的限制；operator 09:35Z「对，我们不要做这个」 | 2026-09-24 |
| KD-3 | 只按账号隔离凭证，会话记录所有账号共用 | operator 09:4xZ 指出：今天手动退出/登录能续上会话，是因为只换了凭证、会话记录留在原地；做不到续会话，F320 就没有意义。**实测（opus55，2026-09-24 09:51Z）**：正常账号开会话并记下暗号，把这一个会话文件复制到异常账号目录的同一相对路径，用异常账号 `codex exec resume <id>` 续上，正确答出暗号，无报错；测试文件用后已删 | 2026-09-24 |
| KD-2 | 用各工具官方支持的登录目录环境变量（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`）隔离账号，不复制 token、不加代理 | 用的是工具本身支持的能力，凭证始终留在工具自己的目录里 | 2026-09-24 |

## Tips Contribution（F244）

计划新增 1–2 条 tips：①「公司号和私人号可以同时登录，在账号页一键换绑」→ 指向本 feature 的账号页入口；②「项目可以绑定默认账号」（Phase C 完成后）。

## Review Gate

- Design Gate：前端 UI/UX（账号页、换绑入口、账号标识）→ operator在真实 Hub 壳里确认；后端 / 架构（账号模型、consumer census、会话连续性）→ 跨家族猫讨论后operator拍板。
- 实现 review：默认 @codex-sol（要真找问题）；涉及凭证处理的部分另外做一次安全面审查。
