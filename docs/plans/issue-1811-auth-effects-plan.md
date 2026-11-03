---
feature_ids: []
topics: [codex, native-hooks, authentication]
doc_kind: plan
created: 2026-11-04
---

# #1811 认证动作执行边界实施计划

来源：用户消息 `0001793723700281-000691-1fada9f4`；[#1811 联合根因分析](https://github.com/zts212653/clowder-ai/issues/1811#issuecomment-6609042997)。砚砚负责方案与实施，宪宪独立审查方案和最终提交。目标分支 `next`，基线 `997eccf7ca1669d647acbef1a90608bc6b7efa95`。

## 目标与边界

阻止普通 agent 原生 shell 以诊断为由启动真实 `codex login/logout`，避免旧认证被撤销、全机 1455 回调被取消和浏览器登录页堆积。保留 `login status`、帮助、普通 shell 和用户主动从账户页发起的受管登录。

[#1812](https://github.com/zts212653/clowder-ai/pull/1812) 已包含 Windows 受管 OAuth、平台策略及启动器改动；核验时 OPEN，head `bc92cd22ad0dd587ff7ac5fc2bd96e549b88d309`。本工作不重复该 PR，不修改 manager、driver、平台能力或账户 UI，也不依赖该未合入分支。

不停止当前 Codex，不读写用户凭据/锁/历史，不运行真实登录、登出、设备登录或浏览器复现。`CODEX_HOME` 和 attempt 环境变量不是权限证明，也隔离不了全机回调；拒绝提示引导账户页，平台不支持时保留明确说明，不建议绕过守卫。

## 改动与验证

1. **共享判定**：复用 `scripts/lib/shell-invocation.mjs` 的实际调用解析，在纯认证模块中区分 Codex `auth_mutation` 和只读帮助/状态。识别路径、Windows 可执行后缀、常见 shell 包装、管道、后台和嵌套 shell；引用文本和 heredoc 数据不算执行。CLI 选项的值不能被误当帮助或子命令。对未建模命令继续既有 unknown 策略，不声称可静态穷尽任意脚本。
2. **先证明接线再完善分类**：实际 Claude CLI/SDK 都经 `withClaudeSecretHooks` 注入 host-owned `secret-native-hook.mjs`；在它的 PreToolUse 分支调用共享认证判定，保留 secret 检查和 PostToolUse。Codex 已有 effect guard；classifier 增加 `auth_mutation`，policy 对该明确动作拒绝。不给 Claude 额外开启整个 effect guard，避免把无关限制带上线。正常 manager 由 Host 直接启动，不走 agent 原生工具 hook，不设置可伪造的环境豁免。
3. **RED → GREEN**：先对生产 hook/guard 写 fixture 回归，证明事故命令当前会放行；然后实现。CLI 用假 spawn 捕获最终 settings，SDK 用现有 runtime fixture，执行组合后实际 hook 的 Node 进程，验证拒绝发生在工具执行之前。只执行 hook，不执行被检查的 Codex 命令。再验证打包后离开源码目录仍有效。
4. **审查与合入**：定向回归、格式检查和所需类型检查通过后提交，宪宪审最终 exact HEAD；PR base=next，远端回读正文，更新线程标题。按远端精确 HEAD 的 review/CI/分支保护推进合入。

验收输入覆盖：裸 login/logout、事故 timeout/pipeline、临时 HOME、env/后台、路径 exe/cmd、配置前缀、device-auth 真动作；对应 status/help 必须允许；echo/rg/注释/heredoc 中的命令字样必须允许。unknown、普通写入和现有 secret 保护保持原行为。最终 settings 必须实际执行到认证拒绝，不以脚本名存在或纯函数通过替代。

已核实验证入口：`node --test scripts/native-auth-boundary.test.mjs scripts/secret-native-hook.test.mjs`；API 的 `scripts/with-test-home.mjs` 隔离 HOME 后运行 fake-carrier 接线回归；`pnpm --filter @cat-cafe/mcp-server build` 生成包内运行时后验证迁移布局。格式化使用仓库 `pnpm biome check <本次改动文件>`，只修本次文件。具体执行结果写进同目录验证记录。

## 代价与责任

新增纯判定复用现有 Node hook，不新增常驻进程、网络调用、逐命令审批或状态存储。普通 agent 无法再从 Bash 手工切换 Codex 账号，需使用用户账户入口；这是防住本次已发生掉线损失的直接边界。有限静态解析仍不能保证识别任意外部脚本或动态生成代码，不用全禁 unknown 扩大误拦。

scoped/member 与 readOnly 分支另有现成工具边界：CLI 对二者传 `--tools ''`；SDK 对二者传 `tools: []`。member 仅允许所绑定插件的 `mcp__<server>__*`，`CLAUDE_MEMBER_SETTINGS` 禁用 hook 不会重新授予原生 Bash。本 PR 保留该边界，并跑现有 scoped 回归核实；不把“原生工具禁用”和“认证 hook 已加载”混为一个声明。新增 `auth_mutation` 会有意重新分类原先未建模的 Codex 认证动作，其他 unknown 和既有写入类别保持原判定。

Architecture cell：原生工具执行准入。Map delta：none。Why：复用实际已接入的 Host hook，补上认证副作用这一缺项，不新增授权或登录生命周期。
