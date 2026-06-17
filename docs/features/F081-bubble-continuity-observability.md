---
feature_ids: [F081]
related_features: [F045, F048, F055, F069, F084]
topics: [bubble, rendering, continuity, observability, socket, hydration, draft, timeout]
doc_kind: spec
created: 2026-03-07
status: done
completed: 2026-03-10
---

# F081 — Bubble Continuity & Rendering Observability（猫猫气泡连续性与可观测性）

> **Status**: done | **Owner**: Ragdoll

## Why

operator连续报了同一类痛点，但它们表面上长得像不同 bug：

1. Ragdoll明明在 Claude Code session 里已经回答了，主区却没有 assistant 气泡
2. 先看到了Ragdoll回答，切到别的 thread 再切回来，刚才已经看到的气泡又没了
3. 右侧 `task_progress / 猫猫祟祟` 还活着，主区 `💭 心里话` 却消失
4. 有时最后又显示 `CLI 响应超时 (1800s)`，把“UI 丢气泡”和“后端真的静默超时”混成一团
5. 更离奇的是，Ragdoll在较早时刻就应已产出回复，但主区直到operator后续再发一句提示词后，上一条 assistant 气泡才“闪现回来”，呈现出明显的错位回放 / 迟到补写
6. 同一条 assistant 气泡并非“补回来就稳定了”，而是切到别的 thread 再切回来后还能再次消失，呈现出反复出现 / 反复消失的非单调可见性
7. 当operator绕过 Cat Café，直接在 Claude CLI 里 `resume/continue` 同一 session 时，session 会自行消费 `[对话历史增量 - 未发送过 N 条]` 并在外部推进状态；随后主区气泡可能出现迟到、错位或与前端当前可见状态不一致
8. 现在已经证明 `Codex app` 的 thread id 也可以手动 bind 进猫猫咖啡，但 bind 成功后，先前已经存在于 app 里的聊天历史并没有回灌到主区；换句话说，我们能把猫绑进来，却没把它已经说过的话带进来
9. `F081` 第一刀之后，主区又暴露出另一种瞬时“双影”：有时会短暂看到两条自己的消息，或者两条同样的 assistant 回复；但 `F5` 之后又只剩一条，说明服务器真相源通常只有一条，重复更像前端本地 reconcile 留下的临时 duplicate
10. 进一步追查后发现，这类残余“双影”并不都来自 hydration；前台在 `thinking / rich_block / tool` 这类系统占位路径里，一旦 `activeRefs` 先丢了，却又没有先认领 store 里现存的 streaming bubble，就会重新起一个新的 assistant placeholder，形成短暂重复
11. 继续收尾时又发现另一种更隐蔽的症状：主区的 streaming 气泡有时会在中途停止增长，除非 `F5` 才能看到更完整的最终内容；这说明不只是“会不会多起一个泡”，还可能是“后续 chunk 写到了已经失效的旧 message id”

这说明我们现在缺的不是单点补丁，而是**猫猫气泡生命周期的真相源**：

- 气泡是从哪条链路来的：live socket / background route / draft merge / persisted history
- 哪个时刻被创建、续写、替换、清空
- thread switch / F5 / reconnect / timeout 之后，为什么最终会看到或看不到它

operator experience可以概括成一句：

> 渲染不出来也好，跑着突然没了也罢，都要能抓住Ragdoll的猫尾巴。

## What

把“猫猫气泡为什么出现 / 消失 / 没恢复”升级为一个完整 Feature，包含两条主线：

### 1. Bubble Continuity

保证一条已经显示给operator的 assistant 气泡，不会因为 thread switch、history replace、draft merge、socket reconnect、F5 恢复而被无声覆盖或清空。

更严格地说，**历史气泡的可见性必须是单调的**：一条已被显示的 assistant 气泡，除非被明确撤回/删除，否则不能因为后续 rehydrate、切 thread、再进 thread 或发送下一句消息而来回抖动。

### 2. Rendering Observability

建立一套面向operator和开发者都能用的可观测性，能回答：

- 这只猫这次 invocation 到底有没有产出文本
- 文本有没有到前端
- 文本进了哪个 thread state
- 是否被 `replace` / `clearMessages` / hydration 覆盖掉
- 这次是 UI 丢流，还是 provider 仍在跑，还是后端进程真的静默超时

## Scope

### 前端

- 为 assistant bubble 增加 `provenance` / `sourcePath` / `invocationId` / `catId` 级别的生命周期标记
- 为 thread switch / history replace / draft merge / clearMessages 建立可追踪事件
- 修复“已显示气泡被后续 hydration 覆盖”的连续性问题
- 为 active invocation 增加更稳妥的非破坏性恢复策略
- 提供 owner 可用的 debug mode / dump 能力

### 后端

- 为 draft flush / draft merge / timeout diagnosis 增加证据字段
- 为 invocation 记录补齐“最后一次 stdout / stderr / parsed text / UI visible event”时间点
- 明确区分：
  - `provider/session 还在跑`
  - `后端子进程仍有活动`
  - `前端没有可见气泡`
  - `后端真的静默超时`

### 不在本次范围

- 不重做 Claude / Codex provider 协议本身
- 不把所有 CLI stderr 都直接塞进 `💭 心里话`
- 不做全新的复杂调试中心；先做最小但足够定位现场的一版

## Acceptance Criteria

- [x] AC-A1: 气泡连续性与可观测性修复主链路已完成（详见下方条目）

- [x] AC1: 如果 assistant 气泡已经显示给operator，切到别的 thread 再切回时，该气泡不会无声消失 *(PR #288 non-destructive merge + #337 activeRefs recovery)*
- [x] AC2: active invocation 恢复时，history replace / draft merge 不会覆盖掉更新的本地 live bubble *(PR #288)*
- [~] AC3: 当 provider/session 内已产出文本，但主区没有气泡时，debug 证据能明确指出断在 provider / socket / store / hydration 的哪一层 *(部分完成：ring buffer + history_replace 事件已有，无完整 debug UI → TD)*
- [~] AC4: timeout 诊断能明确区分”UI 丢气泡”和”后端 1800s 静默超时” *(部分完成：smoke test 假超时已修 #281，无系统化 timeout diagnosis → TD)*
- [~] AC5: 每条 assistant bubble 可追踪其来源：`live_socket` / `background_socket` / `draft_rehydrate` / `persisted_history` *(部分完成：invocationId 身份链已打通 #288，无完整 provenance 枚举 → TD)*
- [ ] AC6: debug mode 支持导出 invocation 时间线，至少包含：socket 连接状态、agent_message 类型、history replace、clearMessages、draft merge、bubble add/update/remove *(未做 → TD)*
- [x] AC7: 存在自动化回归测试覆盖：
  - 先看到 assistant 气泡，切 thread 再切回，气泡仍在
  - tool-first / text-later invocation 不丢 bubble
  - socket reconnect 后 active invocation 可恢复
  - history replace 不覆盖更新的 live bubble
  *(PRs #288, #310, #318, #337 均含回归测试)*
- [~] AC8: 右侧 task_progress 和主区 assistant bubble 可用同一 `invocationId + catId` 做关联 *(部分完成：invocationId 已打通，无显式 UI 关联 → TD)*
- [x] AC9: 已产出的 assistant 文本不能直到后续用户再发一句消息后才迟到出现；若发生补回，debug 证据必须能解释触发源（history refresh / draft merge / socket replay / local reconcile）*(PR #288 non-destructive merge)*
- [x] AC10: 同一条历史 assistant 气泡在一次会话中不能出现”补回后又因切 thread 再次消失”的抖动；若发生，debug 时间线必须显示是哪次 replace / rehydrate / reconcile 改写了它 *(PRs #288 + #337)*
- [ ] AC11: debug 证据必须能区分”Cat Café 驱动的 invocation”与”外部 CLI 直接 resume/continue 导致的 session 越界推进”，避免把 out-of-band session 变化误判为主区渲染链路唯一根因 *(未做 → TD)*
- [x] AC12: 写路径清点完成：所有能写 `messages`/`catStatuses`/`unreadCount`/`hasActiveInvocation` 的入口均已列出，标注真相源 vs 派生 *(F081-write-path-audit.md)*
- [x] AC13: 状态矩阵完成：`active/background/refresh/switch-away/stream/callback/done/error/timeout` 全场景的四字段预期状态已列出 *(F081-write-path-audit.md)*

## 需求点 Checklist

| ID | 需求点 | AC 编号 | 验证方式 | 状态 |
|----|--------|---------|----------|------|
| R1 | 已显示气泡切线程不消失 | AC1 | test + 手工复现 | [x] |
| R2 | rehydrate 不覆盖 live bubble | AC2 | test | [x] |
| R3 | 链路断点可定位 | AC3 | debug dump + 复现 | [~] TD |
| R4 | timeout 与 UI 丢流可区分 | AC4 | test + 现场证据 | [~] TD |
| R5 | bubble provenance 可追踪 | AC5 | test | [~] TD |
| R6 | debug mode 可导出完整时间线 | AC6 | manual + test | [ ] TD |
| R7 | 关键 race 有回归测试 | AC7 | test | [x] |
| R8 | plan/bubble 可关联到同一 invocation | AC8 | test | [~] TD |
| R9 | 禁止”后续提示词触发历史气泡闪现” | AC9 | test + 现场证据 | [x] |
| R10 | 历史气泡可见性单调，不允许反复显隐 | AC10 | test + 现场证据 | [x] |
| R11 | 区分 Cat Café 内部驱动与外部 CLI 越界推进 | AC11 | debug dump + 现场证据 | [ ] TD |
| R12 | 写路径清点 | AC12 | audit 文档 | [x] |
| R13 | 状态矩阵 | AC13 | audit 文档 | [x] |

## Key Decisions

- **这是 Feature，不是散装 UX debt**
  - 原因：operator能直接感知，且会反复影响对猫猫是否“真的在工作”的判断
- **可观测性是本 Feature 的一部分，不是附属品**
  - 原因：没有证据链，气泡连续性问题会反复“猜修复”
- **先做最小真 debug mode，不做庞大平台**
  - 目标：能抓现场、能导出、能复盘，不追求一步到位
- **不把 stderr 直接等同于 `💭 心里话`**
  - `心里话` 仍然是结构化 stream text；运行日志/诊断事件单独建语义
- **把“迟到闪现”归入同一条连续性故障线**
  - 原因：这说明问题不只是“气泡丢了”，还可能是“旧气泡被后续动作错误地触发回流”
- **把“反复显隐”单独视为高价值证据**
  - 原因：这说明同一条历史 bubble 在不同恢复路径之间被重复改写，问题更像 reconcile / replace 非幂等，而不只是单次漏流
- **外部 CLI 继续同一 session 是重要触发场景，但不能替代主区连续性修复**
  - 原因：out-of-band session mutation 能解释部分“迟到/错位”，但不能合理化“已经显示过的气泡又被主区抹掉”

## Dependencies

- **Evolved from**: F045（NDJSON 可观测性，只解决了事件解析层，不足以解释气泡生命周期）
- **Related**: F055（右侧 task_progress 存活但主区气泡消失，证明 side-channel 与主消息流分裂）
- **Related**: F048（恢复/自愈语义）
- **Related**: F069（thread 切换/恢复时的真相源设计经验）

## Risk

| 风险 | 缓解 |
|------|------|
| debug 事件过多影响性能 | ring buffer + TTL + owner opt-in |
| 现场证据包含 thread 标识 | dump 默认 mask threadId，raw 模式仅本地显式开启 |
| 修复 continuity 时误伤现有 hydration 逻辑 | 先加证据链和回归测试，再改 merge 策略 |
| 把多类故障混成一个修复 | debug 时间线按 layer 拆：provider / socket / store / hydration / timeout |

## Review Gate

- 前端：
  - thread switch / hydration / reconnect / replace 路径测试
  - 至少 1 组“先看到气泡，再切回消失”的回归测试
- 后端：
  - draft flush / merge / timeout evidence 测试
  - invocation 级诊断字段测试
- 交付：
  - 一次现场复现的 debug dump
  - 一张“bubble lifecycle”链路图或时间线

## Detective Notes

### 2026-03-07 Maine Coon侦探现场

- 两条看似不同的Ragdoll session：`7ef0ef90-ac7c-4672-85f1-e1dd8d9ee444` 与 `bfe74a71-e28f-456d-83e4-ae8c5c4bce14`
- 一条由 Cat Café runtime 驱动，一条由外部 Claude Code `resume` 直接驱动
- 进程树向下追到最深处后，两条最终都落在同一个具体 test worker：`test/antigravity-smoke.test.js`
- 这个 smoke test 不在单独的 opt-in 命令里，而是直接包含在 `packages/api` 默认 `pnpm test` 的 `node --test test/*.test.js` 套件中；只要机器上 `<local-browser-automation-endpoint>` 有 Antigravity 在监听，它就会自动参战
- `antigravity-smoke.test.js` 自己声明的单测超时是 `90_000`，内部 `pollResponse()` 也只等 `60_000`，见 `packages/api/test/antigravity-smoke.test.js`
- 但现场里两条 worker 分别静默挂了 8 分钟以上和 20 分钟以上，明显超过预期
- `sample` 结果显示两个 worker 都不是在忙 CPU，而是在事件循环里 `kevent` 空等
- `lsof` 结果显示两个最深 worker 都保持着到 `127.0.0.1:9000` 的 `ESTABLISHED` TCP 连接
- `curl http://<local-browser-automation-endpoint>/json/version` 返回正常，说明 Antigravity 端口活着，但 smoke test 路径没有按预期收敛退出
- 初步推断：这不是“前端把测试刷屏吃掉了”，而是 `antigravity-smoke` 自身存在沉默挂住/句柄未清理问题，随后被Ragdoll的 CLI 静默超时和主区渲染缺失放大成更像“猫没在回话”的体验
- 更强嫌疑点：`CDP connect → send → receive round trip` 这条测试把 `await client.disconnect()` 放在断言之后；如果 `pollResponse()` 返回 `null` 或中途抛错，WebSocket 可能不会被关闭，测试 worker 会留下对 `:9000` 的活连接
- 因此，后续修复需要同时覆盖两条线：一条是 `F081` 的气泡连续性/可观测性，另一条是 `antigravity-smoke` 的资源清理与硬 watchdog
- `Codex app` 这条线也新增了一条高价值证据：
  - 当前会话的 `CODEX_THREAD_ID=019cc8e5-d8bb-7411-90f8-d5e276399145` 被确认可以手动 bind 进猫猫咖啡
  - 但 bind 成功后，猫猫咖啡主区仍然看不到这条 `Codex app` 会话里既有的聊天历史
  - 这说明 continuity/hydration 问题并不只发生在 live socket 途中，也发生在“已知 thread id / session id 的历史回灌”这条恢复路径上
  - 进一步查明后发现：这不是单纯的 Redis 丢消息，也不只是前端少渲染，而是 `bind` 当前只把 `cliSessionId` 写进 session chain，用于未来 `--resume`；主区仍只读 `messageStore + draftStore`，两者之间没有“外部 transcript/jsonl -> 主区时间线”的 backfill 桥
  - 当前第一刀治疗已经在独立 worktree 验证通过：`bind` 响应会返回 `historyImport: { status, importedCount, reason? }`，并在 bind 时 best-effort 扫描我们自己 sealed session 的 transcript，把可导入的 `user/assistant` turn 回灌进 `messageStore`
  - 这条第一刀故意只覆盖“我们自己可读的 transcript 源”，不假装已经解决 `Codex app` 原生历史导入；后者仍是 F081 下一个 adapter 子问题

### 2026-03-07 F081 主线新取证

- 第一只前端真凶已经坐实：`packages/web/src/hooks/useChatHistory.ts` 在 active invocation 的 `replace` 恢复路径里，会先 `clearMessages()` 再灌 API 历史；如果切回 thread 后 live assistant bubble 已经到达，但 API 还没追上，这个 `replace` 会把刚看到的气泡直接抹掉
- 第二只真凶也已经露头：即使不再粗暴清空，replace 仍然会把“同一轮 invocation 的本地 stream placeholder”和“后端追上的 draft/history”当成两个不同气泡，因为前端之前只按 `message.id` 认人：
  - 本地 live bubble 常是 `msg-*` / `bg-*`
  - draft 恢复是 `draft-${invocationId}`
  - 正式持久化消息则带 `extra.stream.invocationId`
- 过去的问题是：后端明明已经持久化了 `extra.stream.invocationId`，但 `/api/messages` → 前端 `ChatMessage` 的映射把这段身份信息丢掉了；同时本地新建的 stream bubble 也没有挂上这层身份
- 当前 worktree 里的第一段治疗已经落地：
  - `replace hydration` 不再盲目清空，而是做 non-destructive merge
  - merge 不只看 `message.id`，还会按 `catId + stream.invocationId` 做同轮 invocation 对位
  - 当 history/draft 比本地 placeholder 更新时，优先后端；当本地 live bubble 更丰富时，优先本地，避免 stale draft 造成“双胞胎”或迟到闪现
  - active / background 两条 stream 创建路径都开始补 `extra.stream.invocationId`，避免 bubble 一旦结束 streaming 就再次失去身份
  - debug ring buffer 新增 `history_replace` 事件，可直接看到 `preservedLocal / reconciledToHistory / replacedHistory` 这些 replace 决策痕迹

### 2026-03-09 增量停止刷新取证

- 新现场不是“服务器没有继续产出”，而是“前端继续写 chunk 的目标 id 失效了”
- `replace hydration` 允许把同一 `catId + invocationId` 的本地 streaming bubble 换成正式历史消息，这是对的
- 但 `useAgentMessages.ts` 的 `activeRefs.current` 之前没有验证这个缓存 id 在 store 里是否还存在
- 一旦 replace 已把本地 bubble 换成 server message，`activeRefs` 仍指向旧 id；后续 text/tool/thinking 继续往旧 id append，就像写进空气
- 这解释了为什么主区会“卡住”，而 `F5` 后又能看到更完整的最终内容：服务器真相源还在长，只是前端 live append 失联了
- 当前治疗策略是：
  - 先验证 `activeRefs` 指向的 message 还活着
  - 如果已经失效，则优先找现存的 `isStreaming` assistant bubble
  - 再找同一 `catId + invocationId` 的正式历史消息并重新认领
  - 必要时把被 hydration 换成正式历史的目标消息重新标成 `isStreaming`
- 回归测试已补上：
  - “切回 thread 后 live bubble 不会被 replace 抹掉”
  - “同 invocation 的 stale draft 不会和本地 richer bubble 变双胞胎”
  - “同 invocation 的 richer server bubble 会替换本地 placeholder”
  - “invocation_created 晚到时，会把 active / background placeholder bubble 绑定到正确的 `stream.invocationId`”

### 2026-03-08 Maine Coon侦探补刀：残余瞬时双影

- operator继续报告：有时前端仍会短暂看到两条自己的消息或两条同样的 assistant 回复，但 `F5` 后又只剩一条
- 这说明后端真相源通常没有重复，剩余问题更像前端本地 store 的瞬时 duplicate
- 新红灯已坐实：`packages/web/src/hooks/useAgentMessages.ts` 在处理 `system_info.thinking` 和 `system_info.rich_block` 时，如果 `activeRefs` 已丢，但 store 里已有同猫 `isStreaming` bubble，会直接新建 placeholder，而不是先认领已有 bubble
- 同样的“先认领再创建”缺口也存在于前台 `tool_use` / `tool_result` / `web_search` 占位路径
- 当前修复把这几条统一收口到 `ensureActiveAssistantMessage()`：
  - 先认 `activeRefs`
  - 再从 store 里恢复现有 streaming bubble
  - 前两步都失败才创建新 placeholder
- 新增回归测试已覆盖：
  - `thinking` 晚到 + `activeRefs` 丢失时复用旧 bubble
  - `rich_block` 晚到 + `activeRefs` 丢失时复用旧 bubble
