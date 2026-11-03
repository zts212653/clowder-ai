---
feature_ids: [F320]
topics: [windows, codex, oauth, accounts]
doc_kind: plan
---

# Windows 新增 Codex OAuth 账户：支持条件与职责

关联：[#1810](https://github.com/zts212653/clowder-ai/issues/1810)、[PR #1812](https://github.com/zts212653/clowder-ai/pull/1812)。本文描述公共产品合同、实现边界及复现方法。

## 用户旅程

用户在指定账户行明确点击添加、登录或重试后，本次尝试在独立凭据目录运行已经过能力检查的同一份官方 Codex CLI。Clowder 打开终端；浏览器和 OAuth 授权由官方 CLI 与用户处理。

官方登录完成后，Clowder 核对官方状态以及账户、工作区身份，再按既有规则采用凭据。相同身份沿既有复用规则处理，不同身份进入确认流程。备注、成员绑定和重启恢复仍属于原账户合同。

失败或取消应保留原账户条目及可读原因，支持从原条目恢复。旧尝试的结果不得覆盖重试，失败不得替换默认账户；清理仅针对本次拥有的 worker、CLI 及其后代，其他活 owner 不接管。

## 修复前的复现与原因

1. 在原生 Windows 的账户页添加 Codex OAuth 账户，并点击登录或重试。
2. 账户进入 preparing 后异步失败，没有启动终端或浏览器。
3. 平台检查返回 `codex_managed_platform_unsupported`，原错误映射却把它显示成版本或组织策略不支持。

原实现的准入仅允许 macOS，终端依赖 `osascript`。Windows 还需要处理 npm `.CMD` carrier、版本查询和 capability probe 的进程、路径与传输差异，因此只移除平台判断不足以修复旅程。

## 实现职责

| 位置 | 职责与约束 |
|---|---|
| `codex-managed-support.ts` | 平台、原生 carrier 同一性、组织策略及 exact CLI 能力准入 |
| `codex-login-driver.ts` | 独立尝试目录、有效 OAuth 配置校验、Windows PowerShell 终端及 worker 启动回执 |
| `codex-login-terminal-worker.ts` | 复用 Windows spawn adapter 执行 login/status；取消时回收拥有的进程树 |
| `codex-login-manager.ts` | 既有队列、尝试版本、身份采用与恢复；Windows owner 出生时间及准确的失败原因 |
| `codex-launch-config.ts` | 按平台定位系统与 legacy 配置，合成有效配置及其来源 |
| `codex-native-compat` | Windows managed probe 使用 stdio、临时目录和隔离环境；正常关闭 writer，按平台与 probe revision 区分测量结果 |

`preparing` 只表示尝试已登记，worker 回执后才进入等待登录。终端出现、CLI 零退出或 `auth.json` 存在，均不能单独作为采用成功的依据。

独立凭据与共享原生 state/config/SQLite 沿用既有合同。验证共享行为时，测试所用的所有根均须隔离；不得借用宿主登录或复制刷新凭据来完成新账户登录。

## 平台与策略前提

- Windows carrier 可以是原生 `.exe` 或受支持的 npm `.CMD` shim，版本、probe、login 和 status 使用同一命令选择及 spawn 规则。
- managed layout 仍要求相应链接能力；无权限的标准用户场景由 [#1709](https://github.com/zts212653/clowder-ai/issues/1709) 单独跟踪，不能外推为所有 Windows 用户已支持。
- Windows 系统 `config.toml` 位于 `%ProgramData%/OpenAI/Codex`，作为普通 defaults 参与有效配置合成。普通 model 默认值本身不导致拒绝；无效 TOML、有效 API-only、外部 endpoint/provider 冲突在启动登录前拒绝。
- requirements、legacy managed 及其他强制策略沿既有拒绝规则处理。私有 home 不得遮蔽原 home 的强制策略；读取失败与不存在必须区分，读取不明时拒绝。
- 保留 macOS 原入口与策略规则。某一 CLI 版本或一种安装形式的通过结果，只适用于该测量范围。

## 并发与验收边界

临时 HOME 不能隔离真实 OAuth 回调端口。已知另有真实登录在途时，先让其完成，再由用户重试。不得为诊断启动第二个真实 login、发送试探性回调/cancel，或按端口占用猜测 owner。

跨 API 进程的最终授权归属仍由 [#1811](https://github.com/zts212653/clowder-ai/issues/1811) 跟踪。本补丁不承诺全机登录锁，也不以第二个进程的输出推断回调或凭据归属。

假 CLI、source/dist worker、进程清理、临时策略样本及无凭据能力检查可以支持有界源码审查。安装包可见终端/浏览器、真实双身份 OAuth、默认账户保持、真实调用归属、重启续聊与 macOS 实机验收分别记录，不能由 fixture 或 CI 代替。具体步骤见[验证与验收边界](issue-1810-windows-codex-validation.md)。
