---
feature_ids: [F127, F171, F161]
topics: [agent-runtime, role-settings, native-configuration]
doc_kind: implementation-plan
created: 2026-10-10
community_issue: 1466
---
# 本机运行工具角色配置实施

来源：Issue #1466 的成员配置范围；2026-10-10 已接受的低保真与三 runtime 接入研究。用户授权独立 worktree 实施、测试，并将 runtime 更新到实施版本启动供验证。

目标：设置→成员→编辑中选择 Codex、Claude、DSH，默认继承工具配置；模型/强度独立覆盖和清除；旧账号配置保留为高级模式。不自动改动现有角色或用户 CLI/DSH 文件。

Architecture cell：现有成员配置 API/catalog 与 provider carrier；Map delta: none，新增投影与契约辅助模块，不引入新的执行权威。

## 持久化与运行约定

- 新增可选 configurationSource=native_tool|managed_account；字段缺失完全沿用旧行为。native_tool 下 defaultModel 为空表示继承，cli.effort 缺失表示继承。
- native_tool 不解析旧 accountRef，不注入旧 provider/key/url，不使用 app 的 model/effort fallback；保留权限、MCP、回调和密钥隔离。
- 保存更新所选成员；提示下一次新对话采用。既有运行回合/历史 session 不作无声重置，修改偏好后不得把旧采用读数当新配置。
- Codex 原生模式采用 App Server；Claude 使用现有 CLI；DSH 保留已有 ACP command/args/profile，不自动 npx 下载或改用户 HOME。
- ACP 协商 load/resume，分组选项与 opaque value，thought_level descriptor 的真实 id，完整配置回执，所有替换/恢复路径应用同一偏好。
- 检测只读已有启动描述与配置字段；不返回凭据、URL、邮箱，不通过完整 Claude agent 启动查询 defaults。目录未知/错误给出诚实状态。
- builtin cloud 身份保持受保护，不能用新 source 字段绕过 transport identity。

## 工作单元与验证

1. schema/catalog/projection 与 native 解析：API 新回归测试先红，再通过；旧模式账号/模型解析保持回归。
2. provider 接线与 ACP 合约：mock stdio 协议测试、配置覆盖/恢复/重试测试；本机隔离控制探针确认三工具参数行为。
3. 成员编辑入口：本机工具默认卡片、安装/默认预览、可折叠覆盖和旧账号配置。Web Vitest 验证保存/取消/清除/迁移/错误状态；浏览器确认真实入口与移动端。
4. 定向格式检查 `pnpm biome check <changed paths>`；Shared/API/Web TypeScript 检查，API/Web 定向测试。Windows 不可用的 shell clean 流程以原生 tsc 等价编译，不删除共享存储。
5. 非作者 review，修复后提交实施代码。runtime 更新采用可回退的独立 runtime 分支，保留已有本地修复；不执行 hard reset/clean、不复制覆盖 .env/.cat-cafe/data/SQLite/Redis。
6. 从 runtime 自身目录启动，核对源提交、端口和健康；保留原服务/代码恢复路径。只有实际加载该版本才声明已供用户验收。

## Runtime 保护

当前 runtime 有 Redis 备份与 Windows 启动未提交修复。部署前重新核对；按精确文件保留并三方合并代码变更，冲突必须解决，不能覆盖用户修复。角色目录、账号、CLI/DSH HOME 原位保留。测试使用独立 worktree/端口/6398；最后用户验收才使用正式 runtime。

本次不合并首启 PR #1519 或 CLI 探测 PR #1453，不改变首启整体验收状态；实现提供成员工具配置能力并与这两个分支保持兼容。
## 本机工具配置入口

打开「设置 → 成员」，新成员默认选择本机工具；选择 Codex、Claude Code 或已配置的 DSH，保存即可继承工具配置。高级设置中的模型与思考强度分别覆盖；清空各字段分别恢复继承。旧成员需主动切换配置方式，取消编辑不会迁移账号。安装探测不等于认证通过，界面配置预览不等于本次实际采用值。

模型候选来自工具配置与既有角色，允许填写原生模型名；当前不把它们声称为完整的实时模型目录。ACP 的覆盖必须由当前 session 的选项与回执确认，未知或歧义选项阻止发送。模型变化后重新读取选项再应用强度。Windows 启动参数使用可逆的引号序列化，保留包含空格的现有路径。

方案讨论与低保真已整合到同一评论，避免依赖本机附件链接：https://github.com/zts212653/clowder-ai/issues/1466#issuecomment-6092855774 。该评论已邀请维护者讨论；本次部署用于用户验收，不代表 issue 已关闭或变更已合入。

## 作者验证记录

- API 定向测试 131/131 通过，包含真实 Fastify 创建/更新/清除、本机配置解析、启动参数、ACP resume、分组选项及配置回执。
- Web 五个相关套件 101/101 通过。Shared、Collective 依赖、API、MCP 与 Web 的 TypeScript 检查通过。
- 真实浏览器从成员入口创建 Codex 成员，验证仅覆盖强度、清除恢复继承、旧成员切换后取消，以及移动端布局；使用隔离 feature worktree 和 5102/3102 端口，实际调用 API，无接口 mock。
- 使用已安装的三工具完成只读探测，并从原 runtime 只读提取 DSH 的启动描述在隔离 fixture 中验证选择与空白继承，不修改原角色或凭据。
- 已安装 DSH 经本项目 AcpClient 完成 initialize → new → model/effort receipt → close → resume → replay 共七项控制断言；不发送 prompt。DSH 包版本 0.2.0-rc.2 与其 ACP agentInfo.version=0.0.1 是不同版本字段。
- 扩大 Claude/Codex 回归为 150 项：140 通过、10 失败。未改动的基线提交在独立 worktree 同样 140/150，失败集合完全一致；这些 Windows/MCP 路径与配置断言不作为本次绿色测试计入，也未掩盖。
- Windows 的既有 clean/build 包装脚本依赖 Unix rm 或直接 spawn next；使用原生 tsc 与安装包内的 Next 入口验证，未扩大修改构建系统。
- 不声称安装探测或无 prompt 控制探针已经证明三工具认证和真实推理成功；用户在更新后的 runtime 进行真实对话验收。
## 非作者审查修正与最终定向验证

对首版实施提交的独立审查发现五项 P2：恢复成功后的配置拒绝触发新会话、HTTP ACP 丢失回执、Codex 计划模式发送空强度、继承模型时计划模式被忽略，以及旧 ACP 组合被显示成原生工具。已补真实 service/wire/UI 回归，分别复现 RED 并修复：配置拒绝阻止发送；HTTP 与 stdio 保留 opaque 值和回执；计划/恢复模式根据 thread 的实际模型与强度回执构造；缺少必要模型回执时报错；保留 ACP 的成员准确显示当前启动配置，显式选原生工具才切通道。

修正后的 API 定向组合 221/221、Web 五套件 102/102 通过；API/Web 类型检查、定向 Biome 与 diff whitespace 检查通过。扩大 provider 的十个既有失败与前述基线证据保留。门禁检查的 fallback 计数来自继承状态、可选元数据和协议验证，没有在本机执行路径新增静默账号/模型回退。全局 capability-tips 检查相对滞后 origin/main 报既有文档覆盖错误，本切片定向检查通过；不声称全仓 gate 全绿。

面向讨论的完整问题驱动架构、兼容矩阵、扩展边界和参考对比见同目录 `issue-1466-runtime-architecture.md`，内容已内嵌到 #1466 原评论并经远端 UTF-8 精确回读。Runtime 更新须等待本轮修订代码的非作者续审，真实推理与用户验收仍独立记录。