# Plugin 架构

Clowder AI 的核心保留了让一只猫成其为猫的东西——身份、记忆、会话真相，以及一种分寸感。**plugins 则赋予这些猫可以离开网页的身体**：一个前端伙伴、一个桌面探针、一个语音包、一个 IM 连接器。核心（灵魂）与一个 plugin（身体）通过单一的、带版本的 **plugin 契约**相遇。

## 两个仓库，一份契约

plugin 的*管理*与 plugin 的*实现*分处于不同的仓库中，由契约连接：

| 仓库 | 拥有 |
|---|---|
| **`clowder-ai`**（核心） | plugin 的发现与安装、管理 UI、授权、运行 plugins 的 **Host Broker**、编排、审计，以及核心线程、消息与 Task 数据。 |
| **`clowder-ai-plugins`** | plugin **契约**、plugin 侧的 **SDK** 与独立运行时、脚手架、官方 plugins、插件私有业务数据，以及一致性测试夹具（fixtures）。 |

插件仓负责实现和发布包，Host 负责安装集成。支持的来源是经过入库审核的官方仓，以及用户团队自行维护和管理的仓库。SDK 定义双向公共接口；Host 自动注册已启用插件声明的 MCP，复用既有插件 token 与调用上下文转发调用，不再维护另一份逐插件 SDK API 权限名单。库存只持久化包与实例；旧快照的 API grant 字段在读取时忽略。仅旧 SDK 的 hello 响应从原 manifest 投影其必需的两个 wire 字段；内部 session、runtime lease 和 API 准入不携带 grant 状态。

## 契约

`@clowder-ai/plugin-contract` 是双方共同消费的、机器可读的事实来源——JSON Schema、生成的类型、一张能力表，以及一致性测试夹具。它定义了三样东西：

- **输入信封**——一个 plugin 接收的每个输入都在两个维度上被描述：它的**来源**（它从哪里来）和它的**认知状态**（该信息有多确定或多可信）。
- **普通操作及结果**——消息、Task 数据、action、投递回执与字节流。
- **清单与能力类型**——插件集成的资源与操作。

Host 与插件消费同一版本契约，包校验与一致性测试核对包声明和操作形状。

## SDK

`@clowder-ai/plugin-sdk` 为插件作者提供绑定身份的 Host client、模块生命周期 hook、action handler、消息投递和字节流。公共接口以插件仓 `docs/plugin-development.md` 的三段式基线为准。Signal schema 描述 manifest 声明元数据，不提供运行时事件总线。独立 stdio 载体及其握手、帧编码是传输实现细节，不是额外的作者接口。

## 一个 plugin 拥有什么

一个 plugin 在一份清单中声明它的资源（对于仓库本地的 plugins，即 `plugins/<plugin-id>/plugin.yaml`）。资源类型包括：

- **Skill（技能）**——一个按需的提示词包（一个工作流或检查表，Agent 在任务需要时加载它）。
- **MCP**——通过 Model Context Protocol 向 Agent 暴露的一个工具面。
- **Limb（肢体）**——面向物理或外部身体的一种控制平面能力（一个设备动作、观测或就绪信号）。
- **Schedule（计划任务）**——绑定到白名单工厂的一个周期性任务（绝不是任意脚本）。

所有资源类型都通过**一个共享的激活器**来激活，并带着显式的 plugin 归属元数据被记录下来，因此启用或禁用一个 plugin 永远只会触及该 plugin 自己的资源。

## 安装与授权生命周期

1. **发现（Discover）**——宿主找到一个 plugin（一个已校验的仓库本地文件夹，或一个收到的外部包）并读取它的清单。
2. **校验（Validate）**——清单 schema、目录身份、配置键、摘要以及归属边界都会在任何激活控件出现*之前*被检查。无效或相互冲突的 plugins 会被拒绝，而不触及其他任何东西。
3. **授权（Authorize）**——安装并启用一个 plugin 是在 **Settings** 中由本地所有者执行的显式操作。写操作需要本地回环加上请求身份，并且每一次启用/禁用/配置/测试都会发出一个审计事件。
4. **激活（Activate）**——启用时，只有该 plugin 的资源会被激活；它们的状态出现在 plugin 与能力界面中，与内置能力清晰地区分开来。
5. **重新水合（Rehydrate）**——重启之后，只有仍处于启用且仍然有效的 plugins 会回来；已禁用或无效的则保持未激活，并带有一个可见的错误状态。

凭据通过 Host 的机密存储保存，由获授权的插件通过 `secrets.get` 读取。外部平台连接、配置刷新和插件自建进程由插件管理；凭据不写入 Git 跟踪的 manifest。

## 业务归属

插件使用普通消息、线程、成员、Task 和私有存储。插件通知进入普通会话队列，与用户消息使用同一套路由及出队流程。不存在或不可用的提及按普通会话规则接棒，插件不预检 Host 部署状态。

GitHub 跟踪产生普通消息。审查分工与完成通过普通提及、Task 和本地 review 回传表达；GitHub 实际操作使用 `gh` 及声明的工具。反馈卡把显式内容交给插件 action，展示返回的草稿。GitHub 草稿关联与发布状态归插件存储，和 Host 的持久反馈正文独立。

Collective 自己管理本地 HTTP 监听、端口配置、页面资产、认证、origin 校验和 OAuth 回调。Host 通过声明的 action 获取页面地址。插件停止时关闭监听；Host 不分配 browser-service 端口，也不转发插件内部请求。

仓库本地资源与已安装包各自使用对应的加载方式。官方 GitHub provider 代码位于插件仓，使用相同的授权公共 client。

## 官方 plugins

plugins 仓库是首批官方"身体"的家园，每一个都是构建在契约之上的真实垂直场景：

- **飞书会议接入**——发布有界的会议元数据加上一个不透明的来源句柄，配有一个用于重连恢复的持久化发件箱/游标。
- **GitHub**——CI、评审、冲突和仓库扫描集成，已迁移到 plugin 拥有的 schedule 资源之上。
- **物理肢体（StackChan）**——一个物理身体，其契约 schema 定义了设备动作、观测、就绪状态，以及一个独立的设备授权（刻意排除了原始传感器媒体）。

## plugins 绝不会做的事

- **没有任意的同权脚本**——能力只来自声明的、由契约定义的资源类型。
- **不绕过 Host Broker**——一个 plugin 只能通过契约的传输层和授权来抵达核心。
- **不接管核心**——身份、记忆、会话真相和核心会话数据留在 `clowder-ai` 中；一个 plugin 是一个身体，永远不是灵魂。

### Task 数据

公开 Task API 只有 `get(selector)`、`list(filter)`、`create(input, options?)` 和
`update(id, patch, conditions?)`。读取选择 `id` 或 `subjectKey`；列表可组合 `threadId` 与 `kind`。
创建默认拒绝已有 subject；显式 `onConflict: 'update'` 必须给出 subjectKey，由 Host 原子更新。
已接纳的 Work 重复创建时，`update` 原子更新标题和原因；原 owner、thread、来源和合同保持绑定，
带版本的合同修改使用 `update` 方法。
patch 修改普通字段或 Work 数据，或仅包含 `wait`。Host 在原子提交时检查适用的
`expectedThreadId`、等待 generation 与 Work revision，不以先读后写替代条件更新。
Task 数据读写本身不会调度猫或提交审查。
