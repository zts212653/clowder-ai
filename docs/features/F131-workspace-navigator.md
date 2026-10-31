---
feature_ids: [F131]
related_features: [F063, F120, F130]
topics: [hub, workspace, navigation, ux]
doc_kind: spec
created: 2026-03-21
tips_exempt: post-close delivery correctness hardening reuses the existing capability-workspace-navigator tip; no new user action or standalone capability
---

# F131: Workspace Navigator — 猫猫可编程导航 Workspace 面板

> **Status**: done | **Owner**: 金渐层 | **Priority**: P2 | **Completed**: 2026-03-23

## Why

operator 2026-03-20 语音指示（逐字）：

> "你最好也有自己的 skills，能够让猫猫。我跟猫猫说，现在我们一起来看一下审，看一下日志。你能帮我去把右边的 workspace 面板打开？当然，这个不只是日志哦，就有点有点多了。可能是你，我们一起看一下怎么样的文档，你也能一起帮我把文档直接打开，就不要我一个个去点。"

> "跟浏览器的 Preview 一样。更通用的是，我用语音或者用文字告诉你，你帮我一起打开这个 workspace 的哪个地方？你要能帮我打开。"

operator 2026-03-21 进一步明确：

> operator不会给精确路径。"帮我打开日志""看看 F131 的设计图""打开那个 discussion"——猫猫自己能 glob/grep 到路径，自己去传精确路径到 API。对人类来说说全路径太不友好了。

核心痛点：operator让猫猫一起看某个文件/目录时，只能靠自己在 Workspace Explorer 里手动点击层层目录。猫猫有 `setWorkspaceOpenFile` / `revealInTree` 等前端能力，但没有对外暴露的 HTTP 端点供猫猫调用。browser-preview 的 `auto-open` 已证明这种模式可行且体验好。

## What

**单 Phase，三层架构**：

> **Current contract（2026-07-28 post-close repair，覆盖下方历史 transport 细节）**：
> 调用面接受 Codex-native absolute path，或 repo-relative path + worktreeId；服务端统一归一化为
> typed Workspace target。listener 位于 AppShell，目标暂不可见时按 thread 存入
> sessionStorage。API/MCP 返回 `applied / queued / blocked / unconfirmed`，`ok:true` 不代表
> 用户已看见。invocation-token MCP 可省略 `threadId` 并继承 invocation 绑定 thread；
> persistent agent-key MCP 必须显式提供其有权访问的 `threadId`，缺失时在 HTTP 前拒绝。

### 1. 基础设施层（Infra）— HTTP API + Socket + 前端监听

**参照 F120 browser-preview 的 `auto-open` 模式**，搭建猫猫→Hub 的通信管道：

1. **后端 API**：`POST /api/workspace/navigate`
   ```json
   {
     "path": "packages/api/data/logs/api/",
     "worktreeId": "cat-cafe-runtime",
     "action": "reveal"
   }
   ```
   - 通过 Socket.IO 发送 `workspace:navigate` 事件到 Hub 前端
   - 前端收到后：切换右面板到 workspace 模式 → 切换 worktree → revealInTree / setWorkspaceOpenFile

2. **前端 Socket 监听**：在 AppShell（跨 route 挂载）添加 `workspace:navigate` 事件监听
   - 类似 `usePreviewAutoOpen` 的模式（新建 `useWorkspaceNavigate` hook）
   - 自动打开右面板（如果关着）→ 切到 workspace 模式 → 执行导航

3. **Pending 机制**：目标 thread/route/viewport 当前不可显示时不静默丢事件
   - `sessionStorage` 按 target thread latest-wins 排队，route/thread/desktop 条件满足后消费
   - Presentation Lock 阻塞新文件自动导航；`knowledge-feed` 即时/排队消费共享锁内豁免；
     存储不可用明确返回 blocked

### 2. 硬实力层（Agent 能力）— 猫猫自己解析路径

猫猫收到模糊意图后，**用自身工具（glob/grep/read）找到精确路径**，然后调用 typed MCP：

```
operator: "帮我打开 F131 的设计图"
  ↓
猫猫: glob("**/F131*.pen") → 找到精确路径
  ↓
猫猫: cat_cafe_workspace_navigate { path: "/absolute/.../F131-xxx.pen", action: "open" }
  ↓
Hub: 右面板自动打开并导航到文件
```

这一层不需要后端做任何"智能解析"——猫猫本身就是路径解析器。关键是 **Skill 文档要教会猫猫怎么做模糊意图匹配**。

### 3. 软实力层（Skill）— 教猫猫做意图匹配 + 导航

`cat-cafe-skills/workspace-navigator/SKILL.md`：

- **触发词识别**：「看看代码」「打开文件」「看日志」「帮我打开」「一起看看」「打开设计图」
- **意图→路径匹配策略**：教猫猫根据不同意图类型用不同搜索策略
- **调用步骤**：找到路径后调 `cat_cafe_workspace_navigate`，并消费 deliveryStatus
- **与 browser-preview 的区分**：workspace-navigator 打开文件/目录，browser-preview 打开 localhost 页面
- **常见场景速查表**：日志→哪里找、Feature 文档→哪里找、设计图→哪里找

## Acceptance Criteria

- [x] AC-1: 猫猫调用 `POST /api/workspace/navigate` 后，Hub 右面板自动打开 workspace 模式并导航到指定路径 ✅ PR #611
- [x] AC-2: 支持 `reveal`（展开目录树到指定节点）和 `open`（打开文件内容）两种 action ✅ PR #611
- [x] AC-3: 支持指定 worktreeId 跨 worktree 导航（如从 main 导航到 runtime 的日志目录） ✅ PR #611 (threadId session isolation)
- [x] AC-4: 面板关闭时收到事件能自动打开（参考 usePreviewAutoOpen 的 pending 机制） ✅ PR #611 (复用 chatStore.setWorkspaceRevealPath/setWorkspaceOpenFile)
- [x] AC-5: Skill 文档 `workspace-navigator/SKILL.md` 创建完成，含意图匹配策略、调用步骤、常见场景速查 ✅ commit 8d61c783
- [x] AC-6: 端到端验证——operator说"帮我打开日志"，猫猫能自己找到路径 → 调 API → Hub 右面板自动展示日志目录 ✅ 2026-03-23 runtime E2E（含 PR #678 回归）
- [x] AC-7: absolute path 无需 worktreeId；repo-relative path 仍需 typed worktreeId
- [x] AC-8: inactive thread / non-chat route / narrow viewport 排队，返回目标 chat 后消费
- [x] AC-9: Presentation Lock 阻塞新文件自动导航，不污染 pending target；
  `knowledge-feed` 不替换锁定文件，可在锁内即时或延迟消费
- [x] AC-10: API/MCP 回报 applied/queued/blocked/unconfirmed；无 ack 不宣称 visible
- [x] AC-11: 文件解析与 Socket 广播前必须建立可信 principal；MCP callback/agent-key
  经 API composition root 验证，audit catId 不接受 payload 伪造
- [x] AC-12: `cat_cafe_workspace_navigate` 按实际认证模式约束 thread scope；invocation auth
  可继承绑定 thread，agent-key auth 缺少显式 `threadId` 时在 HTTP 前 fail closed

## Dependencies

- **Evolved from**: F063（Workspace Explorer 提供了文件树和文件查看基础设施）
- **Related**: F120（Browser Preview 的 `auto-open` 模式是基础设施层的设计模板）
- **Related**: F130（日志治理 — 日志一键跳转按钮是 F130 Polish，但通用导航能力独立为本 Feature）

## Risk

| 风险 | 缓解 |
|------|------|
| Socket 事件在面板关闭时丢失 | 复用 F120 的 pending 机制：存 store → 面板打开时消费 |
| worktreeId 不匹配导致导航失败 | API 层校验 worktreeId 存在性，不存在返回 404 + 提示 |
| 猫猫意图匹配不准（找错文件） | Skill 文档提供明确的搜索策略 + 多结果时让operator确认 |
| Socket emit 成功但用户未看到 | client ack + deliveryStatus；无 ack 保守标记 unconfirmed |
| 当前不是目标 chat / 在 standalone route / 窄屏 | session-scoped per-thread pending；不抢当前 thread |
| 直接 HTTP 调用探测本机路径或伪造审计身份 | session / direct-loopback / verified callback-agent-key gate 在解析前 fail closed；audit catId 由 principal 派生 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 参照 F120 browser-preview 的 auto-open 模式（HTTP API + Socket 事件 + 前端监听） | operator明确说"跟浏览器的 Preview 一样"，已验证模式可行 | 2026-03-21 |
| KD-2 | 日志一键跳转按钮作为 F130 Polish 独立实现，不依赖 F131 | 按钮是 UI 入口，F131 是猫猫编程式能力，解耦更灵活 | 2026-03-21 |
| KD-3 | 不分 Phase A/B，单 Phase 三层：基础设施层 + 硬实力层 + 软实力层(Skill) | operator拍板——模糊路径解析是猫猫的 Agent 能力（硬实力），不需要后端做；Skill 教猫猫怎么做（软实力）；API/Socket 是管道（基础设施） | 2026-03-21 |
| KD-4 | 猫猫传给 API 的路径必须是精确路径，模糊意图解析在 Agent 侧完成 | operator："我不会告诉你全路径，你自己能 glob 到的" — Agent 本身就是路径解析器，无需后端 LLM | 2026-03-21 |
| KD-5 | absolute path 是公开输入格式；relative + worktreeId 是兼容 typed 格式 | 对齐 Codex 原生文件链接，同时不泄漏内部安全坐标给调用者 | 2026-07-28 |
| KD-6 | listener 上移 AppShell，pending 按 target thread 存 sessionStorage | non-chat route 也能接事件；不自动抢走当前 thread | 2026-07-28 |
| KD-7 | `ok:true` 与 visible 分离，deliveryStatus 由 client ack 决定 | emit 不是用户可见证据 | 2026-07-28 |
| KD-8 | navigation auth 在 Workspace route plugin 内建立 | Fastify sibling plugin 的 callback hook 不跨 scope；必须在 filesystem lookup 与 emit 前验证 | 2026-07-28 |
