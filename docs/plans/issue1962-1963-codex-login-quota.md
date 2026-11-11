---
feature_ids: [F320]
topics: [codex, oauth, quota, windows]
doc_kind: plan
created: 2026-11-11
---

# Codex 登录窗口与默认账号额度修复

来源：#1962、#1963 及两单维护者讨论。一个 PR 目标 next，两条修复分别验证。

双方讨论后选定：

- Windows 默认使用隐藏 PowerShell，保留官方 CLI 与现有 worker 的控制台继承；移除默认 `-NoExit`。官方 CLI 仍拥有浏览器与全部 OAuth 输出。macOS 现有终端行为保持。
- 等待或失败时在现有账号行提供显式“打开登录终端”。用户点击后取消旧尝试，再用可见终端启动新尝试。仅主动选择的可见终端保留失败输出；宿主不捕获或保存 OAuth URL/state。
- 默认账号额度保存于账号配置 owner 根的 `.cat-cafe/native-codex-quota.json`，仅保存 credentialHome 与已脱敏的 quota。复用已有 schema 和原子写入，不创建账号行，不改变 `syntheticNative` / `authMode=auto`。
- 查询结束核对合成账号仍未登记、home/身份未变；GET 合并侧车时再次按 home/owner 校验。缺少身份的登录失败只在当前仍无身份时展示。持久账号的删除/换身份保护保留。
- 409 使用现有身份变化提示，不伪造新的服务故障或静默刷新，不自动重试。

排除方向：直接补账号行会改变原生 CLI 认证语义；直接隐藏输出却没有可操作兜底会丢失浏览器未打开时的恢复路径。不增加数据库、锁、TTL、通用存储框架或凭据迁移。

Architecture cell: accounts / provider login
Map delta: 默认账号增加额度观察侧车；认证与账号目录的所有权保持。
Why: 合成账号合法存在，额度写回不能要求它先变为持久账号。
Canonical source: account-resolver.ts#resolveByAccountRef、account-store-topology.ts#resolveAccountWriteRoot、codex-login-manager.ts#start。
Consumer evidence: `rg -n 'queryAccountQuota|accountToView|syntheticNative|openCodexLoginTerminal' packages/api/src packages/web/src/components/codex-accounts`。
Claim guard: 无持久账号+有效 auth/无 auth/401/500 的路由测试；重建 API 后回读、外部换号隐藏、auto 认证不变；Windows 隐藏/显式可见启动与取消；409 可见且不循环。

验证：先运行新测试观察 RED，再实现 GREEN；保留受影响 API/Web 回归、类型、格式及浏览器交互证据。真实 Windows OAuth、真实浏览器未打开的交互及 macOS 实机另列验收，不用假 CLI 或源码对照冒充已验证。

基线：受影响 API 31 项中 30 通过，既有 `f322-quota-feedback.test.ts` 的 POSIX 假 CLI 诊断用例在 Windows 缺少 called.json；Web 额度反馈 8 通过。该基线失败不作为本次新增回归隐去，也不扩成诊断 carrier 重构。

作者验证（Windows，隔离假账号与假 CLI）：

- RED：新窗口/默认额度测试先复现可见窗口与 409，Web 先复现 409 无反馈；实现后定向 API 43/43、Web 七文件 57/57 通过。
- source/dist 启动参数检查通过；实际 Windows 隐藏 PowerShell 驱动假 CLI 完成登录与退出，显式终端仅成功时退出，失败保留输出。
- 隔离浏览器四条 Codex 旅程通过：后台模式与显式兜底、取消重试、重复身份复用、默认额度刷新后保留且外部换号隐藏。作者检查桌面/移动截图，未使用真实 OAuth。
- API 构建、API/Web 类型检查、改动文件 Biome 错误级检查及 `git diff --check` 通过。
- 扩大 API 回归 73 项中 65 通过，8 个 owner-root 原生能力准入失败；在未修改的相同 next 基线独立 worktree 重跑该文件同样 5 通过、8 失败，均为 `codex_managed_version_unverified`，未扩大本次修复范围。
- 首轮完整浏览器集合中 Claude 旅程的消息 metadata 断言失败；该项随后在 pristine next 与当前补丁分别单独运行均通过。保留完整集合首次失败的记录，不把单独通过冒充完整集合全绿。

浏览器夹具退出后资源租约均释放，但 Windows 对几个测试 HOME 目录返回 EPERM；这些目录还含输入法生成文件，先具名保留，不结束输入法进程或扩展清理范围，运行时与真实凭据不动。
