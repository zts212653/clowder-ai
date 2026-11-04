---
feature_ids: []
topics: [agent-client, acp, codeagent, plugins, model-discovery, context]
doc_kind: plan
created: 2026-10-30
tips_exempt: 复用既有插件与成员配置入口，兼容性和模型采用诊断随入口展示。
---

# 基于公共 main 的 ACP 插件接入补齐

用户授权：不采用 `feat/role-client-refactor-20261029-deepseek-flash`，从最新公共 main 新开工作树实现；没有 CodeAgent 原生身份资料，先完成可验证的 Host 能力。真实企业 CodeAgent 由现场验收，不要求用户提供 binary。

基线 `upstream/main@4ef8e7404a0f17a5750fdaba974f229647300281`（#1742），分支 `feat/codeagent-main-adapter-20261030`。fork origin/main 为 `44fb36e65b3a9ea4ebb9a9a875e0605c06f80289`，本地 main、旧基础与内网树均不移动。应用 worktree 接口不接受当前容器 workspace 下的实际 Git 根，改用 git worktree add 在用户指定 worktrees/ 下创建并记录。

## 需要修改与验收

| 工作 | 改动位置 | 可观察结果 |
| --- | --- | --- |
| 固定客户端配置 | plugin-agent-provider / agent-client-library / 原插件表单 | 一个工具定义默认即可注册；路径/argv 可保存，ID/transport 不可覆盖；不复制角色身份 |
| 配错后的恢复 | declared-runtime-contributions | 注册未成功时修正配置再保存即可恢复，无需卸载；保留原绑定/历史 |
| 权限语义 | ACP variant / pool signature / factory | 新插件显式 deny/auto_allow 被真正消费；默认值不得暗中 auto_allow；旧非插件策略不静默改变 |
| 插件模型探测 | 原 agent-providers 路由及 runtime catalog probe；成员配置 | 只从已安装启用且校验通过的包解析启动项；请求只传稳定 ref，不接受任意 command；复用有界无 prompt 探测、拒绝 agent fs/permission 请求 |
| 默认与实际采用 | runtime-model-catalog / session configuration / 原成员模型字段 | 跟随默认不写覆盖；未知默认如实显示，显式请求未采用不报告成功；不把 available models 当当前模型 |
| 身份接入边界 | ACP 能力诊断及既有配置说明 | 当前通用 adapter 仍是 user prompt compatibility；明确显示原生身份未验证，不伪造已应用回执或向未知 CodeAgent 发私有字段 |
| 包到 Host 纵向验证 | 实际 CodeAgent tgz + 生产 Manager + ACP fixture | 安装/配置/两成员独立会话、失败恢复/停用/重启；模型探测不发送 prompt；fixture 不代替企业模型/MCP/原生 system 验收 |

Architecture cell: 既有 plugin admission、AgentService、runtime model discovery。Map delta: none。Why: 贯通现有入口，最小修复已确认缺口，不新建角色/会话模型、客户端执行框架或动态代码市场。

## 范围与不变量

- 用户最终只在现有插件和成员入口操作。安装/启用、认证、模型探测和真实调用状态分开；注册成功不能表示模型/原生身份已验证。
- 不引入旧重构的 RoleProfile/ExecutionProfile、统一冻结快照、新片段模型或未知 CodeAgent 适配。旧 #16 只复用经核实的独立配置/恢复算法，按 main 现有边界重新接线。
- CodeAgent 的私有 native system/persona 能力未知。当前兼容身份文本仍有已知限制，本次不能宣称身份质量问题已解决；后续取得真实协议/官方说明后补最小 client 映射并验证首轮/续聊/恢复/压缩，不将所有历史或 A2A 文本提升 system。
- 不带 #18 自动预置、完整内网发行或 Release provider；当前保留本地包/目录与既有安装链，内网插件源仍单独处理。旧 #17 也不整片捆入本次。
- API 普通启动不改配置、不请求模型；不修改系统/祖先 ACL、原生 HOME、认证、Redis/SQLite 或历史。现有成员不强制迁移，不按名字合并工具。
- 模型 probe 是 owner 在既有设置中的动作；不靠前端上送 command、静默 fallback 模型或刷新凭据。缓存以包/配置/生命周期版本为边界；停用后不能用缓存绕过授权。

## 验证与交付

复用 `tdd`：先在本树观察固定配置、插件探测/未知默认/拒绝未采用模型的 RED，再补实现。运行相应 API、Web、ACP/native defaults 和生命周期回归，API/Web TypeScript 与定向 Biome。真实 subprocess fixture 仅用临时项目；常驻服务若有，单独端口并登记、采证后停止，不使用 3003/3004/6399。

潜在在飞重叠：上游 #1596 与 #1674 都修改 AcpAgentService/AcpClient；本片不合入其分支，不替代工具结果或取消专项修复。审查发现仅有 legacy models 的客户端不能将观测模型当成可回放配置，因此在 AcpAgentService.configureNative 内最小调整模型观测时点，三个分支复用同一处；该函数是后续合入热点，AcpClient 不改。先有可验证增量，再按风险独立审查；保持 WIP/Draft、不合并主线。未执行或未知项明确列出。

## 已执行证据（2026-10-30）

- API/shared/MCP 构建与 Web TypeScript 通过。最终 API 定向回归 60 项（含自建插件包纵向用例）：54 通过，6 项 POSIX 进程回收检查在 Windows 明确跳过；没有失败。Web 三组 9/9 通过。原生账号默认值既有回归另 4/4 通过。
- 固定配置、请求模型与实际采用不一致、插件模型路由缺失、权限池签名、刷新后过期默认、错误配置 500 等均先观察到 RED，再修复为 GREEN。
- 生产 Manager + 实际 CodeAgent 插件 tgz 的协议纵向测试 1/1；CI 自建无网络 fixture 包模式另 1/1。验证拒绝/允许的实际 ACP 请求结果，未运行企业 CodeAgent。
- 浏览器 `http://127.0.0.1:4335`：当前工作树生产插件/成员表单 + API，隔离测试 owner。默认未知提示、保存去掉 `--unknown` 的参数、刷新报告 Model A、显式选择 Model B、重开回读连接均通过。请求 trace 无 `session/prompt`，含 `session/set_config_option(model-b)`。预览非完整 Settings 导航验收。
- CI 增加上述 ACP 插件与 Web 定向用例。Windows 的现有 `run-with-node-env-test.mjs pnpm` 子命令报 `spawn pnpm ENOENT`；本机设置进程级 NODE_ENV=test 后直接运行同一 Vitest 用例通过，Linux CI 继续沿用现有 wrapper。
- 本地日志/截图/实例回执：`G:/AIwork/clowder-ai/artifacts/codeagent-main-adapter-20261030`（仓库外，不发布临时数据）。部署和现场验收说明：[CodeAgent 使用指南](../ops/codeagent-main-acp-plugin.md)。
- 独立审查在初版发现两项：刷新抛错/返回非 live 后旧缓存复活；legacy models 观测值被错误回放。均新增连续操作/实际 AgentService 首轮与续聊 RED 后修正，不将模型观测当作 configOptions 能力。
- 修后 `api-final-regression.log` 为上述 60 项结果，`packed-host-final-e2e.log` 为实际 tgz 再验证 1/1；`review-final-api-build.log` 和定向 Biome 均通过。仓库 fallback 诊断已按精确公共基线运行；提醒中包含 schema 布尔校验和单/多客户端二选一，不是新增运行失败回退路径，未为消除计数而重构。
