---
feature_ids: [F212]
related_features: [F153, F118, F173]
topics: [cli, error-handling, diagnostics, sanitizer, frontend, observability]
doc_kind: spec
created: 2026-05-25
---

# F212: CLI Error Diagnostics — 结构化 CLI 错误诊断 + 受控前端展示

> **Status**: done | **Phase A-C done**: 2026-05-27 | **Phase D done**: 2026-05-29 (PR #1950 merged 40af2b82e) | **Phase G done**: 2026-06-09 (PR #2150 merged a22164f58) | **Owner**: Ragdoll/Ragdoll (Opus-47) | **Priority**: P1

## Why

社区小伙伴遇到 `codex exec` 退出，前端只显示 `Error: Codex CLI: CLI 异常退出 (code: 1, signal: none)`——**没有任何定位信息**。GLM-5 顺着代码 + 注释**编造**了一套 "invalid transport" 因果链，我在本地实测复现失败（codex-cli 0.133.0 不报错），这次"自信但错"的报告恰恰最危险。

operator experience（2026-05-25 19:14）：
> 我们这里前端显示的不完整？这样让operator很迷惑，我们能不能打印完整的报错啊 而不是那一行 codex cli 退出了

### 当前代码事实

`packages/api/src/utils/cli-spawn.ts` L518-533：
- stderr 被**完全屏蔽**不传前端（注释自我标榜 "may contain thinking/traces"）
- `classifyKnownCliStderr` 白名单只覆盖 2 类（`invalid_thinking_signature` / `missing_rollout`）
- L520-522 stderr 仍**无脑** `log.error` 到服务日志（Maine Coon 2026-02-08 P3-1 建议的 `LOG_CLI_STDERR=1` env gate 没落地）

### 威胁模型重审

注释假设 "stderr may contain thinking/traces" **站不住**：
- ✅ thinking / chain-of-thought 走 NDJSON stdout stream，不走 stderr
- ⚠️ stderr 实际承载：config 解析错误 / auth / quota / network / spawn error / model_not_found / panic 堆栈
- ⚠️ 真威胁是 **path + token 残留 + panic stack 内部 module path**，全部可分类化处理

**当前设计代价**：operator 自己 + 全部社区用户失明 100%；真威胁也没堵住（panic 仍带堆栈）。

### 历史教训（2026-02-08 Maine Coon review）

Maine Coon当时挡掉过同样的 `stderrTail` 直传方案：
> `stderrTail = stderrBuffer.trim().slice(-500)` 再 `yield { __cliError, stderr: stderrTail }`，本质上就是把高敏感的 trace/堆栈/路径/潜在 token 片段"喂给用户"；而且"最后 500 字"恰好是堆栈尾部/报错摘要最密集的区域，风险更高。

这次本 feat 走 **structured `cliDiagnostics` + `safeExcerpt` 只来自 classifier 白名单抽取**，不再走"sanitize 后 raw tail 直传"老路。

## What

### Architecture cell

- Backend cell: `agents/cli-supervisor`（cli-spawn 错误通道）
- Frontend cell: `frontend/chat-message-bubble`（错误展示面板）
- Map delta: **none**（扩展现有 payload 边界 + 新增折叠面板组件，不改 ownership map）

### Phase A: Backend cliDiagnostics + Sanitizer + Classifier 扩白名单

**核心设计转换**：把"什么算可暴露"从**黑名单兜底**改为**白名单准入**。

1. **structured `cliDiagnostics` payload**（替代当前 `__cliError.message` 字符串）：
   ```ts
   interface CliDiagnostics {
     reasonCode: CliErrorReasonCode;          // 已知错误类别（白名单）
     publicSummary: string;                   // i18n 标题（"API 认证失败" 等）
     publicHint: string;                      // 后端生成的人话提示（"检查 .env 中的 API key"）
     safeExcerpt?: string;                    // 仅当 classifier 抽取到安全片段时填，unknown 不填
     debugRef: {
       command: string;
       exitCode: number | null;
       signal: string | null;
       invocationId: string;
     };
   }
   ```

2. **Sanitizer util**（`packages/api/src/utils/sanitize-cli-stderr.ts`），处理顺序**先 sanitize 再截断**（避免从 token 中间截尾绕过黑名单）：
   - ANSI / OSC 控制序列清理（`\x1b\[[...]`、`\x1b\]...\x07`）
   - NFKC normalize（防 unicode homograph bypass）
   - Path redaction：`$HOME` / project root / `/tmp/*` / Windows `C:\Users\...` → `~/...`
   - JWT pattern：`eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` → `[JWT_REDACTED]`
   - PEM block：`-----BEGIN .* PRIVATE KEY-----[\s\S]*?-----END .*-----` → `[PEM_REDACTED]`
   - URL query 全量 redact（或敏感键白名单：`key/token/secret/auth/cookie/session/callbackToken`）
   - Cookie / `Set-Cookie` header redact
   - Token patterns（按 provider）：
     - OpenAI / Anthropic：`sk-[A-Za-z0-9_-]{20,}`
     - GitHub：`gh[pousr]_[A-Za-z0-9]{36,}` / `github_pat_[A-Za-z0-9_]{82,}`
     - npm：`npm_[A-Za-z0-9]{36,}`
     - Gemini / Google：`AIza[0-9A-Za-z_-]{35}`
     - 通用 Bearer：`Bearer\s+[A-Za-z0-9_.\-+/=]+`
     - 通用 `(token|api[_-]?key|secret|password)["':=\s]+[^\s,}"]+`
   - Generic high-entropy secret（≥32 字符 + base64/hex pattern + 高熵）
   - 复用 / 对齐 F153 `TelemetryRedactor` Class A（凭证类）正则集合

3. **`classifyKnownCliStderr` 扩白名单**（覆盖 stderr + stream errors）：
   - `model_not_found`（`model.*not found` / `Unknown model`）
   - `auth_failed`（`401` / `Unauthorized` / `invalid api key`）
   - `quota_exceeded`（`429` / `quota` / `rate limit`）
   - `network_error`（`ETIMEDOUT` / `ECONNREFUSED` / `ENOTFOUND`）
   - `invalid_config`（`Error loading config\.toml` / `invalid transport`）
   - `spawn_failed`（`ENOENT` / `EACCES` 当 child 起不来）
   - `context_window_exceeded`（`context length` / `maximum context`）
   - 保留旧分类：`invalid_thinking_signature` / `missing_rollout`

4. **`safeExcerpt` 抽取规则**：
   - 仅当 `reasonCode !== undefined` 时填充
   - 从匹配 classifier regex 的位置抽取 5-8 行或 ≤1500 chars，**先 sanitize 再截**
   - panic stack 类**只保留 panic headline / error headline**，frame / 绝对路径 / cargo / node module path 全部隐藏
   - unknown stderr 不填 `safeExcerpt`，只填 `publicSummary='未识别的 CLI 错误'` + 提示"详细信息见后端日志"

5. **`LOG_CLI_STDERR` env gate**（兑现Maine Coon 2026-02-08 P3-1）：
   - 默认 `false`，stderr 不写服务日志
   - `LOG_CLI_STDERR=1` 显式启用，开发环境调试用
   - 写日志时仍走 sanitizer（防止内部记录泄露）

6. **Stream errors 覆盖**：Codex 的真实错误语义经常在 NDJSON stream `error` event 里，不在 stderr。classifier 也要扫描已 parse 的 stream error events，统一走 `cliDiagnostics` 通道。

### Phase B: Frontend 折叠面板透传

1. **Extra payload 透传链**：
   - `AgentMessage.extra` 加 `cliDiagnostics` 字段类型
   - `ChatMessage.extra` 同步
   - `bubble-event-adapter` 透传
   - reducer 不丢字段

2. **折叠面板组件**（参考 `TimeoutDiagnosticsPanel` 范式）：
   - 默认折叠（"查看详细错误"按钮）
   - 摘要 + hint 直接显示（小红条上方）
   - `safeExcerpt` 必须点开才显示（隐式 opt-in）
   - 按 `reasonCode` 选样式 / icon（**KD-4 自画 SVG，禁用 emoji**；KD-5 颜色按 4 档 severity 分组：user-fix→red / transient→amber / system→slate / cognitive→violet）

3. **i18n humanized hint 后端生成**：前端只渲染，不在 UI 层猜 regex（避免"两边都跑 regex"漂移）。

### Phase C: Alpha smoke + Close

1. 故意触发 codex / claude / gemini / antigravity 各类已知错误（auth / quota / model / network / invalid_config / spawn），看前端展示是否正确
2. 喂 fuzz stderr（含 token / path / panic / JWT / PEM）确认 sanitizer 不漏
3. CloseGateReport + 跨族愿景守护猫（非作者非 reviewer）
4. Merge

### Phase D: result-error 诊断完整性 follow-up（2026-05-28 organic 验证发现）

**触发**：operator organic 验证（claude-opus-4-8 实跑）发现——CC 已在 stream 最后吐明确原因 `The model's tool call could not be parsed (retry also failed)`，但 cliDiagnostics 标"未识别的 CLI 错误"，给社区"猫咖 bug"错觉（实为 CC/model 报错）。

**根因（两层）**：
1. Phase A AC-A8 声称"Classifier 同时扫 stderr + NDJSON stream error events"，但 `maybeCollectStreamError` (cli-spawn.ts:47) 只收 `type==='error'` event，**漏了 Claude CLI 的 result event**。result 被 `isResultErrorEvent` (claude-ndjson-parser.ts:250) yield 到消息气泡但未进 cliDiagnostics 的 rawText → classifyCliError 无输入 → unknown → "未识别"。
2. **更隐蔽的一层（2026-05-29 runtime archive 取证修正）**：CC 报告 tool-call-parse 失败的 result event 形状**反直觉**——7 个真实 opus-4.8 样本（bb299eb0 / 0d2d46b1 / 86089948 / 8f1ca53d / e305c0dd / 8ae51dfb / 720444c5）一致为：
   ```json
   {"type":"result","subtype":"success","is_error":true,"result":"The model's tool call could not be parsed (retry also failed).","errors":null,"stop_reason":"stop_sequence","num_turns":3~32}
   ```
   **错误标志是 `is_error:true`，subtype 仍是 `success`(!)，cause 文本在 `result`（errors[] 为 null）**。所以早期设想的 `subtype!=='success'` 判断对真实数据**必然 false（漏收）**——这是差点 ship 的假绿（fixture 用想象的 `subtype:error` 结构会通过，但 production 漏）。正确判断必须基于 `is_error===true`，从 `result` 提取。

**与 F215 边界（协同非重叠）**：opus-4.8 malformed tool call 有两种 stream 结尾形态：
- **A1（静默假成功）** `{subtype:success, is_error:false, result:""}`（无错误信号，d137d9eb 样本）→ **F215** 用 `textEventCount===0` 检测 + seal/fresh/46 接力兜底
- **A2（CC 报错）** `{subtype:success, is_error:true, result:"...could not be parsed..."}`（有独立错误信号）→ **F212 Phase D** 正确归因显示
（顺带修正 F215 KD-6 表述："could not be parsed" 在 stream **确有**独立信号 = A2 的 is_error:true result event；F215 取证按字符串搜未按 is_error 过滤，真信号被猫讨论 F215 的 result 输出噪音淹没。已 cross-post 反馈 F215 thread。）

**修复**：
1. **补 result error 收集**：`maybeCollectStreamError` (cli-spawn.ts) + tmux-spawner rawText 加收 result event，判断 **`is_error===true`**（兼容保留 `subtype!=='success'`），从 `result` 提取 cause 文本
2. **扩 reasonCode**：加 `tool_call_parse_failed`（"tool call could not be parsed"）
3. **unknown fallback 措辞**：CC structured result error 安全显示 `Claude Code 报告：<原因>`，区分 CC/模型报错 vs 猫咖未分类

### Phase F: Empty-stderr observability follow-up（2026-05-30 organic 验证发现）

**触发**：社区小伙伴贴截图——Windows `codex.cmd` exit 1 + stderr empty + 配了 `LOG_CLI_STDERR=1`/`debug`/`err=1` 都没用 → cliDiagnostics 让用户去看后端日志但**日志里啥也没有** = 死胡同 UX。Maine Coon（@codex，F212 历史 reviewer）跨 thread 投诉 + 5 AC refined plan，operator directive：F212 status 不动，feat doc 加 Phase F section + worktree implement。

**根因（三层 verified in main `eddadf97c`）**：
1. `cli-spawn.ts:647-653` `formatCliStderrForLog(stderrBuffer)` empty returns null → `if (stderrForLog)` gate → abnormal exit + stderr empty = **静默无后端 log**。`LOG_CLI_STDERR` env gate 和 "是否写诊断 log" 这两个 scope 被错误合并。
2. `cli-spawn.ts:649-652` log payload `{ command, stderr, reasonCode }` — **缺 `invocationId`**。用户拿前端截图里的 invocationId 搜后端 log 搜不到。
3. `cli-diagnostics.ts:97` `UNKNOWN_TEXT.hint = '详细诊断信息见后端日志（启用：环境变量 LOG_CLI_STDERR=1）。'` — empty-stderr case 这是骗人的死胡同（**hint 暗示设了 env 就有更多信息，但 stderr empty 时根本没东西可显**）。

**与 F212 愿景的关系**：F212 Why 段原话 "operator 自己 + 全部社区用户失明 100%；真威胁也没堵住"——Phase A-D 修了大部分 case，但 **`exit 1 + empty stderr` 这个 case 仍 100% 失明**。Maine Coon定性："F212 done scope 漏验 case，不是新 feature"。Phase F = 在 F212 内闭环这个漏 case，status 仍 done（同 Phase E pattern）。

**修复（按Maine Coon refined plan + 2 个执行提醒）**：
1. **结构化 exit diagnostic log 独立于 stderr gate**（F1）：`cli-spawn.ts` abnormal exit 分支无条件打一条 `'CLI abnormal exit'` log，字段：`invocationId / command / exitCode / signal / reasonCode / stderrEmpty (boolean) / streamErrorCount`。**cwd 字段不收录**（R1 Maine Coon P1-2 + cloud codex R1 P2 双源 catch: `sanitizeCliStderr` 只覆盖 HOME/userprofile/`C:\Users`/`/tmp`，非 HOME server installs `/srv` / `/workspace` / `/var/lib` / `D:\work` 会原样 leak — 安全 > 诊断 redundancy with `command`+`invocationId`）。`LOG_CLI_STDERR=1` env gate 仍**只控** raw/sanitized stderr 字段的内容（含/不含），**不控**这条 diagnostic log 是否写——scope 边界严格收窄（避免之前 gate 混淆 bug 复发）。
2. **invocationId 进 stderr log**（F3）：`'CLI stderr (LOG_CLI_STDERR=1)'` log payload 加 `invocationId` 字段 + 回归测试断言（防再丢）。
3. **publicHint empty-stderr 诚实文案**（F4，Maine Coon给的中文文案）：classifier unknown + stderr empty 时给 "CLI 已退出但没有输出 stderr。请在后端日志中用 debugRef.invocationId 搜索；如仍无结果，请直接运行该 CLI 并分别捕获 stdout/stderr。" **不暗示** `LOG_CLI_STDERR=1` 一定有更多信息（避免再制造死胡同）。
4. **publicHint 不暴露 absolute log path**（F5，Maine Coon安全 push back）：classifier unknown + stderr 非 empty 时给 "查路径的方法"——hint 提示用户去 `/api/config/env-summary` 看 `paths.dataDirs.runtimeLogs` 再用 invocationId 搜，**不在 payload 里塞 absolute path**（保 F212 之前的安全边界：no raw path / no path leak）。

**与 F215 / F210 边界**：F215 是 malformed tool-call 检测 + 接力兜底（模型行为），F210 是 Antigravity migration（runtime 切换），都与 F212 平行。Phase F 只动 `cli-spawn.ts` + `cli-diagnostics.ts` + 对应 web 文案，不碰 F215 / F210 路径。

### Phase G: Silent-stdout observability follow-up（2026-06-08 Maine Coon cross-thread packet 自 clowder-ai#875）

**触发**：社区 issue clowder-ai#875 — OpenCode + DeepSeek 用户撞到 silent-stdout case：fresh OpenCode CLI 直接 reproduce — NDJSON stream 只有 1 个 `{"type":"step_start"}` event，无 text，无 explicit error。新 API key/新猫 rebind 不解决。当前 Cat Cafe surface 给用户 generic `"{catName} completed without textual output."`（route-serial:2165 + route-parallel:1193），**所有诊断证据丢失**：event count、event 类型、model/provider、session id prefix、exit status、stderr presence 都拿不到。Maine Coon跨 thread 投递完整 packet + verify scope。

**根因（verified in main `92433bcc0`）**：
1. `OpenCodeAgentService.ts:322` — `textEventCount === 0` 只 backend `log.warn`，**不 yield 任何 cliDiagnostics surface** 给前端
2. `ClaudeAgentService.ts:721` — sibling same pattern，同病同治
3. `route-serial.ts:2165` + `route-parallel.ts:1193` — fallback collapse 到 generic message，丢失所有诊断证据
4. F212 当前 scope 只覆盖 stderr-error 路径（Phase A-D + E + F），**silent-stdout 路径完全 lossy**

**Scope（不动 OpenCode/DeepSeek upstream，只动 Cat Cafe diagnostics surface）**：
1. 触发条件: `eventCount > 0 && textEventCount === 0`
2. Track + surface safe fields:
   - `eventCount` (total events received)
   - `eventTypes` (unique set seen, e.g. `['step_start']`)
   - `model` / provider name
   - `sessionId` prefix (前 8 char only, 不暴露 full session id)
   - exit status (如有)
   - stderr presence (boolean) + safe excerpt if available (走现有 sanitizer)
3. 安全边界（保持 F212 安全约束）: no provider secrets, no full session id, no prompt/body content, no absolute paths
4. Frontend: 既有 `CliDiagnosticsPanel` 自动 render 新 reasonCode `silent_completion`，不需新组件

**Sibling sweep 覆盖（LL-069 应用）**：
- ✅ `OpenCodeAgentService.ts:322`（primary anchor from packet）
- ✅ `ClaudeAgentService.ts:721`（sibling same pattern）
- ✅ Codex / Antigravity / Gemini / Dare / CatAgent grep 确认无 `textEventCount === 0` 同 pattern（不同 event tracking model，不在 Phase G scope）

**修复（与 Phase F/E 同 surface 机制）**：
1. **扩 reasonCode**：加 `silent_completion`（"CLI 完成但无文字输出 — 通常是 step_start-only event stream，常见于 OpenCode/DeepSeek upstream issue"）
2. **新 helper `buildSilentCompletionDiagnostic`**（`cli-diagnostics.ts`）：输入 `{eventCount, eventTypes, model, sessionIdPrefix, exitStatus, stderrPresent, stderrExcerpt?}`，返回 structured `CliDiagnostics`
3. **OpenCode + Claude no-text branch**: track `Set<string>` of unique event types during stream，textEventCount===0 时 build diagnostic + yield `type: 'system_info'` event with `metadata.cliDiagnostics`（observability-only，不走 provider error path；cloud R1 P1 修正）
4. **REASON_TEXT entry**: publicSummary `"CLI 完成但无文字输出"`, publicHint 解释 step_start-only pattern + 建议（换猫 / 换 model / 直接跑 CLI 看 raw output）

## Acceptance Criteria

### Phase A（Backend cliDiagnostics + Sanitizer）— ✅ merged PR #1907 (2026-05-27)

- [x] AC-A1: `cli-spawn.ts` `__cliError` payload 改为 `cliDiagnostics` structured 对象（含 reasonCode / publicSummary / publicHint / safeExcerpt? / debugRef）
- [x] AC-A2: `sanitize-cli-stderr.ts` util 实现 + fuzz 单测覆盖（ANSI / NFKC / path / JWT / PEM / URL query / cookie / 5 类 provider token / generic high-entropy）
- [x] AC-A3: Sanitizer 处理顺序 **先 sanitize 再截断**，单测验证"token 中间截尾"无法绕过
- [x] AC-A4: `classifyCliError` 扩到 9 类（含 model_not_found / auth_failed / quota_exceeded / network_error / invalid_config / spawn_failed / context_window_exceeded + 保留旧 2 类）
- [x] AC-A5: `safeExcerpt` 仅当 `reasonCode !== undefined` 填充，unknown stderr 不填
- [x] AC-A6: Panic stack 只保留 headline，frame / cargo / node module path 全部隐藏（单测验证）
- [x] AC-A7: `LOG_CLI_STDERR` env gate 落地（默认关闭，Maine Coon 2026-02-08 P3-1）
- [x] AC-A8: Classifier 同时扫 stderr + NDJSON stream error events（Codex code 1 真语义覆盖 + tmux nonJsonOutput buffer）
- [x] AC-A9: **回归红线**：raw stderr 不进 user-facing message（守 2026-02-08 旧线）

### Phase B（Frontend 折叠面板）— implementation complete (pending review)

- [x] AC-B1: `CliDiagnostics` type hoisted to `@cat-cafe/shared`. `MessageMetadata.cliDiagnostics` (api) → `BackgroundAgentMessage.metadata.cliDiagnostics` (web wire, type widened in `useAgentMessages.ts`) → `ChatMessage.extra.cliDiagnostics` (unpacked in error-path) → reducer generic extra passthrough (no domain-specific code in `bubble-reducer.ts` — confirmed via dedicated test). History merge (`useChatHistory.ts`) preserves cliDiagnostics across F5 / re-fetch.
- [x] AC-B2: `CliDiagnosticsPanel.tsx` mirrors `TimeoutDiagnosticsPanel` visual contract (banner + collapsible detail). Default folded — `safeExcerpt` only renders after toggle click.
- [x] AC-B3: `publicSummary` + `publicHint` always visible in banner; `safeExcerpt` requires explicit toggle (隐式 opt-in). KD-1 hardened: when `reasonCode` undefined (unclassified stderr), the disclosure toggle hides entirely — there is nothing to opt into.
- [x] AC-B4: All 9 reasonCodes mapped to inline-SVG icons (KD-4 — Lucide source, no emoji). 4-tier severity color grouping (KD-5 author 自决): user-fix→red / transient→amber / system→slate / cognitive→violet. Fallback `UnknownReasonIcon` for undefined reasonCode.
- [x] AC-B5: i18n hint generation stays in Phase A `REASON_TEXT` map (api side). Frontend only renders the already-humanized `publicSummary` / `publicHint` — no UI-layer regex.

### Phase C（Close + organic validation）— operator directive 2026-05-27 调整：跳过手动 alpha smoke，让 production 使用 organic 触发各错误自然验证

- [x] AC-C1: ~~故意触发各错误截图~~ → **organic validation strategy**（operator directive 2026-05-27 "测试我们可以等我之后重启 runtime 在使用过程中帮你测，自然而然发生"）。Production 用户使用过程中遇到 CLI 错误时，folded panel 应自动渲染；任何回归 / 视觉问题 / reasonCode 误分类发生时单独 hotfix 处理。**理由**：手动模拟各 provider 错误成本高（需要构造各 provider 的边界条件），自然触发的覆盖率反而更高（真实 user input、真实 model name 拼错、真实 network 抖动），且能覆盖 19 + 40 automated tests 未覆盖的 long-tail edge case。
- [x] AC-C2: Fuzz stderr smoke — **Phase A 40 个 unit fuzz tests 已覆盖**（`sanitize-cli-stderr.test.js` 21 fuzz 含 ANSI/NFKC/path/JWT/PEM/5 类 provider token/generic high-entropy；`cli-error-patterns.test.js` 4 classifier；`cli-diagnostics.test.js` 15 含 panic stack stripping + bounded helpers + LOG_CLI_STDERR gate）。alpha 环境额外 fuzz 不再要求 — automated layer 已达 AC 强度。
- [x] AC-C3: CloseGateReport（见下方 §CloseGateReport）+ 跨族愿景守护 @gemini25（非作者 = 非 47，非 reviewer = 非Maine Coon，跨族 = Siamese，符合 F073 守护原则）。

### Phase D（result-error 诊断完整性 follow-up）— reopened 2026-05-28

- [x] AC-D1: `maybeCollectStreamError` (cli-spawn.ts) 加收 result error event（判断 **`is_error===true`**，兼容保留 `subtype!=='success'`；真实 A2 是 `subtype:success+is_error:true`），从 `result` 字段提取 cause 进 streamErrorTexts + structuredSink；tmux-spawner.ts rawText 同样补 result error（两条 spawner 路径都修）
- [x] AC-D2: 新增 reasonCode `tool_call_parse_failed`（"tool call could not be parsed"）+ REASON_TEXT summary/hint（"模型工具调用解析失败 / Claude Code 报告：…非猫咖配置"）
- [x] AC-D3: unknown fallback 措辞：rawText 含 CC structured result error（structuredErrorText）时显示 `Claude Code 报告：<原因>`，区分 CC/模型报错（非猫咖 bug）vs 猫咖真未分类；KD-1 白名单放行 CC structured result error（安全，CC 标准措辞）
- [x] AC-D4: 红测先行（先红后绿）：用**真实 A2 结构**（`subtype:success+is_error:true+result文本`，非想象的 subtype:error）做 fixture → maybeCollectStreamError 收集 + buildCliDiagnostics 分类/措辞回归；验证旧 subtype-only guard 对真实数据必 false（红）、is_error guard 收集（绿）、正常 success（is_error:false）不误收；守 AC-A9 红线（raw stderr 不进 user-facing）
- [x] AC-D5: 跨族 review + remote review + 愿景守护 — @gpt52（Maine Coon GPT-5.4）跨族 3 轮 delta APPROVE（6d07ef377 → da1f81763 → 61665f350）；云端 codex 3 轮 review（R1 P2 excerptSource white-list → R2 P1 isResultError gate → R3 Bravo on 61665f350）；merge commit 40af2b82e；愿景守护 cross-post @gemini25 跨族暹罗（非作者非 reviewer）

### Phase F（Empty-stderr observability follow-up）— implementation merged, review pending (2026-05-31)

- [x] AC-F1: abnormal CLI exit 分支无条件调用 `buildCliExitDiagnostic` helper + `'CLI abnormal exit'` log（**独立于** `LOG_CLI_STDERR` env gate 和 stderr 是否为空），payload 字段：`invocationId`, `command`, `exitCode`, `signal`, `reasonCode`, `stderrEmpty (boolean)`, `streamErrorCount`。**cwd 已 drop**（R1 Maine Coon P1-2: `sanitizeCliStderr` 只覆盖 HOME 系 paths，非 HOME server installs `/srv` / `/workspace` / `/var/lib` / `D:\work` 会原样 leak — 安全 > 诊断 redundancy）。
- [x] AC-F2: `LOG_CLI_STDERR=1` 仍只控 raw/sanitized stderr 字段内容；F1 结构化 diagnostic log 不复用此 gate。Integration test 显式验证：env unset 时 `'CLI abnormal exit'` 仍触发，stderr log 才被 gate 抑制。
- [x] AC-F3: `'CLI stderr (LOG_CLI_STDERR=1)'` + `'CLI stderr on timeout'` 两条 log payload 加 `invocationId` 字段。Integration test 用 `createLogStub()` 断言 invocationId 入 payload（R1 Maine Coon P1-1 fix: 之前 publicHint-only assertion 无法 catch log 删除 regression）。
- [x] AC-F4: classifier unknown + `stderrEmpty===true` 时 publicHint = "CLI 已退出但没有输出 stderr。请在后端日志中用 debugRef.invocationId 搜索；如仍无结果，请直接运行该 CLI 并分别捕获 stdout/stderr。" Maine Coon原文案，**不暗示** `LOG_CLI_STDERR=1` 给假希望。
- [x] AC-F5: classifier unknown + `stderrEmpty===false` 时 publicHint 提示用户调 `/api/config/env-summary` 看 `paths.dataDirs.runtimeLogs` 再用 invocationId 搜，**不在 payload 里塞 absolute path`（Maine Coon跨族 push back 守 F212 no-path-leak 安全边界）。
- [x] AC-F6: 红测先行（先红后绿）：unit tests in `cli-diagnostics.test.js` (helper shape + hint variants + backward-compat); integration tests in `cli-spawn.test.js` (3 tests using `diagnosticLogger` stub assert real log payloads + 2 tests assert publicHint via `__cliError` yield). 137/137 pass.
- [ ] AC-F7: 跨族 review + remote review — Maine Coon @codex R1 BLOCKING (2 P1s caught, both fixed at `6b1bfb82d`) → R2 pending. 云端 codex R1 P2 cwd leak (双源 same as Maine Coon P1-2, both fixed) → R2 P2 spec checkbox staleness (this update fixes it) → R3 pending. Phase F merge 不 reopen F212 status（仍 done），同 Phase E follow-up pattern.

### Phase G（Silent-stdout observability）— merged PR #2150 (2026-06-09)

- [x] AC-G1: 加 reasonCode `silent_completion` 到 `CliErrorReasonCode` union (`packages/shared/src/types/cli-diagnostics.ts`) + `REASON_TEXT` entry (publicSummary "CLI 完成但无文字输出" + publicHint 解释 step_start-only pattern + 建议路径)
- [x] AC-G2: 新 helper `buildSilentCompletionDiagnostic` 在 `packages/api/src/utils/cli-diagnostics.ts`，输入 `{eventCount, eventTypes (string[]), model, sessionIdPrefix (前 8 char), exitStatus?, stderrPresent (boolean), stderrExcerpt?}`，返回 structured `CliDiagnostics`。安全边界：no full session id (只前 8 char) / no provider secrets / no prompt content / stderrExcerpt 走 sanitizer + generic absolute path scrub；eventTypes/model/stderr evidence 全部 bounded
- [x] AC-G3: `OpenCodeAgentService.ts:322` no-text branch — track unique event types during stream（`Set<string>` of `result.type`），`textEventCount === 0` 时 build diagnostic + yield `type: 'system_info'` event with `metadata.cliDiagnostics`（cloud R1 P1 修正：silent_completion 不走 provider error path；tool-only turn 不误报）
- [x] AC-G4: `ClaudeAgentService.ts:721` sibling same fix — track unique types + yield diagnostic event（LL-069 应用：sibling sweep from spec text 明示）；Claude result A2 `{subtype:'success', is_error:true}` 优先产出 `tool_call_parse_failed`，不误归 silent_completion
- [x] AC-G5: 红测先行：fixture 1 用 step_start-only NDJSON (Maine Coon packet 第一 regression case) — OpenCode + Claude 两 providers 各一份；fixture 2 验证 sessionIdPrefix 只暴露前 8 char（full session id 不 leak）；fixture 3 验证 stderrExcerpt 不暴露 raw paths/tokens（走 sanitizer + generic path scrub）；fixture 4 验证 tool-only / Claude A2 result-error 不误报 silent_completion
- [x] AC-G6: route-serial.ts:2165 + route-parallel.ts:1193 generic fallback — cliDiagnostics path dominates generic message；新增 serial/parallel route tests 证明 `silent_completion` system_info 不产生 provider error row / persisted `Error:`，前端 `ChatMessage` 可渲染 system_info 上的 cliDiagnostics
- [x] AC-G7: 跨族 review (@codex) + 云端 codex review — Maine Coon R1/R2 blocking review（hint safeExcerpt vs debugRef）+ cloud codex 多轮 P1/P2（tool-only, exitCode, bounded evidence, successful-exit stderr, error-path, Claude A2 result-error）全部修复；`pnpm gate` 全绿；PR #2150 squash merged at `a22164f58`

## Dependencies

- **Related**: F215（Malformed Tool-Call Recovery，owner opus-4.8）——**协同非重叠**：F215 检测 A1（`textEventCount===0` 静默假成功）+ seal/fresh/46 接力兜底；F212 Phase D 把 A2（CC 吐 `is_error:true` 的 result error）正确归因显示。F215 检测信号亦可喂给 F212 诊断 surface。本 Phase D 取证修正了 F215 KD-6（"could not be parsed" 确有独立 stream 信号 = is_error:true result event；A1 才是无信号靠 textEventCount）
- **Related**: F153（telemetry/log 脱敏，sanitizer 规则对齐 `TelemetryRedactor` Class A）
- **Related**: F118（CLI Liveness Watchdog，已 done，错误通道在它之后）
- **Related**: F173（前端消息管道统一，folded 面板复用既有透传机制）
- **Evolved from**: 无（operator 2026-05-25 提的真实 bug）
- **Blocked by**: 无

## Risk

| 风险 | 缓解 |
|------|------|
| Sanitizer 黑名单永远会漏 | 用白名单准入（`safeExcerpt` 只从 classifier 抽），unknown stderr 不展示 raw tail |
| 处理顺序错（截后 sanitize）从 token 中间截尾 | **先 sanitize 再截**，单测显式验证 |
| panic stack 漏掉 frame redact | 只展示 headline 那一行，其他全砍（不做"sanitize 整段 stack"赌博） |
| Classifier 误判（A 错误被分成 B 类别） | reasonCode 表只决定文案样式，原始 reasonCode 在 telemetry 留痕便于追错 |
| 前端 i18n 漏 reasonCode | reasonCode 渲染 fallback：`Unknown ({reasonCode})` 显示英文 |
| 复用 F153 TelemetryRedactor 引入循环依赖 | 提取 sanitizer regex 到独立 util，F212 / F153 都 import，不直接 import 对方 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 走 structured `cliDiagnostics` 而非 sanitized raw tail | 黑名单永远会漏 → 白名单准入更安全（Maine Coon 2026-02-08 + 2026-05-25 两次坚守） | 2026-05-25 |
| KD-2 | Sanitizer 先 sanitize 再截断 | 反过来会从 token 中间截尾绕过黑名单 | 2026-05-25 |
| KD-3 | 一个 feat 一次切完 Phase A + B + C，不拆 "hotfix + follow-up" | "层 1 hotfix + 层 2 follow-up" 是Ragdoll"下次一定"病 | 2026-05-25 |
| KD-4 | Phase B reasonCode → icon **必须自画 SVG**，禁止 emoji（草案 / spec / 实现全场景）| operator directive 2026-05-27 "必须自己画 svg！！！不然太丑了！！"；emoji 跨平台渲染不一致 + 视觉档次低；草案阶段也禁止（feedback_design_to_code_fidelity 升级 P0）| 2026-05-27 |
| KD-5 | Phase B reasonCode → color palette 由 author (47) 自决（Tailwind 500 主调）| operator directive 2026-05-27 "颜色你可以自己决定啦"；现有 OQ-5 一半自决（颜色）+ 一半 KD-4 约束（icon 必 SVG）| 2026-05-27 |

## Review Gate

- Phase A: Maine Coon（@codex GPT-5.5）review — 安全分析 / 测试覆盖（特别盯 sanitizer fuzz + 旧红线回归） ✓
- Phase B: Maine Coon review — 前端透传 + i18n 边界 ✓ + 云端 codex 8 轮 P2 fix ✓
- Phase C: 跨族愿景守护 — **@gemini25 (Gemini 3.5 Flash, Siamese)**（operator directive 2026-05-27：3.5 不再是 3.1 时代的吴下阿蒙；视觉/UX 判断对口；跨族符合 F073；非作者非 reviewer）

## User Visibility Disclosure (Step 0.3.5)

| Surface | 用户能做什么（达成态） | 用户实际能做什么（本 feat close 时） | 缺失/退化 | 处置 |
|---------|--------------------|--------------------------|----------|------|
| 错误消息 bubble | 看到结构化 panel + reasonCode 图标 + 人话 summary/hint + 可选点击查看 sanitized excerpt | ✅ 全功能上线 (live + cold hydration 都覆盖) | 无 | met |
| sanitizer 防护 | 自动隐藏 token / 路径 / panic stack / JWT / PEM / cookie | ✅ Phase A 40 unit fuzz + Phase B frontend path leak 二层兜底 | 无 | met |
| 调试可见性 | 看到 sanitize 后的 command / exit / signal / invocationId 用于工单提交 | ✅ debugRef strip 默认显示，所有字段过 sanitizer | 无 | met |
| icon 设计精度 | invalid_config 用"齿轮带叉" / model_not_found 用"芯片带?" 更直觉 | 当前 SettingsXIcon (像 slider) / PackageXIcon (像盒子) — Siamese守护标记为 P3 polish | 视觉精度可提升但 functional 完整 | polish suggestion (Siamese书面建议，非阻塞，自然 hotfix 时触发) |
| publicHint 对比度 | 浅色背景上的辅助文案 WCAG AA contrast (4.5:1+) | 当前 `#6D6C6A` 在 amber-100 / violet-100 上约 4.6:1 (擦线 pass) | 微调更深可达 5.5:1+ | polish suggestion (Siamese书面建议) |
| toggle 文案语义 | 展开后切"收起详细错误" | 当前展开/收起都显示"查看详细错误" | 微 UX 完整性提升 | polish suggestion (Siamese书面建议) |

**Deliberate defer 项**: 三个 polish suggestion 都来自跨族愿景守护猫主动提议，非 author 自埋"下次一定"尾巴。属于守护放行 + 后续自然 hotfix 触发范畴，不立 follow-up feat、不进 BACKLOG TD。

## CloseGateReport

```yaml
close_gate_report:
  feature_id: F212
  spec_path: docs/features/F212-cli-error-diagnostics.md
  head_sha: 40af2b82e  # Phase D merge SHA
  report_date: 2026-05-29

  ac_matrix:
    # Phase A — Backend cliDiagnostics + Sanitizer
    - { ac_id: AC-A1, status: met, evidence: [{ kind: pr, ref: "#1907", description: "cli-spawn __cliError → cliDiagnostics structured payload" }] }
    - { ac_id: AC-A2, status: met, evidence: [{ kind: test, ref: "packages/api/test/sanitize-cli-stderr.test.js", description: "21 fuzz tests across 11 sanitizer categories" }] }
    - { ac_id: AC-A3, status: met, evidence: [{ kind: test, ref: "sanitize-cli-stderr.test.js: AC-A3 critical truncation bypass test" }] }
    - { ac_id: AC-A4, status: met, evidence: [{ kind: test, ref: "packages/api/test/cli-error-patterns.test.js", description: "9 reasonCodes + 27 classifier fixtures" }] }
    - { ac_id: AC-A5, status: met, evidence: [{ kind: test, ref: "packages/api/test/cli-diagnostics.test.js: safeExcerpt only when reasonCode" }] }
    - { ac_id: AC-A6, status: met, evidence: [{ kind: test, ref: "cli-diagnostics.test.js: panic frame stripping" }] }
    - { ac_id: AC-A7, status: met, evidence: [{ kind: test, ref: "cli-diagnostics.test.js: formatCliStderrForLog LOG_CLI_STDERR gate" }] }
    - { ac_id: AC-A8, status: met, evidence: [{ kind: test, ref: "cli-spawn.test.js + tmux-agent-spawner.test.js: stream error + nonJsonOutput buffer" }] }
    - { ac_id: AC-A9, status: met, evidence: [{ kind: test, ref: "cli-spawn.test.js AC-A9 red line test" }] }

    # Phase B — Frontend folded panel
    - { ac_id: AC-B1, status: met, evidence: [{ kind: pr, ref: "#1915" }, { kind: test, ref: "useChatHistory-cli-diagnostics-hydration.test.ts (3 tests)" }, { kind: test, ref: "bubble-reducer.test.ts AC-B1 passthrough" }, { kind: test, ref: "route-serial-error-persistence.test.js P2-8 metadata persist (2 tests)" }] }
    - { ac_id: AC-B2, status: met, evidence: [{ kind: test, ref: "CliDiagnosticsPanel.test.ts (10 tests)" }] }
    - { ac_id: AC-B3, status: met, evidence: [{ kind: test, ref: "CliDiagnosticsPanel.test.ts AC-B3 + P1-2 + P2 membership guards" }] }
    - { ac_id: AC-B4, status: met, evidence: [{ kind: doc, ref: "cli-reason-icons.tsx 9 Lucide-style SVGs + UnknownReasonIcon + ChevronDownIcon" }, { kind: test, ref: "CliDiagnosticsPanel.test.ts AC-B4 per-reasonCode aria-label" }] }
    - { ac_id: AC-B5, status: met, evidence: [{ kind: doc, ref: "Phase A REASON_TEXT map (zh-CN); frontend renders pre-humanized payload only" }] }

    # Phase C — Close + organic validation
    - { ac_id: AC-C1, status: cvo_signed_off, evidence: [{ kind: message, ref: "0001779880784446-000335" }],
        resolution: { kind: cvo_signoff, reason: "operator directive 2026-05-27: production organic validation replaces manual alpha smoke",
                      cvo_signoff: { proposal_message_id: "0001779880330086-000330",
                                     cvo_message_id: "0001779880784446-000335",
                                     cvo_quote: "测试我们可以等我之后重启 runtime 在使用过程中帮你测，自然而然发生",
                                     accepted_scope: [AC-C1] } } }
    - { ac_id: AC-C2, status: met, evidence: [{ kind: test, ref: "Phase A 40 unit fuzz (sanitize 21 + classifier 4 + diagnostics 15)" }],
        resolution: { kind: delete, reason: "alpha 环境 fuzz 不再要求 — automated unit layer 已达 AC 强度。" } }
    - { ac_id: AC-C3, status: met, evidence: [{ kind: commit, ref: "3c7a055a7", description: "Siamese (@gemini25, Siamese) cross-family vision guard sign-off pushed to main" }] }

    # Phase D — result-error 诊断完整性 follow-up
    - { ac_id: AC-D1, status: met, evidence: [{ kind: pr, ref: "#1950", description: "maybeCollectStreamError + tmux-spawner add support for result error event" }] }
    - { ac_id: AC-D2, status: met, evidence: [{ kind: pr, ref: "#1950", description: "add tool_call_parse_failed reasonCode & i18n texts" }] }
    - { ac_id: AC-D3, status: met, evidence: [{ kind: pr, ref: "#1950", description: "CC structured result error classified with safeExcerpt" }] }
    - { ac_id: AC-D4, status: met, evidence: [{ kind: test, ref: "cli-diagnostics.test.js + cli-error-patterns.test.js", description: "real A2 result error structures and classification validation" }] }
    - { ac_id: AC-D5, status: met, evidence: [{ kind: commit, ref: "40af2b82e", description: "cross-family @gpt52 review + cloud codex Bravo + merge" }] }

  harness_feedback: none
  harness_feedback_reason: "F212 是普通后端+前端 feature，没改 harness/skill/MCP/shared-rules；无 trace anomaly；operator 主动 directive 推进 organic validation 简化 close (vs operator 不满意)；无抽样需求 — 教训通过 capsule + 3 个新 memory feedback 充分沉淀。"
```

### AC 状态总览

| Phase | AC | 状态 | 证据 |
|---|---|---|---|
| A | A1-A9 (9/9) | ✓ all met | PR #1907 merged; tests 40 (sanitize 21 + classifier 4 + diagnostics 15) |
| B | B1-B5 (5/5) | ✓ all met | PR #1915 merged @ 539a2226d; tests 25 (panel 10 + router 7 + hydration 3 + bg 2 + reducer 1 + api persist 2) |
| C | C1 organic / C2 unit / C3 守护 | ✓ all met | C1 organic strategy (operator directive); C2 Phase A 40 fuzz unit; C3 ✓ signed off by @gemini25 |
| **Total** | **17/17** | **✓** | **65 automated tests + 跨族 review + production organic validation** |

### 愿景对照三问

1. **解决了原始 user pain 吗？**
   ✅ 解决。社区 issue #777 (`deepseek-v-4` 模型名拼错) 这种 case 现在用户看到的是「模型名不被支持 — 检查 CLI 配置里的模型名拼写（常见拼错：deepseek-v-4 应为 deepseek-v4-pro / deepseek-v4-flash）」+ 折叠的 sanitized excerpt，而不是黑盒「CLI 异常退出 (code: 1)」。

2. **守住了原有红线吗？**
   ✅ 守住。AC-A9 回归红线（raw stderr 不进 user-facing message）有 1 个专属 unit + sanitizer 全部 21 fuzz 覆盖。Maine Coon 2026-02-08 P0 标记的"黑名单永远会漏 → 白名单准入"原则 KD-1 实施 + 多轮 review 多重防御（reasonCode 缺失 → safeExcerpt 不展示 + 未知 reasonCode 不展示 + membership-check 防 destructure crash + frontend path-leak sanitizer 兜底）。

3. **副作用最小化吗？**
   ✅ 副作用控制。新增 1 个 React component (CliDiagnosticsPanel.tsx ~200 line) + 1 个 SVG icon set (cli-reason-icons.tsx ~160 line) + 类型 hoist 到 shared 1 个新文件 + 4 处 wire-up edit (useAgentMessages active+bg / useChatHistory mapper+merge / ChatMessage routing / route-serial+parallel persistence)。无新依赖、无 breaking API、无现存 UI 元素破坏。bundle size impact 微小 (SVG 全部 inline，no icon library)。

### 关键架构决策回顾

| KD | 内容 | 价值 |
|---|---|---|
| KD-1 | 白名单准入（reasonCode-gated safeExcerpt 展示）| 黑名单永远漏 → 白名单是唯一可证明安全的边界 |
| KD-2 | 先 sanitize 再截断 | 反过来从 token 中间截尾会绕过 sanitizer |
| KD-3 | 一个 feat 一次切完 A+B+C | 避免Ragdoll"下次一定"病 |
| KD-4 | icon 自画 SVG 禁 emoji | emoji 跨平台渲染不一致 + 视觉档次低；KD-4 实施 9 类 reasonCode 各一个 Lucide-style SVG |
| KD-5 | color palette 4 档 severity 分组 | 用户视觉一眼分辨类别严重度（red user-fix / amber transient / slate system / violet cognitive）|

### Lessons learned 沉淀清单

- `feedback_lsof_port_range_kills_sanctuary.md` (P0, CAFE-INCIDENT-20260527 自首) — lsof port-range + ps 进程名通配 = sanctuary 杀手；安全 cleanup 必须端口白名单 + `-sTCP:LISTEN` + `-a` AND-filter
- `feedback_reviewer_cost_routing.md` (P1) — codex 价格 2x of gpt52；reviewer 优先便宜等价
- `feedback_gemini_35_no_longer_what_you_thought.md` (P1) — Gemini 3.5 偏见纠偏；愿景守护可放手
- `feedback_iron_rules.md` 强化 PR tracking 同消息强制 (本次复犯)

### 守护猫反馈与签署意见

由 Siamese/Siamese (@gemini25, model=gemini-2.5-pro) 代表完成愿景守护确认：

1. **9类 reasonCode → SVG icon 设计评估**：
   - 整体设计喻体选择准确，且采用 Lucide 风格的内联手绘 SVG 极大契合了猫咖的审美和轻量工程原则。
   - **优化空间 (P3)**：`invalid_config` 的 `SettingsXIcon` 在代码实现中更像滑块（sliders-2），且没有体现“X”（无效）的叉号。对于非开发者，将其喻体换为带 Alert/Warning 的齿轮，或带 X 的文件会更容易在直觉上理解。
   - **优化空间 (P3)**：`model_not_found` 的 `PackageXIcon`（3D 盒子 + 斜线）对于“模型名找不到”而言，把模型等同于 Artifact 稍微带一点“程序员偏见”。后续如果进行精细度微调，可以设计成类似 `CpuIcon`（芯片外框）加上 X 或问号，使之在 AI 运行时语境下更加自然。

2. **4档 Severity 颜色色板与无障碍性（WCAG AA）**：
   - **高可读性**：主要的 banner 文本采用超高对比度的 `#1A1918`，背景色板（`red-100` / `amber-100` / `slate-100` / `violet-100`）足够轻浅，对比度达到了 10:1 以上，完美通过对比度检测。
   - **双重编码（Color + Icon）保障**：即使红绿/全色弱用户无法区分 `user-fix (red)` 和 `transient (amber)` 的背景色调，排在首位的手绘图标（KeyRound / CloudOff 等）也能作为第一辅助识别特征，因此无障碍访问性非常高。
   - **微调建议**：辅助文案 `publicHint` 颜色 `#6D6C6A` 在亮黄/亮紫背景上对比度略微擦线（约 4.6:1）。可以考虑微调为更深色的灰色（如 `#52514F`）或使用 `opacity: 0.8`。

3. **渐进披露（Progressive Disclosure）与交互节奏**：
   - 极佳。只在最表层显示极简的 Actionable Hint（人话提示），把高噪声的 safeExcerpt 折叠，用户点击后再以深色 `<pre>` 展开，极大降低了心智负担。
   - **微调建议**：`CliDiagnosticsPanel` 展开时的文字“查看详细错误”在展开状态下应该切换为“收起详细错误”。

4. **zh-CN 文案自然度**：
   - 文案符合“温馨猫咖”的独特设定。例如 `invalid_thinking_signature` 的“换一只猫”，这是极具世界观凝聚力的温馨表达，对社区核心玩家十分受用。
   - 其他文案简洁清晰，极具指导意义（如直白指出 `deepseek-v-4` 的拼写错误）。

**守护猫结论**：**[放行]** 该功能符合 F212 愿景。细节优化不作为 Block 门禁，建议在后续日常迭代或 Phase C 顺带优化。
