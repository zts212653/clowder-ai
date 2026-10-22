---
feature_ids: [F241]
topics: [acp, plugins, members]
doc_kind: feature-spec
created: 2026-10-22
tips_exempt: "本地候选插件尚未发布，配置和绑定入口说明随插件 README 展示；发布目录接入时再提供可导航的能力提示。"
---

# ACP client 插件配置与角色绑定

本功能在 [#1665](https://github.com/zts212653/clowder-ai/pull/1665) 的 Host-owned 会话契约基础上，提供 ACP client 配置复用、角色绑定及恢复。配套插件见 [clowder-ai-plugins#104](https://github.com/zts212653/clowder-ai-plugins/pull/104)；本规格描述产品契约，实际交付状态和验证版本以对应 PR 为准。

Before：每只成员重复填写命令参数，插件实现绑定还需修改环境变量并重启。
After：插件管理页配置命名 client；成员编辑器选择已启用 client，保存即可对话。

## 契约与状态

- 插件为纯数据包，通过 `agent-provider.json` 的 `configurationKey` 引用 manifest 声明的 string 配置。
  值为有界 JSON 数组，Host 使用结构化编辑器呈现 id、名称、命令及逐项 argv，不要求用户手写 JSON。
- 保留 #1665 的单 provider 声明。新配置仍经已有配置、完整性验证、授权、激活和停用链路。
- Host 拥有 ACP 传输、身份、工作目录、MCP、回调凭证、进程和会话；插件只提供启动数据。
- 成员保存角色级 `agentProvider` 引用，不复制 client 命令。字符串选择插件；`null` 明确选择原生/手动工具；缺失才兼容旧嵌套引用及环境绑定。移除、停用或配置失效均不得回落到其他 client。
- 更新插件配置释放旧会话并重新注册。角色改绑释放旧桥；插件停用取消进行中调用。
- 配置页可展示未启用和无效状态；角色下拉只允许已激活的配置。持久化引用重启后恢复。

## 工作单元与证据

1. 有界配置解析和多 provider 激活：新增失败测试，API build、定向 Node 测试转绿。
2. 持久成员绑定与目录 API：复用 cats 写入、插件 owner 访问控制，验证缺失与停用不回落。
3. 插件包和配置/成员 UI：复用 Settings token，跑相关 Vitest、typecheck、正常视口的浏览器验证。
4. 实际 client：从本机安装确认 ACP 入口和版本，隔离实例验证两轮、工具结果、取消、重启续接及插件停启。
5. 最终 packed plugin 在空白 consumer 验证；代码、包哈希、会话及进程记录归档。

验证命令来源：当前 package.json。格式化使用 `pnpm biome format --write <改动文件>`，
API 使用 `pnpm --filter @cat-cafe/api build`，Web 使用 `pnpm --filter @cat-cafe/web exec vitest run <受影响测试>`。
只对适用面执行检查，不拿 mock 或直接 ACP probe 代替完整 UI/runtime 验收。

Architecture cell：现有 F241 Host-owned ACP extension；Map delta：none。
Why：复用已有插件配置、准入、运行生命周期和 SessionImplementationRegistry；不新增持久存储或进程所有者。
验收环境隔离应用数据、Redis 和原生客户端状态，记录源码、插件包及测试会话的确切归属；不向日志输出凭据，不修改既有配置或历史。

## MCP 与角色协作续办（2026-10-22）

验收范围：dsh、Claude、Pi 的实际客户端调用 Clowder MCP 并参与角色协作，补齐 Pi 的 MCP 透传。

- Host 自动提供协作 MCP、当前会话回调凭证与角色身份；用户配置只有启动命令和参数，不填写 token。
- pi 使用独立 `@clowder-ai/pi-acp` 桥，固定上游 pi-acp 版本及源哈希构建，透传 ACP MCP 到本机 Pi 1.3+ 原生注册 API。
- 仅注册当前会话，不写用户 mcp.json；新建、恢复、凭证刷新都应用新的服务器参数；重复配置和不支持的传输明确失败。
- 复用成员既有工具选择和 MCP 开关；选择插件 client 默认允许 MCP，保存后生效。
- 验证：协议新建/恢复、stdio/HTTP 参数、异常边界 → packed fresh consumer → 隔离真实客户端 MCP 调用和跨角色回执 → API 重启续接。
- 交付本地安装包、操作说明、真实消息/工具/会话证据及实例收尾；旧阶段 MCP=0 的证据保留，不用于替代本阶段验收。

## 源码提交范围（2026-10-22）

Host 与插件分别提交对应仓库，通过独立 PR 交付。
Host PR 依赖 #1665；插件 PR 依赖本次 Host 扩展。这里只提交源码，不发布 npm 或部署生产。
公开操作指南采用可替换路径与完整源码启动命令；原本机手册、认证、历史及原始验收数据在仓外保留。

## 可信主机兼容模式（2026-10-22）

严格路径、Windows 祖先兼容 B、受限配置审计恢复 C 分别有独立契约；默认 strict/required。内网部署通过 Host .env 一次保存，重启与升级持续沿用；D 的一次性准备独立交付，API 不自动回写部署文件。
审计失败只允许 Windows trusted-host 下已有 ACP client 的显式 bootstrapRoot 变化；完整原生检查后，在写事务内复读原文本、包 digest、grant 并消费版本围栏。新增 client、改名称/顺序/命令/argv/MCP 或其他插件配置均不豁免，安装/启用和工具调用保持原准入。
旧 exact 1 对未设置的新键映射受限组合，新键逐项优先，strict 会屏蔽 C；非法新值启动失败，warning 与 error 分开。保留目录自身私有权限、原生身份和直接本机管理；不改系统盘或已有 ACL，不改存量 ID/绑定/历史。持久 inventory 写事务由原生锁排他，配置写者共享事务；运行部署仍只支持一套 Host API，不提供多个 API 的 runtime 协同。
契约与操作见[设计](../design/2026-10-22-trusted-host-compatibility.md)和[指南](../ops/acp-trusted-host-compatibility.md)。报告者已有 CodeAgent 正常使用反馈，但精确构建/访问拓扑和逐项 MCP/协作/续接证据未齐；本机合成验证与真实 dsh/Claude/Pi 结果须分开记录。
