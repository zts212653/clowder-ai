---
feature_ids: [F190]
topics: [console, frontend, intake, lessons]
doc_kind: guide
created: 2026-05-12
---

# F190 Frontend Lessons

本文件记录 F190 Console/Settings intake 的具体案例。主流程见 `cat-cafe-skills/console-dev/SKILL.md`；这里只沉淀这次社区 PR 回流中已经验证过的边界。

## Gate 1: AppShell 可以成片，业务域不能混片

AppShell、ActivityBar、SettingsNav、CSS token 强耦合，可以作为一个 skeleton slice 验证。Service Manifest、refAudio、MCP 写接口、chat route/rendering 不属于 skeleton；它们必须各自写 `Source Behavior / Must Preserve Home Behavior / Decision / Proof`。

教训：拆分不是把耦合 UI 硬切碎，而是把不同风险域切开。

## Gate 1: Settings section 的入口层级

大多数管理能力应落在 L2 `/settings`，只读/分析类能力落在 L3 subsection。L1 ActivityBar 只放每日核心入口，不能因为新 feature 重要就默认占 L1。

教训：入口是稀缺资源；新增入口先问“用户是否每天直接用它”。

## Gate 2: Token 迁移要新严旧宽

新 Console 代码使用语义 token 和现有 utility；旧文件不在同一 slice 里强行迁移。每个 slice 只扩大可验证的 token 覆盖，不把“全局美化”夹进业务迁移。

教训：设计体系迁移是单调收敛，不是一次性重刷全仓。

## Gate 3: Settings manual-port 三真相

每个 settings 内容迁移都必须写清：

- `Source Behavior`: 社区 PR 想带回的行为。
- `Must Preserve Home Behavior`: 家里已有的行为、安全边界和测试。
- `Proof`: focused tests、type/lint、Brand Guard、red-zone grep、必要时浏览器 proof。

教训：intake 不是覆盖文件；结果必须同时包含 source intent 和 home invariants。

## Gate 3: Read-only wrapper 优先于写接口回填

MCP 管理第一刀只复用现有 capability board 并过滤 MCP 类型，不回填 `McpConfigModal`、secret redaction、install/delete 写接口。Skill preview 只读 `SKILL.md`，通过已审查的 `/api/rules/skill/:name` 路由读取。

教训：能用 read-only wrapper 验证入口的，不要同 slice 拉入写入路径。

## Gate 4: F183/F184/F194/F195 红区必须单独 proof

以下变化不允许“顺手”出现在 F190 settings slice：

- `ChatMessage` / `ChatContainer` / `chatStore` / `useAgentMessages`
- bubble reducer、hydration、thread route marker
- 富文本样式、链接颜色/下划线、消息气泡 spacing
- live invocation / meeting copilot 前端状态

教训：Console shell 的成功不能以聊天气泡行为漂移为代价。

## Gate 4: Query string 必须 reactive

ActivityBar / Settings / export mode 依赖 query string。读取 query 时必须保留现有参数，并随 URL 变化响应；mount-only state 会导致 `?export=true` 等模式切换后 UI 不更新。

教训：route state 是运行时输入，不是 mount 时常量。
