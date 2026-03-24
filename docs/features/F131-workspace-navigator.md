---
feature_ids: [F131]
related_features: [F063, F120, F130]
topics: [hub, workspace, navigation, ux]
doc_kind: spec
created: 2026-03-21
---

# F131: Workspace Navigator — 猫猫可编程导航 Workspace 面板

> **Status**: done | **Owner**: 金渐层 | **Priority**: P2 | **Completed**: 2026-03-23

## Why

team lead 2026-03-20 语音指示（逐字）：

> "你最好也有自己的 skills，能够让猫猫。我跟猫猫说，现在我们一起来看一下审，看一下日志。你能帮我去把右边的 workspace 面板打开？当然，这个不只是日志哦，就有点有点多了。可能是你，我们一起看一下怎么样的文档，你也能一起帮我把文档直接打开，就不要我一个个去点。"

> "跟浏览器的 Preview 一样。更通用的是，我用语音或者用文字告诉你，你帮我一起打开这个 workspace 的哪个地方？你要能帮我打开。"

team lead 2026-03-21 进一步明确：

> team lead不会给精确路径。"帮我打开日志""看看 F131 的设计图""打开那个 discussion"——猫猫自己能 glob/grep 到路径，自己去传精确路径到 API。对人类来说说全路径太不友好了。

核心痛点：team lead让猫猫一起看某个文件/目录时，只能靠自己在 Workspace Explorer 里手动点击层层目录。猫猫有 `setWorkspaceOpenFile` / `revealInTree` 等前端能力，但没有对外暴露的 HTTP 端点供猫猫调用。browser-preview 的 `auto-open` 已证明这种模式可行且体验好。

## What

**单 Phase，三层架构**：

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

2. **前端 Socket 监听**：在 ChatContainer（全局挂载）添加 `workspace:navigate` 事件监听
   - 类似 `usePreviewAutoOpen` 的模式（新建 `useWorkspaceNavigate` hook）
   - 自动打开右面板（如果关着）→ 切到 workspace 模式 → 执行导航

3. **Pending 机制**：面板关闭时 Socket 事件不丢失
   - 复用 F120 模式：store 存 pending 状态 → 面板 mount 时消费
   - chatStore 已有 `workspaceRevealPath` + `setWorkspaceRevealPath`（自动切 rightPanelMode），可直接复用

### 2. 硬实力层（Agent 能力）— 猫猫自己解析路径

猫猫收到模糊意图后，**用自身工具（glob/grep/read）找到精确路径**，然后调用基础设施层的 API：

```
team lead: "帮我打开 F131 的设计图"
  ↓
猫猫: glob("**/F131*.pen") → 找到精确路径
  ↓
猫猫: curl POST /api/workspace/navigate { path: "designs/F131-xxx.pen", action: "open" }
  ↓
Hub: 右面板自动打开并导航到文件
```

这一层不需要后端做任何"智能解析"——猫猫本身就是路径解析器。关键是 **Skill 文档要教会猫猫怎么做模糊意图匹配**。

### 3. 软实力层（Skill）— 教猫猫做意图匹配 + 导航

`cat-cafe-skills/workspace-navigator/SKILL.md`：

- **触发词识别**：「看看代码」「打开文件」「看日志」「帮我打开」「一起看看」「打开设计图」
- **意图→路径匹配策略**：教猫猫根据不同意图类型用不同搜索策略
- **调用步骤**：找到路径后 curl 调 navigate API
- **与 browser-preview 的区分**：workspace-navigator 打开文件/目录，browser-preview 打开 localhost 页面
- **常见场景速查表**：日志→哪里找、Feature 文档→哪里找、设计图→哪里找

## Acceptance Criteria

- [x] AC-1: 猫猫调用 `POST /api/workspace/navigate` 后，Hub 右面板自动打开 workspace 模式并导航到指定路径 ✅ PR #611
- [x] AC-2: 支持 `reveal`（展开目录树到指定节点）和 `open`（打开文件内容）两种 action ✅ PR #611
- [x] AC-3: 支持指定 worktreeId 跨 worktree 导航（如从 main 导航到 runtime 的日志目录） ✅ PR #611 (threadId session isolation)
- [x] AC-4: 面板关闭时收到事件能自动打开（参考 usePreviewAutoOpen 的 pending 机制） ✅ PR #611 (复用 chatStore.setWorkspaceRevealPath/setWorkspaceOpenFile)
- [x] AC-5: Skill 文档 `workspace-navigator/SKILL.md` 创建完成，含意图匹配策略、调用步骤、常见场景速查 ✅ commit 8d61c783
- [x] AC-6: 端到端验证——team lead说"帮我打开日志"，猫猫能自己找到路径 → 调 API → Hub 右面板自动展示日志目录 ✅ 2026-03-23 runtime E2E（含 PR #678 回归）

## Dependencies

- **Evolved from**: F063（Workspace Explorer 提供了文件树和文件查看基础设施）
- **Related**: F120（Browser Preview 的 `auto-open` 模式是基础设施层的设计模板）
- **Related**: F130（日志治理 — 日志一键跳转按钮是 F130 Polish，但通用导航能力独立为本 Feature）

## Risk

| 风险 | 缓解 |
|------|------|
| Socket 事件在面板关闭时丢失 | 复用 F120 的 pending 机制：存 store → 面板打开时消费 |
| worktreeId 不匹配导致导航失败 | API 层校验 worktreeId 存在性，不存在返回 404 + 提示 |
| 猫猫意图匹配不准（找错文件） | Skill 文档提供明确的搜索策略 + 多结果时让team lead确认 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 参照 F120 browser-preview 的 auto-open 模式（HTTP API + Socket 事件 + 前端监听） | team lead明确说"跟浏览器的 Preview 一样"，已验证模式可行 | 2026-03-21 |
| KD-2 | 日志一键跳转按钮作为 F130 Polish 独立实现，不依赖 F131 | 按钮是 UI 入口，F131 是猫猫编程式能力，解耦更灵活 | 2026-03-21 |
| KD-3 | 不分 Phase A/B，单 Phase 三层：基础设施层 + 硬实力层 + 软实力层(Skill) | team lead拍板——模糊路径解析是猫猫的 Agent 能力（硬实力），不需要后端做；Skill 教猫猫怎么做（软实力）；API/Socket 是管道（基础设施） | 2026-03-21 |
| KD-4 | 猫猫传给 API 的路径必须是精确路径，模糊意图解析在 Agent 侧完成 | team lead："我不会告诉你全路径，你自己能 glob 到的" — Agent 本身就是路径解析器，无需后端 LLM | 2026-03-21 |
