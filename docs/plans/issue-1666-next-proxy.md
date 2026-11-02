---
feature_ids: []
topics: [codex, proxy, windows, issue-1666]
doc_kind: plan
created: 2026-11-03
---

# Issue #1666：在 next 收敛最终子进程环境

来源：[Issue #1666](https://github.com/zts212653/clowder-ai/issues/1666)、
[旧 PR #1670](https://github.com/zts212653/clowder-ai/pull/1670) 的源码、方案、
2026-10-23 验收及本地 2026-10-29 审查记录；本轮用户明确要求最小移植、独立审核和不合并。

## 基线与采用判断

- 初始基线 `upstream/next@917120d55bb5bf618a3cc49c0749d5f5172ace46`；upstream 为 zts212653/clowder-ai。
- 旧 PR OPEN、base=main、HEAD=4acc3ef82671e99619d43dc955ab7573e6cfd3c1；37 提交、22 文件。
- 当前认证用户与旧 PR 作者均为 whutzefengxie-ops；本轮是获授权的作者修复，不是正式批准。
- 旧工位有 CURRENT_STATUS.md 和未提交审查文档，不变基、不清理、不改写其分支。
- 后续 #1659 的原生配置路由、F320 账号 finalizer、已有 host 生命周期和
  buildChildEnv 的 inheritParentEnv=false 已在 next；未发现 #1666 的网络派生覆盖。
- #1097 在飞且碰 CodexAgentService，但范围是 CLI 解析和下载；不搬入其实现。
- 采用必要的环境修复，建立独立替代 PR，保留旧 PR；不移植旧 482 行网络模块及全部历史。

## 当前调用链和环境权威

1. CodexAgentService：原生 native_tool 保持 CLI 配置权威；显式账号由
   finalizeCodexAccountEnvironment 决定 HOME、认证和 null 删除。
2. invoke：callback → 账号 → MCP bearer / RUST_LOG → 账号 finalizer → 最终网络派生。
   capability 的 prepareCapabilityLaunch 在账号 finalizer 后接同一派生。
3. buildChildEnv 是唯一继承/净化权威；网络函数只接收其完整结果并派生 NO_PROXY。
   不重新解析 provider 配置，不切换 model_provider、不覆盖认证。
4. exec/resume → spawnCli；app-server → DirectAgentCarrierSession 或 host pool；
   外部 carrier factory → tmux writer。完整环境均传 inheritParentEnv=false。
5. prepareCodexHostLaunch 先净化和去除 session 环境，再由该快照生成签名、读认证及 spawn。
   部分环境的老调用方仍默认继承；准备后的 host launch 禁止二次继承。
6. DirectAgentCarrierSession 复用既有 finalEnvironment 接口，普通 session 的新继承标记
   交现有 buildChildEnv 消费；不增加第二份缓存环境。

## 已识别的失败边界（必须先 RED）

- host 签名当前只包含 overrides，auth 与 spawn 各自继承父环境：父代理改变可能复用旧 host。
- host 去掉 callback 键后仍允许父环境继承，必须保证 ambient callback 不进入共享进程。
- 最终完整环境缺失的键会在 direct、host、tmux 下重新继承；null 删除不能在传输中丢失。
- NO_PROXY 缺失或大小写别名不一致时，回环请求可能进入企业代理；先测最终实际子进程。
- 以上用生产入口的行为回归确认；真实企业 504 的因果结论仍需本地 provider/代理计数。

## 最小修改范围与复用点

| 文件 | 必要修改 |
| --- | --- |
| utils/codex-network-environment.ts（新增） | 小型纯派生 + canonical buildChildEnv 接入；无缓存 |
| utils/windows-system-proxy.ts（新增） | 从旧 PR 复用 WinHTTP 只读查询，内嵌脚本随 dist 分发；单进程有界读取静态例外与 PAC/WPAD |
| CodexAgentService.ts | 两个最终边界接线；完整环境标记；直接 carrier 消费同一快照 |
| types.ts | 复用 inheritParentEnv 语义到 carrier options |
| DirectAgentCarrierSession.ts / CodexUnixWebSocketSession.ts | 完整环境到真实 spawn；签名/auth 一致 |
| tmux-command-file.ts / tmux-agent-carrier-session.ts | 透传继承标记，复用已有 env -i 启动 |
| test/issue-1666-*.test.js（新增） | public CI 自动发现的行为回归，单文件不超过 350 行 |

不修改通用 buildChildEnv 策略、数据库、全局环境、原生配置或代理管理服务。
新增模块、脚本、测试、文档均不超过 350 行；已有超限的大文件只作必要接线，不夹带重构。

## 网络策略与支持边界

- 合并有效 NO_PROXY/no_proxy/混合大小写条目，去重并补 localhost、127.0.0.1、::1；
  不加入整个私网、0.0.0.0 或通配直连。Unix 的标准大小写值一致，Windows 规范为唯一键。
- 已有非空环境例外有权威，不导入系统例外；HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 不改。
- Windows 无环境例外时才读取系统状态；只采用可保真的 IPv4 字面量与已承诺的回环例外；系统 hostname 精确规则不转为域后缀。
  通配符、<local>、地址段、端口及其他不能保真的形式保留原环境。
- PAC/WPAD、读取失败/超时/未知分别返回无敏感值的诊断并保留原环境。
  空 NO_PROXY 与没有 NO_PROXY 分别测试，均不能当作已知无系统例外。
- 插件原生最小环境不重新继承宿主，不查询宿主系统代理，不扩大网络权限。
- respect_system_proxy 等原生开关不改；本修复不承诺显式系统代理、PAC 或任意 CLI 版本兼容。

## 验证与实施顺序

1. 基线 API build；生产 prepareCodexHostLaunch / DirectAgentCarrierSession 复现失败，
   保留 RED 日志；加普通调用、续聊、capability 及 tmux 的接线回归。
2. 最小实现后，同组检查 GREEN；正常对照覆盖代理保留、已有例外、账号和原生配置权威。
3. 环境改变后的 host idle/resume 重建复用已有 retirement，不新增重试或生命周期状态。
   active host 行为沿用现有测试，不为代理变更中断正在执行的调用。
4. 新测试全部使用 .test.js、dist 生产入口，核 public resolver/shard plan，远端 CI 回读实际执行。
5. 当前脚本验证：pnpm --filter @cat-cafe/api build；pnpm lint；pnpm check；
   定向 node --test 经 packages/api/scripts/with-test-home.mjs，禁用共享状态预检并设 Redis 端口 0。
   格式仅对本次文件执行 pnpm biome check --write <files>，不批量改无关文件。
6. 真实验证：固定 CLI、独立 HOME/SQLite/工作目录；受控企业代理路径与真实本地 provider
   首次/续聊成功、网关和代理计数、远端代理对照。OAuth/openai 或假 Responses 不计完成。
   本机配置端口 15721 未监听，先请求可用网关；期间完成独立工作。
7. 自查最终 diff/测试和脱敏，再交非作者 exact-HEAD review；作者自查不算 Approval。
   PR base=next，不合并、不部署、不关闭 Issue。

## 自查、成本与回退

Architecture cell：Codex 启动环境 / carrier / 共享 host 生命周期。
Map delta：环境从部分覆盖变为完整快照；没有新增持久化状态或服务。
Why：签名、认证和实际子进程必须对同一环境作决定。
Canonical source：buildChildEnv、finalizeCodexAccountEnvironment、prepareCodexHostLaunch。
Consumer evidence：rg 'buildChildEnv|inheritParentEnv|createDirectAgentCarrierSession|writeAgentCommandFile' packages/api/src。
Claim guard：最终环境删除键不重现 → 实际 direct 子进程输出与 host snapshot、tmux writer 行为测试。

自查结论：可实施；不复用旧 PR 的重复状态、完整诊断框架和路径探测回退。
Windows 检测仅在缺少明确环境例外时增加一次有界只读探测；无常驻进程、后台轮询或自动重试。
不能可靠转换时保留现场，代价是该场景仍可能失败，必须报告未验收而非“完整支持”。
回退为 revert 本 PR 的代码提交，不需要迁移或清库；现有进程自然结束后新启动恢复旧环境策略。
实例台账保存在任务 artifacts，启动前查重，结束受控停止，仅保留隔离数据和证据。

### 独立审查修订：系统 hostname 不可保真转换

非作者发现 P2：WinINET 普通 hostname 例外与 NO_PROXY 的域后缀语义不同。
先以 api.corp.fixture 的生产纯函数回归观察 RED，再限制转换为 IPv4 与回环条目。
含 hostname 的系统规则整体保留原环境；已有显式环境 NO_PROXY 继续保持其权威。
来源：[微软 WinINet 例外说明](https://learn.microsoft.com/en-us/windows/win32/wininet/enabling-internet-functionality#listing-the-proxy-bypass)、
[reqwest NoProxy 规则](https://docs.rs/reqwest/latest/reqwest/struct.NoProxy.html#method.from_string)。

### next 在收尾时前进：1016aa7a

初版 CI 与独立批准完成后，next 合入 #1762，当前基线更新为
1016aa7a316566893cacef84d49792a8ced0f0c8。452 文件的上游增量涉及 role/client、账号与 MCP。
未搬入上游之外的新功能；合并最新 next，保留本轮全部历史，未改写旧工位或旧 PR。
冲突只有 CI、Windows Smoke 的相邻新增步骤及 CodexAgentService 的相邻 import，均同时保留。
其余代码自动合并后再核最终环境边界；上游未覆盖 NO_PROXY 派生、direct/host 禁二次继承。
Direct/host/buildChildEnv 的相关基线源码未变，原 RED 仍适用；新基线的类型、回归、CI与独立 review 必须重新绑定最终 HEAD。
