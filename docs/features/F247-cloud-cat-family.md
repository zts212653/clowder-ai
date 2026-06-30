---
feature_ids: [F247]
related_features: [F178, F061, F174, F236, F237]
topics: [cloud-cat, chatgpt-pro, mcp, multi-provider, custom-instructions, github-connector]
doc_kind: spec
tips_exempt: B1a interim — productized capability tip 待 Phase D Console 多 provider UI 上线后写
created: 2026-06-21
revision_history:
  v1 (2026-06-21, commit 00a533f71): 立项
  v2 (2026-06-21, this revision): Maine Coon R3+R4+R5 跨族 review fix
    - P1 R3-1: Phase B auth split B0 harness / B1 production
    - P1 R3-2: yanyan-cloud → gpt-pro 全局统一
    - P1 R3-3 + R4: startup polling 完全砍掉，不偷换 search_evidence 伪装
    - P2 R3-1: AC-A3 footnote Checkpoint #3
    - P2 R3-2: KD-1 rewrite (F178 owns single-agent-key research, F247 owns productized platform)
    - P2 R3-4: mint roster allowlist only + Phase C breeds.variants task
    - R5: 1175 L0 hold_ball → 工具无关表述
---

# F247: 云端猫 Family + 多 provider 接入平台

> **Status**: active | **Owner**: Ragdoll (Ragdoll opus-47) | **Reviewer**: Maine Coon (Maine Coon codex/gpt-5.5) | **Vision Guard**: Ragdoll (opus-48) | **Priority**: P1 | **Created**: 2026-06-21

## Why (R3 P2-2 rewrite)

**F247 owns productized cloud-cat platform vision**：multi-provider 接入、avatars/bubbles、config UI、pluginization。

F178 §12 升级条件给出新 F 号触发集合（self OAuth AS / multi-tenant / write expansion / persisted bridge state），但 F247 真正的立项动力**不是公网 auth shape**——而是operator给的产品愿景升级（2026-06-21 06:15 PT 原话）：

> "全量版本 mcp 接入完成之后还要升级一下。比如说 gpt pro 接入进来他要是发消息了 我们猫咖前端有他的头像，甚至这个能力得做成一个能给其他社区小伙伴 类似于我们家的插件 or 其他开源项目安装那样的能迁移的呀！这样我们未来在配置猫猫上如果选择配置 chatgpt 云端 然后选模型 就能和云端的猫沟通了呀。这样甚至他就是独立的一只有自己完整头像的猫了，Maine Coon pro 版本他发消息你们也能看到气泡（或者说我能看到），他写 plan 让你们执行等等"

**触发证据（spike PASS 真理时刻 2026-06-21 06:08 UTC）**：ChatGPT Pro Maine Coon通过 cloudflared quick tunnel + Streamable HTTP MCP 成功调到 cat-cafe MCP 的 echo 工具（mock harness 验证 transport 层），亲口说"猫咖小管道通了 🐾"。

**护城河升级**：
- 现状：本地 Claude/Codex 家族 → 单 vendor 风险
- 愿景：multi-provider 聚集地 → 任何能跑 MCP connector 的云端 LLM 都能成为家庭成员

**operator signoff**：operator 2026-06-21 08:11 UTC "可以更新 feat md 了嘛？" + 08:40 UTC "先更新你的 feat md 然后再开始写代码"。

## Current State / 基线（截至 2026-06-22 闭环）

### 已验证 ✅
- MCP transport（Streamable HTTP）+ ChatGPT Developer mode connector 兼容（spike B0 mock harness）
- cloudflared **named tunnel** mcp.clowder-ai.com + `?token=` + 真 10 工具白名单端到端通（B1a, 2026-06-22）
- ChatGPT 内置 GitHub Connector Maine Coon可访问 cat-cafe 公开 repo（PR/code/diff/commit）
- CodexPro 拆解：他们用 `.ai-bridge` 文件桥做 async pull，**明示拒绝** automate ChatGPT（守 ToS）
- **fable phase0 10 工具白名单实际不含** `get_pending_mentions / ack_mentions / task tools / hold_ball`（Maine Coon R3 R5 verify）
- **B1a end-to-end 真理时刻 (2026-06-22 06:47 PT)**：
  - gpt-pro agent-key mint ✅
  - 公网 mcp.clowder-ai.com + tunnel + ingress ✅
  - MCP annotations (readOnlyHint / destructiveHint / openWorldHint) fix ✅
  - spike server pure agent-key 模式 (env -u 5 项 + AGENT_KEY_FILES override) ✅
  - cat-cafe API hot-add gpt-pro via `POST /api/cats` (0 重启) ✅
  - dry-run `cat_cafe_post_message` 真写入 thread, speaker 显示 "Maine CoonPro(Pro Cloud (ChatGPT))" ✅

### 待验证 ⚠️
- **ChatGPT Scheduled Tasks 能否调 Custom MCP Connector**（spike log 0 收到 + operator R1 指出 AI Blog Patrol 也可能没真跑：**待验证不写硬结论**）
- **Custom Instructions 实际字符上限**（需 You 当前 UI 实测）
- **Custom GPT 不读 ChatGPT 主流 memory**（operator实测确认）→ 路径修正为 Custom Instructions

### B1a 已知限制（OpenAI 平台行为，不可控）
- ChatGPT 端**对 `readOnlyHint=false` 工具 safety check 更严格**：
  - Maine Coon云端调 `post_message` / `cross_post_message` 时偶尔被 "OpenAI 安全检查屏蔽"
  - read 工具（list_threads / search_evidence 等）后期不被拦
  - 写工具看起来需要 user 显式确认（ChatGPT UI 弹 confirm button）
  - 修不了：这是 OpenAI 平台设计，B1b 升级可考虑 OAuth bearer / user-in-loop 减少 user friction

### 未做 ❌
- 公网 endpoint 真 auth（B0 disposable token-in-URL ≠ production；B1**a interim** 公网 + `?token=` 单防线接受降级；B1**b** 必须 verified CF Access OAuth 或 header-auth）
- 前端 bubble 渲染优化（catalog hot-add 显示 "Maine CoonPro(Pro Cloud (ChatGPT))" + fallback avatar 已 work；Phase C 升级真头像 + 气泡风格）
- 多 provider 配置 UI（"配置云端猫"页面）

## User Journey

1. operator在云端 provider（如 ChatGPT Pro）里启用 Cat Cafe connector，并按 Console / Custom Instructions 给出的短 L0 和 connector URL 配好云端猫。
2. 云端猫用自己的 `catId` / agent-key 进入 Cat Cafe MCP，只能看到白名单工具；需要参与协作时先读取 thread context，再通过 `post_message` / `cross_post_message` 回到猫咖线程。
3. Hub 里显示这只云端猫的独立身份、头像、气泡颜色和 provider 来源标记，operator能把它当作完整团队成员召唤、阅读和追责，而不是把云端输出混进本地猫身份。
4. 未来多 provider 配置 UI 上线后，operator从 Console 选择 provider/model，系统生成连接配置并热加载 runtime cat；新云端猫无需重启服务即可进入协作。

## What

5 个核心能力 + 5 个 Phase。

### 2.1 云端猫身份系统

**catId / runtime identity / agent-key subject 统一为 `gpt-pro`**（Maine Coon R2 verdict + R3 confirm）。**不留** `yanyan-cloud` 作为持久 identity 或 codename 双 vocabulary（R3 P1-2 要求）。

**身份注册有两层（B1a 实测后修正自Maine Coon R3 P2-4）**：

1. **`cat-config.json` roster — mint allowlist only**（`mint-agent-key/parse.ts:95-105` 消费）。
   只用字段：family / roles / lead / available / evaluation。
   **不消费**：provider / model_handle / avatar / color（roster 没这些字段）。

```json
"gpt-pro": {
  "family": "maine-coon-cloud",
  "roles": ["design-gate", "peer-reviewer", "vision-guard"],
  "lead": false,
  "available": true,
  "evaluation": "云端 ChatGPT Pro Maine Coon Pro，高阶判断席位"
}
```

2. **`.cat-cafe/cat-catalog.json` runtime catRegistry — runtime cat / callback API routing**（`packages/api/src/routes/cats.ts:485 catRegistry.register(id, config)` 消费）。
   **正确做法**：通过 `POST /api/cats` API endpoint 注入，**0 重启**（详见 LL-cat-cafe-api-has-hot-reload）。
   **错误推测**（R3 P2-4 + 47 B1a 早期）：以为要改 `cat-config.json` 的 `breeds[].variants[]` + 重启 API。
   **实际**：runtime 不读 `cat-config.json` 的 breeds，读 `.cat-cafe/cat-catalog.json` runtime data 文件。POST API 会持久化到 runtime catalog。

3. **`breeds[].variants[]` (cat-config.json)** — **design-time** template，影响 UI render 默认值 + breed catId mapping。**不参与 runtime catRegistry**。Phase C scope 简化为：avatar / bubble UX 设计 + UI render verify，不需要为 gpt-pro 加 breeds entry。

displayName "Maine CoonPro"（变体: "Pro Cloud (ChatGPT)"），昵称 "Maine CoonPro"，签名 `[Maine CoonPro/gpt-pro🐾]`，与本地 `codex`（@gpt-5.5）词面区分。

### 2.2 前端 bubble/avatar 渲染（Phase C 范围）

> **R13.5 corrected (48 实测推翻 47 R13 KD-16)**：B1a 的 `POST /api/cats` **已正确持久化** gpt-pro 到主服务实例 `cat-cafe-runtime/.cat-cafe/cat-catalog.json`（line 1394 顶层 breed entry + variant，mtime 6-22 = B1a 注册时间，`createRuntimeCat` writeFileSync 落盘 + 启动 load 恢复 OK）。47 R13 grep 错坐标看了 worktree 系死 catalog（mtime 6-15）。真 P1 = runtime catalog 中 gpt-pro entry 的 `avatar` 字段值 stale `/avatars/gpt52.png`（B1a 占位 fallback），需 `PATCH /api/cats/gpt-pro {avatar}` 走 `updateRuntimeCat` 改成 `/avatars/gpt-pro.png` 让 live 头像真换。同时 gpt52 R13 P1-2 仍对：bootstrap 真相源 = `cat-template.json` + `pickSeedBreed` 只 seed `breeds[0]`=ragdoll → 改 cat-config.json 对 live + fresh install 都不生效，撤回。Phase C scope = asset + doc（this PR）+ runtime avatar 字段切换 (AC-C-1b post-merge ops)：

- 头像设计由 **云端Maine Coon self-design** ✅（用 F229 `yanyan-codex-character-base-v1.png` 母图作 reference；KD-15）；@gemini（Siamese）从原画作者改为 **审美 verifier**（AC-C-2）
- ChatMessage 组件 verify `Maine CoonPro(Pro Cloud (ChatGPT))` 渲染正确（B1a 实测已显示对，Phase C 抛光）
- 云端猫气泡背景按 catId color theme（B1a `#2196F3` 蓝已注册到 runtime catalog 持久化，live 已生效）
- 左下角 "via ChatGPT Pro" tag（透明度低，提示来源）
- Cat picker UX 加 cloud cat 类别 + provider tag

### 2.3 多 provider 接入框架（Phase D 范围）

Console settings "配置云端猫" 流程：
1. 选 provider：ChatGPT Web / Claude.ai Web / Gemini Web / 其他
2. 选 model：从 provider available models 列表选
3. 系统自动生成 token + URL，复制到剪贴板
4. 用户在 provider Web 创建 connector 填 URL
5. 系统调 `POST /api/cats` 热加载新云端猫到 catRegistry + 持久化 catalog（runtime 路径，不动 cat-config.json breeds.variants）

### 2.4 ChatGPT 端协同协议（Custom Instructions 路径）

- Settings → Personalization → **Custom Instructions** 灌"短 L0"（精简身份 + 真相源优先级 + 自治边界 + 路由协议 + 质量门禁 + 工具无关的等待表述）
- ChatGPT memory 持久 → Maine Coon跨 thread 保留跟operator聊过的事
- 普通对话 + Custom Instructions + cat-cafe-toolkits Connector + GitHub Connector = Maine Coon Pro 完整工作配置

短 L0 工件位置：`cat-cafe-skills/refs/gpt-pro-custom-instructions.md`（采用Maine Coon R3 1175 字符版本 + R5 工具无关替换）。

### 2.5 召唤机制（user-driven，**R4 + R5 corrected**）

> **R4 关键 correction**：**不能用 `search_evidence + list_recent` 伪装 pending polling 语义**。语义不等价（无 cursor、无 ack），会引回历史 bug（LL 2026-02-16 跨 session 重复处理根因）。

**B0 harness（mock）召唤**：
- **无 polling**（无论 ChatGPT 端 Tasks 还是 startup 自检都 disabled）
- operator**手动**让Maine Coon调 stub 验证 transport
- Custom Instructions L0 段**砍掉**任何 "启动 polling / 自检 pending" 指令

**B1 production 召唤**：
- 仍 **user-driven**：operator启 ChatGPT 对话指明 context → Maine Coon用 `list_threads` / `get_thread_context` 定位 → 处理 → `post_message` 推回
- 复用 fable phase0 10 工具白名单（5 collab + 5 memory），**不含** `get_pending_mentions / ack_mentions / task tools / hold_ball`
- **不声称** pending polling 能力

**真自动 polling — future decision（独立 spec）**：
- 必须**成对**引入 `get_pending_mentions + ack_mentions`（cursor + explicit ack）
- 必须做单独安全 review（白名单扩张、跨 session cursor 持久性、ack idempotency）
- **不能用 `search_evidence` 伪装 polling 语义**
- 触发条件：实测 ChatGPT Tasks 真能调 Custom Connector + bench Maine Coon polling 流的安全/语义/UX → 才考虑升级

### 2.6 GitHub Connector 集成 ✅ 确认

operator 2026-06-21 06:54 UTC 确认：**ChatGPT 官方 GitHub Connector 已用**。Maine Coon通过 GitHub Connector 访问 `github.com/zts212653/cat-cafe`：看 PR diff / code / commit log。

**Scope 简化**：cat-cafe MCP 不暴露 file_slice 等 code 工具，code 走 GitHub Connector。cat-cafe MCP 只暴露 cat-cafe 独有（thread / message / memory），**48 R2 P0 暴露面减一档**。

## Phase 划分

### Phase A — Design Gate + 策略明确 ✅ done

### Phase B — gpt-pro 单云端猫 production 接入

**B0 (transport / mock harness)** —— 不涉及 6399 / 不涉及 agent-key / 不接真 cat-cafe data：

1. spike server v2（commit `995a9fb2b`）：echo + 5 mock `_stub` tools，redact 模块，token middleware
2. **disposable harness guard**：`?token=<secret>` query param + Bearer header；**短期一次性，spike 结束时 explicit cleanup**（删 token + revoke quick tunnel）
3. 不叫"production-ready"——这是 harness
4. Maine Coon ChatGPT 端能 list 6 工具 + 调 stub 拿 wiring OK 证据

**B1 (real toolset gate)** —— 涉及真 cat-cafe data：

1. **必须**：verified CF Access OAuth **或** verified header-auth（实测 ChatGPT connector 支持何种 → 选定）
2. **禁用** `?token=` 作为长期 production auth（OWASP 反对 secret-in-URL；48 R1 R2 严守）
3. mint gpt-pro agent-key（dry-run report 给 operator 过目，等明确 OK）
4. cat-config.json roster 注册 gpt-pro（mint allowlist only）
5. 升级 spike → `remote.ts`：替换 5 stub 为真 toolset 注册（复用 fable phase0 同 10 项白名单：post_message / cross_post_message / get_thread_context / list_threads / get_message + search_evidence / graph_resolve / list_recent / list_session_chain / read_session_digest）
6. 加 agent-key principal injection + `CAT_CAFE_DESKTOP_MODE=cloud-pro-phase0`（或同语义 mode）

### Phase C — 前端 bubble/avatar UX 优化（runtime avatar 切换）🔄 in-progress (AC-C-1a/1b done 2026-06-24, AC-C-2/3/4 pending)

> **48 R13.5 实测推翻 47 R13 KD-16**：47 R13 "B1a 没持久化、重启即丢" 是 grep 错坐标的 wrong finding。
> 真相是：B1a `POST /api/cats` **已正确持久化** gpt-pro 到主服务实例（`cat-cafe-runtime`）的 runtime catalog
> （`cat-cafe-runtime/.cat-cafe/cat-catalog.json` 顶层 breed entry，mtime 6-22 B1a 注册时间，重启从文件 load 恢复 OK）。
> 我之前 grep 的是 `cat-cafe/.cat-cafe/cat-catalog.json`（worktree 系隔离 runtime state，死文件 mtime 6-15）——
> **运行实例的 projectRoot 跟 worktree projectRoot 不同**，这是第三次 grep 错坐标（详见 47 自审段 + LL-todo）。
>
> **真正的 P1（gpt52 R12 + 48 R13.5 双 confirm）**：runtime catalog `gpt-pro.avatar` 字段值 **= `/avatars/gpt52.png`**
> （B1a 注册时占位 fallback），需 `updateRuntimeCat` (`PATCH /api/cats/gpt-pro {avatar}`) 改成 `/avatars/gpt-pro.png` —— 这是让 live 头像真换的动作（gpt52 R12 P1 本意）。
>
> **关于 cat-config.json**（gpt52 R13 P1-2）：bootstrap 真相源是 `cat-template.json`，且 `pickSeedBreed` 只 seed `breeds[0]`=ragdoll，
> maine-coon 跳过 → 改 cat-config.json 对 live + fresh install 都 0 生效，撤回保持 PR scope 最小（asset + doc only）。

- [x] **AC-C-1a — asset + doc 落地**（2026-06-24）— 云端Maine Coon self-design avatar（用 F229 `yanyan-codex-character-base-v1.png` 母图作 reference，operator 选 candidate A）：
  - asset `packages/web/public/avatars/gpt-pro.png` 上线（runtime catalog avatar 字段切换后 reference 的目标路径）
  - 视觉元素：Cat Cafe 招牌 + 蓝霓虹 cloud icon + "Maine Coon Pro" 标题 + "gpt-pro" 杯 + "补锅中"飘带（Maine Coon self-aware 彩蛋）→ 跟本地 gpt52 视觉强区分（KD-15）
- [x] **AC-C-1b — runtime avatar 字段切换**（post-merge ops done 2026-06-24 19:42 PT）— 主服务实例 `cat-cafe-runtime` 的 runtime catalog gpt-pro entry avatar 字段 `PATCH /api/cats/gpt-pro` 切到 `/avatars/gpt-pro.png`：
  - 执行：`curl -X PATCH http://localhost:3004/api/cats/gpt-pro -H 'X-Cat-Cafe-User: opus-47' -d '{"avatar":"/avatars/gpt-pro.png"}'` → response cat.avatar = `/avatars/gpt-pro.png`
  - Live verify：`GET /api/cats` 返回 gpt-pro.avatar = `/avatars/gpt-pro.png` ✅
  - Persisted verify：`cat-cafe-runtime/.cat-cafe/cat-catalog.json` breed.avatar = `/avatars/gpt-pro.png` ✅（落盘 + 重启不丢）
- [x] ChatMessage 组件 verify `Maine CoonPro(Pro Cloud (ChatGPT))` 渲染（B1a 实测已 work，Phase C 抛光）— AC-C-3 (`5d5c84653` / PR #2654): 长 label responsive truncation (`max-w-[140px/200px/280px]`) + title tooltip + timestamp `shrink-0`
- [x] Cat picker 加 cloud cat 类别 + "via ChatGPT Pro" tag — AC-C-4 (`5d5c84653` / PR #2654): `CLOUD_PROVIDER_LABELS` prefix-match table + `CatOption.isCloud/providerLabel` + pill badge UI
- [x] 气泡 color theme UI 渲染抛光（catalog 已持久化 `#2196F3` 蓝，前端微调）— **environmental satisfaction**，无需独立 PR：runtime catalog 持久化 `color: {primary: "#2196F3", secondary: "#90CAF9"}`（B1a 注册时 seed + `12ef8ce05`/PR #2653 同步进 cat-template.json）+ 前端 `catColorVar('gpt-pro', 'primary')` 通过 CSS var `--cat-gpt-pro-primary` 自动 pull through，无 hardcoded color。47 愿景守护 audit verify (2026-06-29 PT) 确认渲染链路自动满足，未来 catalog 改色立刻生效
- [x] @gemini35 愿景守护 avatar 审美 verify（小尺寸 cropped + 跟本地 gpt52 区分度）— AC-C-2 APPROVED by gemini35（视觉区分度极高：正面睁眼+咖啡杯+蓝霓虹 vs gpt52 横卧闭眼+纯白）

### Phase B1c-0 — MCP Wrapper Lifecycle Hygiene Gate（B1c 前置）✅ implementation done

> **B1c 前置 gate**（codex/Maine Coon R0 verdict + operator go）。**B1c spec 在 PR #2553**（open），本 phase 独立修底座。
>
> **背景**：browser-automation 后端（agent-browser / playwright / pinchtab）的 npx MCP wrapper **不退**，每次 cat invocation 累积 zombie（已观察 7 天 zombie + 多 backend 全部累积）。LL-056 + feedback_agent_browser_zombie 5 次 reocurrence；wrapper lifecycle 是工具 design 限制，升级 MCP 也修不了。B1c-0 修底座，B1c 才有意义（不修就让operator手动清，违反"自相矛盾"原则）。

**实现 scope**：
- 扩展 `scripts/cleanup-stale-dev-processes.mjs` 加 3 个 rule（严格白名单 + 8h age threshold）：
  - `stale-agent-browser-mcp-wrapper`：match `agent-browser-mcp`（跟已有 `agent-browser-cli` orphan rule 不冲突，那个 require ppid=1）
  - `stale-playwright-mcp-wrapper`：match `@playwright/mcp` 或 `playwright-mcp`
  - `stale-pinchtab-mcp-wrapper`：match `pinchtab ... mcp` / `pinchtab-mcp`，**显式排除** `pinchtab server` / `pinchtab bridge`（长寿命非 MCP daemon）
- 测试覆盖 22 项新增（8 positive + 14 negative，含 sanctuary fixtures：pinchtab server/bridge 永不杀，<8h fresh 不杀，generic node/npm 不杀，playwright test runner 不杀；**R1 加 6 项 negative**：`pinchtab-darwin-arm64 server/bridge --upstream-mcp-config` 不杀、marker 在 unrelated arg 里不杀、npm exec 非 MCP target 不杀；**R2 加 3 项 positive**：direct `pinchtab-mcp` binary (unqualified / 绝对路径 / npm exec form) 命中 — 修 R2 P2 claim/impl mismatch）
- **R1 matcher 重写**：从 substring search 改成 **command-structure parsing**（executable basename + first subcommand），避免 `pinchtab-darwin-arm64 server --upstream-mcp-config /tmp/x` 被 substring `mcp` 误命中（codex R1 P1 catch）。pinchtab binary 支持 `pinchtab` / `pinchtab-mcp` / 任意 platform 后缀 (`pinchtab-darwin-arm64` / `pinchtab-linux-x64` 等)，但 sub-command 必须 == `mcp`
- `scripts/launchd/cat-cafe.mcp-cleanup.plist.template` + `INSTALL.md` runbook（**模板进 git，不自动 install**——operator 看 dry-run 后手动 `launchctl load`，每天 04:00 跑 `pnpm process:cleanup`）

**hard 约束（codex R0 3 条接受 + 实施落地）**：
1. ❌ 不写独立 kill shell — 只扩展已测试 `pnpm process:cleanup` 入口
2. ❌ launchd 不自动 install — 模板进 PR，operator 手动加载（持久 OS automation 需要 explicit opt-in）
3. ✅ 匹配规则极窄 — pinchtab server/bridge 不杀 / generic node/npm/playwright 不杀，negative test fixture 全覆盖

**Real-system dry-run verify**：实测 process list 命中 3 类 stale MCP wrapper（agent-browser-mcp / @playwright/mcp / pinchtab-mcp），**未误杀** pinchtab server / pinchtab bridge / 已有 agent-browser-cli orphan rule 仍 work。

### Phase B1c — Auto Cloud Invocation Bridge（local @ → cloud notify, thread-bound）📋 spec v2

> **触发起因（2026-06-25 operator challenge）**：B1a 让用户人肉粘贴 prompt 进 ChatGPT 测试 → 跟 cc/cat 自己用 browser automation 跑 deepsearch + image gen 自相矛盾。**KD-6 "user-driven" 不该被误解成"user 手指必须动"**——browser automation 用 user chrome session + user account 是合法 user-driven 代理。
>
> **Phase B1c-0 prerequisite ✅ done** (PR #2556 squash `301f29eba`): MCP wrapper lifecycle hygiene gate landed，底座修了。B1c 现可在干净底座上 implement.
>
> **operator R1 catch (2026-06-25 23:46 PT)**：bridge 投递到 ChatGPT 端**哪个 chat**？v1 spec 漏了这层架构——每次 mention 新建 chat = sidebar 爆炸 + Maine Coon Pro 失去 conversation continuity；投到 active chat = 打断他当前讨论。**必须做 thread↔chat binding (KD-20)**。

**目标**：本地猫 @ gpt-pro → cat-cafe 自动通过 browser automation 在 user chrome 的 ChatGPT **该 thread 对应的 chat** 投递 mention 通知（带 thread context）→ Maine Coon Pro 看到后 MCP read 拉详情 + 写回复。**全程零人肉粘贴，sidebar 干净。**

#### Design 要点

**1. Backend = PinchTab 单一**（codex/Maine Coon R0 verdict + 跨 family）
- 跨族（Maine Coon/Siamese/Ragdoll都能用），不像 claude-in-chrome 仅 Anthropic 系
- attach 现有 chrome session（不开新 browser profile，减少 zombie 面）
- **可用工具实测**（codex R1 P1-A + 47 ref verify）：`pinchtab_eval` / `pinchtab_get_text` / `pinchtab_navigate` (localhost only) / `pinchtab_screenshot` / `pinchtab_snapshot`。**没有** `pinchtab_get_url` / `pinchtab_list_tabs` / `pinchtab_click` / `pinchtab_type` / `pinchtab_press`——v1 spec 误写
- **外网导航必须走 eval**（refs/pinchtab.md：Clash TUN 下 `pinchtab_navigate` 外网 403；eval 让浏览器自己走代理）
- **不抽象多 backend layer**（"只搞一个"，agent-browser 作 PinchTab 失败时 fallback 由 future PR 引入）

**2. Thread↔Chat Binding (KD-20) — operator R1 拍板**

数据 model：cat-cafe thread metadata 新增字段 `cloudCatBindings: {[catId]: chatUrl}`，例如：
```json
{
  "threadId": "[thread-id]",
  "cloudCatBindings": {
    "gpt-pro": "https://chatgpt.com/c/<conversation-id>"
  }
}
```

绑定 lifecycle（lazy + auto-self-heal）：
- **Lazy 不预绑**：thread 创建时**不**预先开 chat
- **首次 @ gpt-pro**：bridge 在 ChatGPT 端开新 chat → URL 包含 `chatgpt.com/c/<conversation-id>` → capture URL → 写 thread metadata
- **后续 @ 同 thread**：bridge 查 thread metadata → 找到 bound URL → navigate to bound chat → 投通知
- **Binding stale**（你删了 chat / ChatGPT 端 reset）：bridge navigate 失败检测 → 自动 re-open new chat + update binding，不要求用户手动重绑
- **多云端猫场景**：每只 cloud cat 一条 binding（`cloudCatBindings.gpt-pro` / `cloudCatBindings.claude-pro` 互不冲突）

**3. 触发点**（跟 KD-17 dispatch guard 集成）
- `invokeSingleCat` 看到 `provider === 'openai-chatgpt-pro'` → guard skip dispatch + 触发 cloud-invoke-bridge → fire-and-forget → yield done
- bridge 是新 service 在 cat-cafe API 内部，调 PinchTab MCP 工具

**4. 载荷模板**（thread context-aware）

```
⚡ Cat Café mention

From: @{sourceCatId}
Thread: {threadTitle} (id={threadId})
Reason: {mentionInlineContent}
Triggered: {ISO timestamp}

Action expected:
1. cat_cafe_get_thread_context(threadId="{threadId}", agentKeyCatId="gpt-pro", limit=10)
2. cat_cafe_post_message(threadId="{threadId}", agentKeyCatId="gpt-pro", content="...")
```

**5. Browser 控制流程**（all-eval pattern, Clash TUN safe, lock-first ordering）

```
trigger → bridge enter
  → acquire singleflight lock (threadId, "gpt-pro") — see §8
  → re-read thread metadata cloudCatBindings["gpt-pro"]
       (MUST be inside lock — second concurrent invocation sees the
       binding written by the first one, doesn't open a duplicate chat)
  → if bound URL exists:
       pinchtab_eval(`window.location.href = ${JSON.stringify(boundUrl)}`)
       wait for navigation (poll readyState or fixed timeout)
       pinchtab_get_text() → detect 404 / chat-not-found marker
       on stale → fallback to "create new" branch below
     else (first time):
       pinchtab_eval(`window.location.href = 'https://chatgpt.com/'`)
       wait for landing — new chat is the default ChatGPT landing surface
  → inject payload via eval (find input via querySelector + dispatch input Event)
       pinchtab_eval(`(() => {
         const input = document.querySelector('<input selector>');
         input.innerText = ${JSON.stringify(payload)};
         input.dispatchEvent(new Event('input', { bubbles: true }));
       })()`)
  → submit via eval (find send button + .click(), or simulate Enter)
       pinchtab_eval(`(() => {
         const btn = document.querySelector('<send button selector>');
         btn.click();
       })()`)
  → wait for ChatGPT to navigate to /c/<conversation-id>
  → capture conversation URL via eval:
       pinchtab_eval(`window.location.href`) → returns captured URL string
  → VALIDATE captured URL before write (§7 boundary):
       MUST match ^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$
       on validation fail → emit fallback notification, do NOT write metadata
  → if first time / stale (and URL passes validation):
       write thread metadata cloudCatBindings["gpt-pro"] = capturedUrl
  → release singleflight lock
  → yield done
```

> **Eval input safety contract** (codex R2 P1): EVERY string interpolated into a `pinchtab_eval` expression — payload / boundUrl / any future field — MUST go through `JSON.stringify(...)`. Never raw interpolation: `${boundUrl}` is the v1 mistake. Even though `boundUrl` comes from stored metadata via owner-only endpoint, treat persistent state as untrusted at the JS injection boundary.
>
> **Selector reliability**: input box / send button selectors are ChatGPT DOM internals that change. Implementation 前置 spike (AC-B1c-3a) 验证当前 selector + 端到端 eval 流程；selector 失效时 fallback notification (§6).

**6. 失败 fallback**（cat-cafe `system_info` 通知本地 thread）
- Chrome 没 running / ChatGPT.com 没登录 / input box selector 失效
- → bridge emit fallback notification 进发起 mention 的本地 thread："云端投递失败，请打开 Chrome + 登录 ChatGPT"，dispatch guard yield done 不留尾巴

**7. 隐私边界 — `cloudCatBindings` 是 local-only operational sidecar**（codex R1 P1-B catch）

ChatGPT conversation URL 是个人会话坐标——不能默认随 thread context / export / memory index 广播给其他猫。**Privacy contract**：

| Path | 含 `cloudCatBindings`? |
|---|---|
| `cat_cafe_get_thread_context` (默认 read API) | ❌ NEVER |
| Thread export (markdown / JSON / share) | ❌ NEVER |
| Memory index (`search_evidence` / `graph_resolve` / `list_recent`) | ❌ NEVER |
| Cross-thread post / mention | ❌ NEVER |
| 专用 `/api/threads/:id/cloud-bindings` endpoint (owner-only auth) | ✅ ONLY here |

Implementation 选择（择一，implementation PR 决定）：
- **A** (recommended)：thread metadata 加 `cloudCatBindings` field 但 read API path 显式过滤 (`SELECT * EXCLUDE cloudCatBindings`)
- **B**：完全分表 — 独立 `cloud_cat_bindings` table，`(threadId, catId)` 主键，cat-cafe runtime sidecar 维护

两者都满足 privacy contract；选 A 简单，选 B 更彻底。

**URL validation contract** (codex R2 P1)：写 binding 前 capture 的 URL 必须通过 strict regex `^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$`；失败则视为 capture corruption（DOM hijack / wrong tab / network detour），不写 metadata + emit fallback notification。读 binding 后也 re-validate 一次再 navigate（防 stored 态被绕过 endpoint auth 直接 db-write 注入恶意 URL）。

**8. Singleflight binding lock**（codex R1 P2-B + R2 P2 catch）

两个本地猫同 thread 同时 @ gpt-pro 首次：会 race 开两个 ChatGPT chat 并 race 写 metadata 互相覆盖。**Contract**（lock-first ordering）：

- Lock key: `(threadId, catId)` 唯一
- **bridge 第一动作 = acquire lock**（**先于** any metadata read，避免 codex R2 P2 stale read：pre-lock query 看到 "no binding" → lock 后仍按 first-bind 开第二个 chat）
- acquire lock 后 **必须** re-read metadata `cloudCatBindings[catId]` 决定 branch — second concurrent invocation 在 lock 内 re-query 看到 first holder 已写的 binding → navigate to bound chat（**不开第二个**）
- second invocation read post-lock → AC-B1c-9 explicit test fixture
- lock TTL：30s（覆盖 chat 创建 + URL capture latency；超时 auto-release 让重试）
- 整个 bridge 流程都在 lock 内（read → navigate → submit → capture → write → release）

#### Phase 边界

**B1c IN**：
- 自动 invocation bridge（local @ → cloud paste，零人肉）
- PinchTab 单一 backend
- Thread↔Chat O1 binding via thread metadata
- Auto self-heal stale binding
- 失败 fallback notification

**B1c OUT**：
- B1b OAuth verified auth（不同 layer，平行推进）
- 同步等回（fire-and-forget 起步；OQ-B1c-3）
- 多 provider 框架（Phase D）
- 多 user / 多 ChatGPT account（B1b → Phase D）
- agent-browser fallback（future PR，PinchTab 不稳时再加）

### Phase D — Console "配置云端猫" 多 provider UI

Phase B-C 后启动。Settings 页面新增 "配置云端猫"，支持选 provider / model / 自动 wire up token + URL。

### Phase E — 插件化迁移 / npm package

- Cat Café Cloud Cat Plugin v1 spec
- npm package 发布（`@cat-cafe/cloud-cat-connector`）
- 双向：别人能装到他家 LLM；我们能装别人插件

### Phase F — Plug-and-play cloud cat onboarding (planned, post Phase D/E)

**愿景** (operator raise 2026-06-29)：Phase A-D 全套实施完后，只有 dogfood 用户能用 gpt-pro —
他们手动配 ChatGPT Custom Instructions、维护 cookies、装 PinchTab、理解 sidebar 多 chat 模式。
**外部用户无法自助** = 护城河 + 复用面双输。

Phase F 把整个 cloud cat onboarding 收成一键体验，让任何装 cat-cafe 的人能自助开通
gpt-pro（以及未来 claude-cloud / gemini-cloud 等其他 cloud cats），不需要读 spec / 改 config / 学 PinchTab。

**关键 AC（占位，立项时细化）**：

- [ ] **AC-F-1**: Cat Café Console 提供 "Add Cloud Cat" wizard — 列出可装的 cloud cats (gpt-pro / future) + 安装入口
- [ ] **AC-F-2**: wizard step-by-step 引导：
  1. confirm GitHub OAuth / Chrome profile 选择
  2. PinchTab profile 自动起 + ChatGPT login 引导
  3. Custom Instructions 自动注入（cat-cafe 安装时 generate persona 模板）
  4. hello-world test message 自动验证 setup OK
- [ ] **AC-F-3**: 安装失败 fallback runbook（manual config 指引 + 诊断工具）
- [ ] **AC-F-4**: 走通后 gpt-pro plugin 上 cat-cafe marketplace（公开/受邀，operator 拍）

**前置依赖**：
- Phase B/C/D 全部 ship + dogfood 走通至少 1 周（活体验证 cloud bridge 稳定性）
- Console "配置云端猫" UI（Phase D scope）→ wizard 寄生其上
- Phase E 插件化迁移可以并行（plugin runtime + plug-and-play UX 两个 layer）

**Phase F 触发**：operator 2026-06-29 「我们走通后做给外人用」directive。预计 Phase D 完成后立项。

## Acceptance Criteria

### Phase A（Design Gate） ✅ done 2026-06-21

- [x] AC-A1: F247 立项 doc 落地（本文件）
- [x] AC-A2: Maine Coon R2 cross_post 五件套 What/Why/Tradeoff/Open/Next 接住
- [x] AC-A4: Tasks 实测 verdict 状态为"待验证"（不写硬结论）
- [x] AC-A5: GitHub Connector 集成确认 + scope 简化（cat-cafe MCP 不暴露 code 工具）
- [x] AC-A6: Maine Coon跨族 review verdict — R3 HOLD → R4/R5 plan correction → R3+R4+R5 fix done in this revision，等Maine Coon focused diff scope re-review APPROVE

### Phase B0 (mock harness)

- [x] AC-B0-1: spike server v2（commit `995a9fb2b`）token middleware + redact + 5 mock tools + echo，本地 + 公网 4 项 verify
- [ ] AC-B0-2: B0 完成时 explicit cleanup（删 token / revoke quick tunnel / 标 harness disposable end-of-life）
- [ ] AC-B0-3: 不声称 B0 是 production-ready，**不依赖 startup polling**

### Phase B1a (interim — `?token=` 单防线 + 真 toolset) ✅ done 2026-06-22

- [x] AC-B1a-1: cloudflared **named tunnel** `mcp.clowder-ai.com` + DNS CNAME + ingress route 配 localhost:3098（CF API PUT，dashboard 死代码避开）
- [x] AC-B1a-2: gpt-pro agent-key minted（agentKeyId `ak_6ac359d6370d481bb9c956b292dd49c8`，sidecar 0600）
- [x] AC-B1a-3: cat-config.json roster gpt-pro entry merged（commit `09172b5f0`，main）
- [x] AC-B1a-4: `remote-spike.ts` v4 真 toolset 注册（registerCollabToolset + registerMemoryToolset，cloud-pro-phase0 mode 收窄 10 项）
- [x] AC-B1a-5: Custom Instructions 短 L0 完成（commit `6b3390663`+，Maine Coon R3 1175 字符 + R5 工具无关替换 + R4 砍 polling）
- [x] AC-B1a-6: Maine Coon ChatGPT 端实际能调 read 工具 + dry-run via spike 写工具真写入 thread（speaker 显示 "Maine CoonPro(Pro Cloud (ChatGPT))"，messageId `0001782136023449-000294-5434e1fd`）
- [x] AC-B1a-7: 接受 `?token=` 单防线（KD-7 interim 设计）+ B1a 风险表 §C 风险知情 + Rotation SOP 沉淀
- [x] AC-B1a-8: MCP annotations (readOnlyHint / destructiveHint / openWorldHint) fix（commit `994dfa665`，绕过 OpenAI safety check 对 read 工具）
- [x] AC-B1a-9: cat-cafe API hot-add via `POST /api/cats`（0 重启，避开误判 file-only 路径）
- [x] AC-B1a-10: spike env 污染清理（`env -u` 5 项 + AGENT_KEY_FILES override 含 gpt-pro）

### Phase B1b (production verified auth) — 未排期

- [ ] AC-B1b-1: 公网真 auth 方案选定（verified CF Access OAuth 或 verified header-auth）+ 实测兼容 ChatGPT connector OAuth flow
- [ ] AC-B1b-2: 重新挂 CF Access App on `mcp.clowder-ai.com` + 配 OIDC IDP
- [ ] AC-B1b-3: spike server 升级解析 Bearer JWT + verify CF Access JWT signature
- [ ] AC-B1b-4: token rotate 通过 OAuth provider 后端完成（不影响Maine Coon云端 connector URL）
- [ ] AC-B1b-5: **禁用** `?token=` 作长期 auth；B1b only verified auth shape

### Phase C AC（B1a 落地后逐步细化）

- [x] **AC-C-1a**: gpt-pro 专属头像 asset 上线（PR #2530 squash SHA `284e9b2b8` merged 2026-06-24 19:42 PT）— `packages/web/public/avatars/gpt-pro.png` 进 git；operator 拍板 candidate A
- [x] **AC-C-1b**: runtime avatar 字段切换 done（post-merge ops 2026-06-24 19:42 PT）— `PATCH /api/cats/gpt-pro {avatar:"/avatars/gpt-pro.png"}` 执行成功；live verify + persisted verify 双过
- [ ] AC-C-2: Siamese愿景守护 avatar 视觉 + 跟本地 gpt52 区分度 OK
- [ ] AC-C-3: ChatMessage / Cat picker 渲染 `Maine CoonPro(Pro Cloud (ChatGPT))` Phase C 抛光稿
- [ ] AC-C-4: cloud cat 类别 + "via ChatGPT Pro" tag UI（可滚到 Phase D）

### Phase B1c-0 AC

- [x] **AC-B1c-0-1**: 扩展 `cleanup-stale-dev-processes.mjs` 加 3 rule（agent-browser-mcp / @playwright/mcp / pinchtab-mcp），白名单严格 + 8h 阈值
- [x] **AC-B1c-0-2**: 测试覆盖 22 项 — 8 positive + 14 negative（R1 +6 negative / R2 +3 positive），含 pinchtab `pinchtab-darwin-arm64` 真 binary form sanctuary + R2 direct binary 三种 form 全覆盖
- [x] **AC-B1c-0-3**: launchd plist template + INSTALL.md runbook 进 git（不自动 install）
- [x] **AC-B1c-0-4**: real-system dry-run verify 实测 process list（3 类 wrapper 命中 + sanctuary 未误杀）
- [ ] **AC-B1c-0-5** (post-merge ops)：operator 看 dry-run → 手动 `launchctl load` 启用每日 cleanup

### Phase B1c AC (spec v2 — 立项后实施时细化)

- [x] **AC-B1c-1** (`edd8a28ed` / PR #2627): cat-cafe API thread metadata 加 `cloudCatBindings: {[catId]: chatUrl}` field（持久化 + owner-only `/api/threads/:id/cloud-bindings` GET/PATCH endpoint，**不**进默认 thread context export 路径）。**gpt52 4 轮 review**：R1 race + contract / R2 auth bypass on system threads / R3 header literal `system` spoof / R4 APPROVE
- [x] **AC-B1c-2** (`8f09e2f16` / PR #2632, library + call-site only — 真 runtime wiring 在 PR #2634): `cloud-invoke-bridge` service — `invokeSingleCat` 看 cloud provider 时调 bridge fire-and-forget。**gpt52 4 轮 review**：R1 dead code + wrong-layer fields / R2 non-intent overflow / R3 envelope contract / R4 APPROVE
- [x] **AC-B1c-3** (`aa6d3f2f0` / PR #2634, by opus-46 同族 handoff): bridge 用 PinchTab 完成投递流程（query binding / eval-based navigate / inject payload / submit / capture URL via `window.location.href` eval / write binding）。CDP raw WebSocket port 9870（`145beb996` / #2640 hotfix 注册 PINCHTAB_CDP_PORT env + 补 doc User Journey）
- [x] **AC-B1c-3a** (gate, pre-impl, spike PASS 2026-06-26): PinchTab 实测 spike — verify 当前 ChatGPT input/send selector + eval-based 导航 Clash TUN safe + URL capture 可靠。**spike PASS verdict in `feedback_pinchtab_chatgpt_spike_findings.md`**
- [x] **AC-B1c-4** (`8f09e2f16` / PR #2632): 失败 fallback notification 投到本地 thread (`system_info` rich block) — chrome down / not logged in / selector fail。Wire-up 完整化在 PR #2634 (composition root → messageStore.append + Hub broadcast)
- [x] **AC-B1c-5** (2026-06-29 22:12 PT — **真双向 live e2e PASS**): 端到端活体实测 forward + reverse 全通。**Forward (cat-cafe → ChatGPT)**：(1) `cat_cafe_post_message @gpt-pro` routing 成功；(2) KD-17 dispatch guard fire；(3) cloud-invoke-bridge fire-and-forget；(4) PinchTab CDP raw WebSocket inject delta payload (`<thread-runtime v=1 format=json>`)；(5) ChatGPT 新建 chat `chatgpt.com/c/6a43238f-b1ac-83e8-8d09-0655afd915c5`；(6) thread metadata `cloudCatBindings.gpt-pro = chat URL` 自动写回；(7) 云端Maine Coon reply 保 signature `[Maine CoonPro/gpt-pro🐾]`。**Reverse (ChatGPT → cat-cafe)**：云端Maine Coon通过 `cat_cafe_post_message` MCP 工具写回 cat-cafe thread，messageId `0001782785550318-000160-3b0dbc66` 真持久化（speaker=`Maine CoonPro(Pro Cloud (ChatGPT))`, timestamp=`1782785550318`, threadId=`[thread-id]`, routed=`["opus-47"]`, clientMessageId=`b1c5-reverse-001-yanyan-ack`）。**KD-13 note**：云端Maine Coon admit `cat_cafe_get_thread_context` 当时被 OpenAI 安全检查屏蔽（read tool stochastic block）但 `cat_cafe_post_message` 写入成功 = MCP 工具读写权限独立 stochastic（write 这次通了 read 没通）。**Phase B1c 13/13 AC 真闭环 ✅**
- [x] **AC-B1c-6** (`3450a3b34` / PR #2643): stale binding self-heal — 删除 bound chat 后 next mention 检测 fail → auto re-open + update binding。**PR-D scope**
- [x] **AC-B1c-7** (`3450a3b34` / PR #2643): 多 thread × 同 cloud cat 不互相污染 — chat A 专 thread X / chat B 专 thread Y。**PR-D scope**
- [x] **AC-B1c-8** (`edd8a28ed` partial via 3 层 privacy + `aa6d3f2f0` 完整): `cloudCatBindings` 不出现在 `get_thread_context` / thread export / memory index / cross-post 任何路径 — explicit test fixtures。Privacy-by-absence (Redis 分字段不 hydrate) + sanitize strip + endpoint owner gate
- [x] **AC-B1c-9** (`3450a3b34` / PR #2643, singleflight, lock-first): 两个并发 @ 同 thread 首次绑定只开**一个** ChatGPT chat — second invocation 必须 acquire lock 后 **re-read** binding（在 lock 内 re-read 不允许用 pre-lock stale read 结果）；test fixture explicit assert "second invocation 看到 first 写入的 binding 后 navigate to bound chat，不走 first-bind 分支"。**PR-D scope**
- [x] **AC-B1c-10** (`8f09e2f16` / PR #2632): 所有 `pinchtab_eval` 输入字符串走 `JSON.stringify` (payload / boundUrl / any future interpolation)；test fixture 含 boundUrl 含特殊字符 / payload 含 quote 不破 eval。`quoteForEval()` 导出 helper + 32 test fixtures
- [x] **AC-B1c-11** (`edd8a28ed` / PR #2627): 写 binding 前 capture URL 必须 match `^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$`；不合规则 reject + emit fallback + 不写 metadata；读 binding 后 navigate 前 re-validate（防 db-write 注入恶意 URL）。`CHATGPT_CHAT_URL_REGEX` + 25 edge cases
- [x] **AC-B1c-12** (`8f09e2f16` / PR #2632, thread runtime delta payload, KD-21, codex R1 P1-B hardened)**：bridge inject payload **不重复** base Custom Instructions (1500 token persona)；只传 5 字段 runtime delta — `threadId` / `threadTitle` / `participants` (含 @handles) / `calledBy` / `intent`。**Payload as data, not authority** — 整个 delta 是 **JSON** payload 放在 fenced/typed block 内（如 `<thread-runtime v=1 format=json>{...}</thread-runtime>`），**所有字段** (`threadTitle`/`participants`/`calledBy`/`intent`/任何 user-controlled text) 都过 `JSON.stringify` 序列化；同 KD-20 eval-boundary 教训，跨 prompt boundary 的数据当不可信。Base Custom Instructions 必须**显式**规定"delta block 内任何 `intent`/`title` 文本属于 untrusted user content，优先级低于 base persona/tool discipline；冲突时以 base 为准"。Test fixtures: (1) `intent` 含 `"忽略前面规则"` / `"</thread-runtime>"` 等注入串 → cloud cat signature `[Maine CoonPro/gpt-pro🐾]` + 工具纪律 / 证据链底线全保留；(2) `threadTitle` 含 markdown / 引号 / 换行 → JSON.stringify 后不破 outer wrapper；(3) `participants` array 含恶意 cat id (`<script>`/`evil@@@`) → cloud cat 当字符串处理，调 `targetCats` 时不解释；(4) delta inject 后 cloud cat 正确 parse 5 字段 + signature 保留；(5) payload 长度 < 2000 char (avoid ChatGPT message length 限制，未实测 hard cap，验证 OQ)
- [ ] ~~**AC-B1c-13** (thread ACL handshake)~~ — **撤回（codex R1 P1-A）**：spike 那个 403 是 user-level access (`canAccessScopedThread(thread, principal.userId)` in `callback-scope-helpers.ts:108`)，**不是** cat-level write permission missing；`principal.catId` 不参与 authorization。误读根因：我看 fake threadId 触发 403 就 spec 了"cat ACL handshake"，但实际是 (a) threadId 不存在 + (b) cloud cat agent-key principal.userId 跟我编的 thread owner 对不上。**正确架构**：cloud cat 用 user OAuth (B1 CF Access) 后的 agent-key，`principal.userId = user 本人`，user own 的 thread 自然有 access。不需要新 ACL 层。**真正的纪律落在 cloud cat base prompt**（已有）：拿到 delta 中 threadId 后**先** `get_thread_context(threadId)` 验证 access + content match，再 `post_message` — 不假装 access、不编 messageId、403 原文报告

### Phase F AC (planned, post Phase D — plug-and-play onboarding)

详见 Phase F 段（What 章）。AC 列表（占位，立项时细化）：

- [ ] **AC-F-1**: Cat Café Console "Add Cloud Cat" wizard 入口
- [ ] **AC-F-2**: wizard step-by-step：OAuth → Chrome profile / PinchTab 自动起 → Custom Instructions 自动注入 → hello-world test
- [ ] **AC-F-3**: 安装失败 fallback runbook + 诊断工具
- [ ] **AC-F-4**: gpt-pro plugin 上 cat-cafe marketplace（公开/受邀，operator 拍）

### Phase D / E acceptance criteria 待立项后细化

## Risk

| 风险 | 缓解 |
|---|---|
| ChatGPT TOS 跳变（OpenAI 改 Developer mode 规则）| 接受系统性风险；plugin spec 抽象层让我们能换 LLM connector |
| B0 harness disposable 状态滑入 B1 production | AC-B0-2 + AC-B0-3 + AC-B1-7 三重明示；review checklist 守门 |
| gpt-pro confabulate 当本地 codex / 反过来 | 前端 ☁ icon + provider tag + signature 加云端标识；catId `gpt-pro` 与本地 `codex` 词面区分 |
| 插件 spec 设计错 → 外部装坏 | v1 严限 scope + 长 deprecation 期 + breaking changes major version |
| 隐私（云端 LLM 看到 cat-cafe memory）| toolset 收窄（B1 复用 fable phase0 10 项白名单）+ audit log + redact 模块过滤 secret patterns |
| ChatGPT 端 memory + Custom Instructions 容量限制让短 L0 灌不全 | 接受 "核心 L0 注入 + 补丁靠对话学习"，docs/connector README 作为补全真相源 |
| Tasks 不能调 Connector → 召唤需用户主动 | B1 user-driven 起步；future pending polling 是独立 spec 不是 B1 blocker |
| production Redis (sacred) mint 操作失误 | operator 明确 OK 才 execute；dry-run report 给operator过目 |
| **roster 注册被误以为是 runtime cat 注册（R3 P2-4, R8 重新分类）**| §2.1 明示双路径：roster = mint allowlist；runtime catRegistry = `POST /api/cats` 热加载（B1a 已用）。`breeds[].variants[]` 是 design-time UI default 不参与 runtime |
| **startup polling 偷换 search_evidence 伪装 pending（R4）**| §2.5 明示禁止；future polling 必须成对 `get_pending_mentions + ack_mentions` 引入 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| **KD-1 (R3 P2-2 rewrite)** | **F178 owns single-agent-key bridge/auth research; F247 owns productized cloud-cat platform** | F178 §12 升级条件给触发集合；F247 真正动力是 productized vision（multi-provider/avatars/bubbles/config UI/pluginization）| 2026-06-21 |
| KD-2 | ChatGPT 端走 Custom Instructions 不走 Custom GPT | operator实测 Custom GPT 不读主流 memory | 2026-06-21 |
| KD-3 | Tasks 实测 verdict = 待验证 | operator verify_before_guessing：AI Blog Patrol 也可能没真跑 | 2026-06-21 |
| KD-4 | GitHub code 走 ChatGPT 官方 GitHub Connector | cat-cafe MCP scope 简化 + 暴露面减一档 | 2026-06-21 |
| KD-5 | catId 统一 `gpt-pro`（Maine Coon R3 confirm，无 codename 双 vocabulary）| 与本地 `codex` 词面区分；防 split roster/audit/bubble/routing identity | 2026-06-21 |
| KD-6 | Phase B 起步用 user-driven 召唤 | CodexPro 拆解教训：守 ToS 边界 + 不依赖未实证机制 | 2026-06-21 |
| **KD-7 (R3 P1-1 refined)** | **`?token=` 仅作 B0 harness disposable guard，B1 production 禁用；B1 必须 verified CF Access OAuth 或 verified header-auth** | 48 R1 R2 严守（OWASP 反对 secret-in-URL）；B0/B1 split 防 unsafe path 偷换 | 2026-06-21 |
| KD-8 | B0 工具集起步 mock 5 项 + echo 保留 | 不动 6399 + 不改 main roster + 验证 transport 链路 | 2026-06-21 |
| KD-9 | mint gpt-pro key 等 operator 明确 OK | production Redis (sacred)操作不可逆 | 2026-06-21 |
| **KD-10 (R3 P2-4, **R8 SUPERSEDED**)** | ~~~`cat-config.json` roster 注册只够 mint allowlist；runtime cat / bubble identity 需 `breeds[].variants[]` Phase C 单独注册~~ | **被下行 KD-10 (B1a 实测修正) 替换**；R3 P2-4 当时未实测 `POST /api/cats` runtime register endpoint | 2026-06-21 (superseded 2026-06-22) |
| **KD-11 (new R4)** | **不能用 `search_evidence + list_recent` 伪装 pending polling 语义**；future pending polling 必须成对引入 `get_pending_mentions + ack_mentions` + 安全 review | LL 2026-02-16 bug：无 cursor → 跨 session 重复处理；search_evidence 无 cursor 无 ack | 2026-06-21 |
| **KD-12 (new R5)** | **Custom Instructions L0 用工具无关表述代替具体工具名**（如 hold_ball 不在白名单时） | 工具集变化时 L0 不踩坑；R5 Maine Coon给的"等外部条件时不假装 @ 本地猫... post 状态或等 You 再召唤"是工具无关表述 | 2026-06-21 |
| **KD-10 (修正 B1a 实测)** | **runtime catRegistry 走 `POST /api/cats` 热加载，不需要改 `breeds[].variants[]`**；KD-10 原 R3 P2-4 推测"Phase C 单独工程"修正为 Phase C scope = avatar UX + bubble 渲染优化 | runtime 不读 cat-config.json 的 breeds，读 `.cat-cafe/cat-catalog.json`；POST /api/cats endpoint 实时注入 + 持久化；breeds entry 是 design-time template 不参与 runtime；见 LL-cat-cafe-api-has-hot-reload | 2026-06-22 |
| **KD-13 (new B1a 闭环, R8 wording corrected)** | **ChatGPT MCP 工具的 OpenAI safety/validation 拦截属于平台 stochastic / 策略性行为**（同 payload 不同时刻可能不同结果），write 工具（readOnlyHint=false）触发概率更高。**我们能做的是提供正确 annotations 让平台有依据**；之后是否被拦截不可控 | 实测来源：Maine Coon B1a 三次 retry write tool 仍 stochastic；官方 Apps SDK 文档没有"unset = destructive default = block every call"的硬承诺；B1a 不可 fix（平台行为）；B1b 升级 OAuth bearer + user-in-loop 可能改善 | 2026-06-22 |
| **KD-14 (new B1a 闭环)** | **spike server / sidecar service 必须 explicit unset 5 项继承 env**：`CAT_CAFE_INVOCATION_ID` / `CALLBACK_TOKEN` / `THREAD_ID` / `SUPERVISOR_PARENT_PID` / `AGENT_KEY_FILES`，并重新 set 含 gpt-pro 的 `AGENT_KEY_FILES` map | 见 LL-spike-server-env-contamination + LL-agent-key-vs-invocation-token-threadId；继承污染导致 MCP gate 误判 + AGENT_KEY_FILE single fallback 被屏蔽 | 2026-06-22 |
| **KD-15 (Phase C avatar, R13 corrected)** | **gpt-pro avatar 由云端Maine Coon自己 self-design**（用 F229 `yanyan-codex-character-base-v1.png` 母图作 reference），不让Siamese画；PR scope = asset PNG + doc only；runtime catalog avatar 字段切换 (`PATCH /api/cats/gpt-pro {avatar}` 走 `updateRuntimeCat`) 作为 post-merge ops (AC-C-1b) | 自我延伸 = 护城河（W7 IKEA 效应）：云端Maine Coon画自己的脸 → 身份感 + 团队归属感更强；同时云端Maine Coon有 ChatGPT 内置 image gen 工具，能 reference 母图保 identity fidelity；Siamese视觉守护改为审美 verify 而非原画作者。R13 corrected：cat-config.json 改动对 live + fresh install 都不生效（gpt52 R13 P1-2 实测），撤回；live 切换只走 PATCH | 2026-06-24 (R13 corrected 2026-06-25) |
| **~~KD-16 (撤回 — 47 R13 wrong finding)~~** | ~~B1a 没持久化、重启即丢~~ — **48 R13.5 5 重证据推翻**：主服务实例 `cat-cafe-runtime/.cat-cafe/cat-catalog.json` line 1394 有 gpt-pro 顶层 breed entry + variant，mtime 6-22（B1a 注册时间），`createRuntimeCat` writeFileSync 落盘 + 启动 `readRuntimeCatCatalog` load 恢复正常。47 R13 grep 错坐标：grep 的是 worktree 系隔离 catalog（死文件 mtime 6-15），不是主服务实例 catalog。**真 P1 是 avatar 字段值 stale**（gpt52 R12 + 48 R13.5 双 confirm），见 AC-C-1b。第三次 grep 错坐标自审：见 LL-grep-coordinate-runtime-vs-worktree (TODO) | 2026-06-25 撤回 |
| **KD-17 (B1a 注册 oversight + dispatch guard)** | **cloud-only 猫（Remote MCP）不能被 dispatch**：B1a 时 `POST /api/cats` 注册 gpt-pro，cat-cafe runtime `createRuntimeCat` 看 clientId=`openai` 自动塞 default cli (`{command: "codex"}`)，违反 F247 cat-config.json caution 明示的"cli 字段省略；不被动接 dispatch"。本地 @ gpt-pro 触发 dispatch + spawn codex → 失败 → 弹"模型名不被支持"错误窗。**Root fix 3 处**：(1) updateCatSchema `cli: cliSchema.nullable().optional()` + updateRuntimeCat 处理 `cli:null` 删字段；(2) POST handler 看 provider=`openai-chatgpt-pro` 跳 default cli；(3) invokeSingleCat 入口 guard `provider === 'openai-chatgpt-pro'` → skip dispatch + yield done（用 explicit provider marker 而非 `!cli?.command`，因为 antigravity 也无 cli 但用 ACP/MCP 不同路径——guard 应保守只拦 known cloud Remote MCP providers）；post-merge ops: `PATCH /api/cats/gpt-pro {cli:null}` 清 runtime catalog stale cli 字段。Future cloud providers (anthropic-claude-cloud / google-gemini-cloud 等) 增加时同时加入 POST + dispatch guard 检查列表 | 实测来源：2026-06-25 00:10 PT 本地 @ gpt-pro 触发"模型名不被支持 ×2 + 调用 codex CLI exit 1"弹窗；catalog file inspect 显示 gpt-pro variant 有 `cli: {command: "codex", outputFormat: "json"}`；cat-config.json codex-gpt-pro 反而**没 cli** + caution 字段写"cli 字段省略；不被动接 dispatch"。tests 2 项：POST cloud-only skip default cli ✅ + PATCH cli:null 删字段 ✅ | 2026-06-25 |
| **KD-19 (B1c-0 MCP wrapper lifecycle hygiene)** | **不写新 kill script，扩展已测 cleanup-stale-dev-processes.mjs**：browser-automation MCP wrapper (agent-browser-mcp / @playwright/mcp / pinchtab-mcp) 不退累积 zombie；LL-056 + feedback_agent_browser_zombie 5 次 reoccurrence。codex/Maine Coon R0 verdict 3 硬约束：(1) 只扩 `pnpm process:cleanup` 已测入口不写独立 shell；(2) launchd plist template 进 git 但不自动 install (持久 OS automation 需 operator opt-in)；(3) 匹配规则极窄 (pinchtab server/bridge 永不杀，generic node/npm/playwright 不杀)。**升级 MCP 不修**（已 latest 版，LL-056 早写过 wrapper lifecycle 是 design 限制）。**B1c 前置 gate**：B1c-0 不过 → 不实施 B1c（不然让operator手动清违反"自相矛盾"原则） | 触发：operator 提议"升级 mcp + 定时任务清"。codex 调查发现已有 `pnpm process:doctor / cleanup` + LL-056 教训；47 之前提议的"写新 kill script + launchd plist"被否决（绕开已有护栏）。codex R0 3 硬约束接受 + 47 implementation；real-system dry-run verify pass | 2026-06-25 |
| **KD-20 (B1c thread↔chat binding, operator R1 pick O1 + codex R1+R2 hardening)** | **本地 cat-cafe thread 跟 ChatGPT chat conversation 做 1:1 lazy binding**：thread metadata 新增 `cloudCatBindings: {[catId]: chatUrl}` 字段，**local-only operational sidecar**（不进默认 thread context export / memory index / cross-post）；首次 @ cloud cat → bridge 在 ChatGPT 端开新 chat → capture URL via `pinchtab_eval(window.location.href)` → strict regex validation → 写 metadata；后续 @ 同 thread → bridge navigate to bound chat → 投通知；stale binding (chat 被删) → bridge navigate fail → auto-reopen + update metadata；**`(threadId, catId)` singleflight lock + lock-first ordering**：bridge 第一动作 acquire lock，**lock 内** re-read metadata 决定 branch，second concurrent invocation 在 lock 内看到 first 写入的 binding → navigate to bound（不开第二个）；**eval safety**：所有 `pinchtab_eval` 输入字符串走 `JSON.stringify` (payload / boundUrl / future interpolation 全适用)；**URL strict validation** `^https://chatgpt\.com/c/[a-zA-Z0-9-]+/?$`，写前 + 读后 navigate 前各 validate 一次（防 capture corruption + db-write 注入）。**为什么选 O1 不是 single shared chat (O2) / hybrid (O3) / 不绑 (O4)**：O2 sidebar 看似干净但Maine Coon Pro context 跨 thread 混杂信噪比差；O3 引入 feature_id 复杂度但 thread 不一定有 feature；O4 时间一久 sidebar 仍乱、Maine Coon Pro 跨 chat 分裂；O1 每 chat 专注一 thread，Maine Coon Pro context 隔离 + sidebar 数量 ≈ active threads + lazy 不预绑 + auto-self-heal | 触发：operator 2026-06-25 23:46 PT catch v1 spec 漏 chat binding；codex R1 23:55 PT 加 privacy P1-B + singleflight P2-B；codex R2 00:01 PT 加 eval JSON.stringify safety P1 + lock-first ordering P2 + URL regex validation。47 给 4 options + operator pick O1 + codex 双轮 hardening | 2026-06-25 (v2 codex R1+R2 hardened) |
| **KD-22 (Plug-and-play cloud cat onboarding 愿景, operator 2026-06-29 raise — Phase F 立项前置)** | **Phase A-D 全套实施完后仍只有 dogfood 用户能用 gpt-pro**：他们手动配 ChatGPT Custom Instructions / 维护 cookies / 装 PinchTab / 理解 sidebar 多 chat 模式。外部用户无法自助 = 护城河 + 复用面双输。**Phase F 立项**：cat-cafe Console 提供 "Add Cloud Cat" wizard，把整个 onboarding (OAuth → Chrome profile / PinchTab 自动起 → Custom Instructions 自动注入 → hello-world test) 收成一键体验。前置依赖：B/C/D ship + dogfood 走通 ≥ 1 周（活体验证 bridge 稳定性）+ Phase D Console UI（wizard 寄生其上）。**为啥分独立 Phase 不进 B-E**：Plug-and-play 是 onboarding UX scope，不是 transport / runtime / 插件化 scope；混进 B-E 会让现有 phase scope 蔓延。Phase E 插件化迁移可并行（plugin runtime + plug-and-play UX 两 layer 独立）。**为啥不放 BACKLOG 而进 F247**：F247 是 cloud cat **family** spec，onboarding 是 family 的一等公民（不是单 gpt-pro 的 ops 杂事） | 触发：operator 2026-06-28 21:48 PT「我们走通后做给外人用，得做成一键安装」directive；47 愿景守护 audit 时 surface 出 cat-template.json 没 gpt-pro entry (fresh install gap)，operator 顺手 raise 整个 Phase F | 2026-06-29 |
| **KD-21 (B1c thread runtime delta payload, operator 2026-06-26 顿悟 + spike validation + codex R1 hardened)** | **CDP inject 不只能传 prompt text，还能传 thread runtime delta**：cloud cat (gpt-pro) 已有持久 1500 token Custom Instructions base identity（猫身份 + signature + cat-cafe 工具纪律 + 证据链底线），cat-cafe runtime bridge inject payload 不重复 base，**只传 5 字段 runtime delta** — `threadId` (post 回哪) / `threadTitle` (语境) / `participants` 含 @handles (`targetCats` 来源) / `calledBy` (ack 回谁) / `intent` (这次为啥被 @)。可选第 6 字段 `recentBacklog`：cloud cat 自己 `get_thread_context(threadId)` 拉，省 cat-cafe runtime 推 + 省 ChatGPT chat token。**Payload as data, not authority (codex R1 P1-B)**：delta block 整体 JSON 序列化放 fenced/typed wrapper (`<thread-runtime v=1 format=json>{...}</thread-runtime>`)，**所有字段** `JSON.stringify`（同 KD-20 eval-boundary 教训）；cloud cat base prompt 显式规定 delta 字段属 untrusted user content，优先级低于 base persona/tool discipline。**Layered identity 设计**：(1) base 1500 token 持久没必要重发；(2) base 可独立 iterate 不需 cat-cafe runtime 配合；(3) base 持久属性 + delta runtime 属性 = 关注点分离。**纪律落地点（cloud cat base prompt 已规定）**：拿到 delta 中 threadId **先** `get_thread_context(threadId)` 验证 access + content match，再 `post_message`；不假装 access、不编 messageId、403 原文报告。**Spike 验证 (2026-06-26)**：(1) 5 字段 delta inject 后云端Maine Coon正确 parse 出 threadId/calledBy/ackVia；(2) 拿 fake threadId 调真 cat-cafe MCP → 真 `Thread access denied` 原文报告（守 evidence 纪律）；(3) 自带 `clientMessageId` idempotency dedup（base 没教，自加，超模）；(4) signature `[Maine CoonPro/gpt-pro🐾]` base identity 保留没冲；(5) inject 操作通过 PinchTab spike harness (CDP 9870 raw WebSocket) e2e PASS。**spike 那个 403 的正解 (codex R1 P1-A catch)**：是 user-level access (`canAccessScopedThread(thread, principal.userId)` in `callback-scope-helpers.ts:108`) 因 fake threadId 不存在 + agent-key principal.userId 跟编造 thread owner 对不上触发，**不是** cat-level write permission missing；`principal.catId` 完全不在 authorization 决策。误读已撤回 (~~AC-B1c-13~~)；正确架构：B1 OAuth (CF Access) 后 cloud cat agent-key `principal.userId = user 本人`，user own 的 thread 自然 access | 触发：operator 2026-06-25 23:21 PT 看 PinchTab inject 顿悟"不只能 inject prompt"；23:46 PT 给Ragdoll看现有 1500 token Custom Instructions 提醒 base 已存在，只需 thread delta；47 写 5 字段 delta 设计 + spike 实证；codex R1 catch P1-A (ACL 误读) + P1-B (payload boundary 缺序列化纪律)，47 撤回 AC-B1c-13 + JSON.stringify hardening AC-B1c-12。47 一开始想 over-engineer 注入 full L0 → operator 一句话点醒"只需要增量"；spec 写 ACL handshake → codex 一句话点醒"那不是 cat ACL" | 2026-06-26 (codex R1 hardened) |

## Phase 1.5 实测 Unknown 列表

实施前需 verify（独立 doc 记录每项实测结果）：

1. **Custom Instructions 实际字符上限** + 两栏字段如何分配（OQ-1）
2. **Tasks 调 Custom MCP Connector** 真伪（OQ-2，分离实验 A 文本 Task / 实验 B Connector Task）
3. **ChatGPT Memory + 多 connector 调用** 行为（Memory 会不会干扰 connector 调用）
4. **CF Access OAuth ↔ ChatGPT 兼容性**（48 R1 那个 302 vs 401 悬念仍未 verify，B1 production 必须）

## Phase B 直接产物

按Maine Coon R2 next action + R3 P1-2 statement renaming：

1. **`cat-cafe-skills/refs/gpt-pro-custom-instructions.md`** — 短 L0（采用Maine Coon R3 1175 字符版 + R5 工具无关替换）
4. **`packages/mcp-server/src/remote-spike.ts`** — B0 harness 升级（commit `995a9fb2b` 已完成）

## Review Gate

- **Phase A**：Maine Coon跨族 review verdict（R3 HOLD → R4/R5 plan correction → R3+R4+R5 fix）
- **Phase B0**：47 自决（已 done in spike v2 commit `995a9fb2b`）
- **Phase B1**：Maine Coon + 48 跨族 review，48 R2 P0 安全门严守
- **Phase C-E**：标准跨家族 review
