---
feature_ids: [F171, F155]
topics: [onboarding, native-runtime, authentication, member-settings]
doc_kind: bug-report
created: 2026-10-13
tips_exempt: Corrects existing member status and composer behavior; no new independent capability.
---

# 一键添加伙伴后的认证与状态修复

对应 issue #1466 / PR #1519。用户反馈：新建伙伴不回复，Claude 显示可用却未登录，聊天输入框的 @ 菜单及收件猫位置异常。

## 根因与归属

- 本次隔离实例用了空 CLI HOME，发现本机可执行文件后没有可用认证。Codex 的 401 与 Claude 的 `Not logged in · Please run /login` 都发生在正确的 CLI 调用链。测试环境配置由本 PR 建立，属于本次交付问题；一键添加没有改变原来的认证文件。
- 产品此前只检查 installed，未提前检查登录；成员列表把路由候选可选当作连接可用。前者是本 PR 的体验缺口，后者在同步的 main 中已经存在，同样在本 PR 修复。
- @ 菜单锚定外层全宽容器，收件猫按钮固定宽度分散头像与名字。修改前相关组件与 main 相同；本 PR 一并修复。
- 项目 Hook/Skills/MCP 文件检测不等于模型连接检测。原生工具团队将这一项作为折叠的项目配置提示，保留诊断及同步入口。

## 实现与兼容

1. 已登录的应用会话可发起有超时、有并发上限的原生认证检查：Claude `auth status --json`，Codex App Server `account/read`，`refreshToken: false`。响应只提供枚举状态和检查时间，不返回账号身份、认证内容或 CLI 输出。ACP 未定义统一认证检查，保持未知。
2. 创建前提示未登录；允许保存伙伴草稿。模型目录对未登录工具暂停读取，不覆盖已保存模型与强度。
3. 列表区分未安装、待登录、待验证、真实调用成功。调用成功依据该成员的持久化 dispatch_success / health_probe 事实，覆盖第一次成功时没有旧失败原因的路径；保留路由状态的新鲜度与配额限制。
4. 显式账户、ACP 和自定义配置参数不套用默认 CLI 的登录结果。历史配置与历史消息结构不迁移、不删除。
5. 修正 v2 composer 内菜单锚点和收件猫宽度。经典输入框不迁移菜单位置。
6. 登录检查沿用 Windows 命令解析器的 shell 计划，覆盖不能解析为原生 exe/npm entry 的合法启动文件。真实临时脚本回归先失败为 unknown，再修复为 configured。

差异检查触发了 fallback 层数提示：新增项用于拒绝无会话请求、未知/失败观测不宣称登录、合并同一检查和兼容显式配置，不是重试认证或换供应商。成员状态仅补充既有 owner 的成功事实投影，不增加新的状态存储；保留原有路由新鲜度判断。

## 验证证据

- 回归测试先观察缺陷失败，再验证修复：未登录认证分类、菜单锚点、原生配置提示、首次成功状态、检查路由缺少会话。
- API TypeScript 完整构建通过；Web 完整类型检查通过。
- 本轮 API 原生发现/认证/目录路由/错误分类 53 项通过；Web 相关 5 个测试文件 46 项通过。另有前轮输入框与成员相关回归证据。
- 作者在独立实例 5150/3150/6368 的真实会话中同时 @Codex 与 @Claude，两者均返回“连接验证通过”；不以 mock 引导成功作为真实连接证据。
- 推送后首启 CI 暴露两个旧测试桩未匹配 `?refresh=1` 的失败；本地完整集合复现 138 通过 / 2 失败。保留真实刷新参数，修正模拟请求匹配并断言强制刷新；与 CI 相同的 35 文件、140 项首启测试全部通过，不修改产品行为。
- 实例有独立配置、CLI 认证快照、Next 缓存和 Redis。未复制 CLI 会话、MCP、Hooks、Plugins；Codex 快照排除 OAuth refresh token，避免与原配置竞争刷新。原认证、生产配置和旧测试实例不改写。

已检测登录仅代表本地认证证据，不能保证网络、额度及远端服务始终可用。最终运行验证及重启记录保存在隔离实例的 verification.json 与服务日志中。本报告不表示 PR 已合入或整个 issue 已关闭。
