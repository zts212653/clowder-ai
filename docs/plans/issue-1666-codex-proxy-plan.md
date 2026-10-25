---
feature_ids: []
topics: [codex, windows, proxy, native-tool, issue-1666]
doc_kind: plan
created: 2026-10-22
status: implemented_with_acceptance_gaps
---

# Issue #1666：Codex 企业代理环境兼容修复方案

## 1. 审核状态与工作现场

本文已由 Codex 完成方案审查；用户在本 thread 明确授权：方案通过后交 Claude 实施并提交 PR，
再由 Codex 独立审核验收。实施须包含本次审查补充的安全降级与验证约束，见第 9 节。
PR #1670 已实施；2026-10-23 用户授权修复 CI、恢复隔离环境、执行真实调用与重启恢复验收，
并更新 PR 正文，明确要求暂不合并。最新证据及未覆盖场景见
[本轮验收记录](issue-1666-codex-proxy-validation-2026-10-23.md)。

- 问题：[zts212653/clowder-ai#1666](https://github.com/zts212653/clowder-ai/issues/1666)。
- 相关前置：[Issue #1654](https://github.com/zts212653/clowder-ai/issues/1654)、[已合并 PR #1659](https://github.com/zts212653/clowder-ai/pull/1659)。
- 分支：`feat/issue-1666-codex-proxy`。
- 工位：`G:\AIwork\clowder-ai\worktrees\feat-issue-1666-codex-proxy`。
- 基线：已拉取的 `upstream/main`，`1baaed2e9fadca8b550ae7041ef5a663994ab2d4`，包含 #1659。
- 负责人：Codex；工位保留供审核，2026-10-29 复查，届时不自动删除。
- 已使用独立 HOME、Redis 和端口完成四轮真实 OAuth 调用；临时服务已停止，数据保留。
  main 与生产 runtime 未作开发或部署改动；企业本地 custom provider 场景仍未验收通过。

## 2. 目标与根因判断

目标：Windows 启用企业代理、原生 Codex 使用本地 provider 网关时，通过 Clowder
一键检测/添加后可以首次回复、同会话续聊、重启恢复，同时保留原有外网代理及内网例外。

预期链路：`Codex → 本机 127.0.0.1:端口 → provider 上游`。
失败链路：`Codex → 企业代理 → 企业代理自己的 127.0.0.1:端口 → 504`。
后者是 Issue 中对照实验支持的解释；它表明 Codex 已启动、模型请求失败，不能归为 CLI 未安装。

| 编号 | 事实或判断 | 证据层级与边界 |
| --- | --- | --- |
| E1 | #1666 报告添加 `NO_PROXY=127.0.0.1,localhost` 后，同次 `codex exec` 成功 | 报告者的真实 A/B 记录；本轮未重新在企业网络复现 |
| E2 | #1659 修复原生 provider/账号/HOME 归属，没有补充统一回环代理例外 | 已读 PR diff 与基线源码；该 PR 的 custom provider 成功调用验收仍有缺口 |
| E3 | `buildChildEnv` 继承父环境并合并 overrides，没有默认回环例外 | 已核实 Clowder 源码；缺失 `NO_PROXY` 会原样传入子进程 |
| E4 | 默认代理分支中，非空环境例外会替代 Windows 系统例外的默认载入 | 已核实依赖源码；仅追加几个地址可能改变其他内网请求的路由 |
| E5 | 显式系统代理分支选中系统代理时没有携带环境 `NO_PROXY` | 已核实 Codex 0.163.0 源码；尚未证明现场启用了该分支 |
| E6 | TUI 成功、exec/app-server 失败 | 现象成立；尚不能推出两种模式天生采用不同代理规则 |

同一 Codex 的路径/版本、启动参数、工作目录、HOME/CODEX_HOME、配置层和进程环境都需对齐，
再解释 E6；终端 profile 与桌面程序环境不同只是候选解释，不能预写为已查明根因。

## 3. 修复范围与不变量

1. 先覆盖普通 Codex 的 `native_tool` 与显式账号启动，不全局改变其他 CLI/provider 的网络策略。
2. 只自动补齐回环目标：`localhost`、`127.0.0.1`、`::1`；不自动加入整个私网、远端域名或 `*`。
3. 保留用户已配置的 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`、既有例外及显式账号隔离契约。
4. 保持 #1659 的原生配置权威：不重写 provider、base_url、认证、模型或 HOME，不靠忽略原生配置解决。
5. 网络环境是一次启动的派生结果，不新增成员配置、账号类型、数据库或长期保存的代理状态副本。
6. 注入必须只作用于子进程副本，不修改全局 `process.env`、注册表、系统代理、用户 `.env/config.toml`。
7. 环境改变后，新调用不得复用带旧网络环境的空闲 host；不因刷新代理中断正在执行的会话。
8. 检测到安装、配置可读、网络可达与真实模型成功分别报告，不能把检测通过当作调用通过。

Architecture cell：现有 Codex provider launch / CLI environment / App Server host lifecycle。
Map delta：增加启动环境的纯派生函数及必要诊断，不新增持久化状态或平行代理引擎。
Why：让所有普通 Codex 入口消费同一网络环境，同时保留原生配置与企业网络契约。

## 4. 推荐设计

### 4.1 统一生成 Codex 子进程网络环境

拟新增 `packages/api/src/utils/codex-network-environment.ts`，提供可注入系统例外读取结果的纯合成函数。
在父环境、账号、callback/MCP overlays 与 null 删除语义处理完成后，生成最终环境及无敏感信息的诊断。
不通过 CLI 文件名猜 provider，也不只在 `finalizeCodexAccountEnvironment` 中补一个分支。

接入位置与核查责任：

| 现有位置 | 本次需要保障的行为 |
| --- | --- |
| `utils/cli-spawn.ts::buildChildEnv` | 复用现有继承/删除语义；首版不向所有 provider 无条件注入 |
| `CodexAgentService.ts::prepareCapabilityLaunch` | 能力目录及本地读取入口采用相同 Codex 网络环境 |
| `CodexAgentService.ts` 普通调用及 exec/resume | 所有 overlays 完成后使用合成结果，覆盖首次与续接 |
| `DirectAgentCarrierSession.ts` | 核对实际 spawn 收到的环境，避免再次继承后覆盖已完成的规范化 |
| `CodexUnixWebSocketSession.ts::prepareCodexHostLaunch` | 实际 spawn、auth 检查与 host 复用指纹使用一致的最终网络输入 |
| `DirectAgentCarrierSession.ts::finalEnvironment` 与插件原生隔离入口 | 单独审计；不得为了共用 helper 重新引入父环境或扩大其网络权限 |

先核定环境所有权再决定具体调用点，避免在多个层次重复读取系统状态。
Windows 当前普通聊天使用 direct carrier；host pool 的回归仍需覆盖其他平台已有路径。

### 4.2 合并例外，而非覆盖例外

- 对最终子进程环境中的 `NO_PROXY/no_proxy` 收集、去重后补回环地址；Windows 生成唯一规范键，
  其他平台的大小写别名保持一致，避免不同客户端优先级产生分歧。
- 已有非空环境例外时保留其配置权威；不会再偷偷导入一份不同的系统策略。
- 环境例外缺省或为空、原客户端会读取系统 `ProxyOverride` 时，要保留其有效默认例外。
  实施前须对照锁定 CLI 的真实解析行为；不能把 WinINET/PAC 的所有语法都当作逗号列表转换。
- `ProxyOverride` 的分号、域名模式、`<local>`、空值和异常读取必须有明确测试。
  无法证明等价转换时记录具体未覆盖规则，不自动扩大直连范围或宣称兼容完成。
- 系统例外读取失败、超时，或存在无法证明与原客户端等价的规则时，保留原始启动环境并报告该场景未覆盖；
  不得一边继续注入非空 `NO_PROXY`，一边丢弃尚未读取/转换的原有系统例外。
- 系统读取仅限必要的只读字段；静态例外、PAC/WPAD 和环境例外分别标记来源。
  不将系统代理地址自动复制为全局代理环境，不增加代理认证或自动直连重试机制。

### 4.3 显式系统代理分支作为独立兼容项

Codex 0.163.0 的 `respect_system_proxy` 默认关闭；启用后系统代理优先，
其 `route_from_system_decision` 对系统代理结果使用 `no_proxy: None`。
因此，Clowder 的环境修复本身不能证明覆盖此分支。

实施时先取得该分支的独立复现与有效配置证据。若确认缺陷，准备 Codex 上游修复建议：
在系统/PAC 路由选择中正确处理显式例外，保持 HTTP 与 WebSocket 一致，并补回归测试。
不静默注入 `features.respect_system_proxy=false`，不维护一份未经审核的 Codex 私有二进制。
如需进程级临时关闭，仅作为明确说明影响、单独选择的规避措施；不能当作默认产品行为。

此分支若仍受上游阻挡，交付必须列出版本、阻挡原因、责任与下一步；
只允许声明已经验证的默认分支修复，不关闭整个复杂代理场景的验收。

另外，0.163.0 的 `system_proxy_fallback` 默认开启。其工厂接口仅允许符合条件的 bootstrap
调用进行系统代理重试，不能据此断言普通模型请求也会重试。复现清单须分别记录两个 feature
的有效值；真实 CLI 路由测试保留默认 fallback 基线，再用显式对照确认涉及的请求阶段。
不为得到绿色测试静默关闭任一 feature；尚未追到具体调用点时，重试适用范围标记为未确认。

### 4.4 诊断与用户提示

启动诊断包含：CLI 路径/版本、配置来源、目标是否回环、代理来源类别、例外是否命中、
实际 carrier 与 invocation 标识；不知道实际路由时明确写“未确认”。
代理 URL、内网域名按需脱敏，凭据、认证头及原始代理 HTML 不进入用户提示。

`504 + Proxy Notification` 且目标为回环时，提示可能存在本地请求代理误路由；
普通 504 仍保留其他来源的可能性。沿用现有错误投递/脱敏链，不新增重复错误面板。

## 5. 实施顺序与验收

| 单元 | 可观察结果 | 验证方式 |
| --- | --- | --- |
| A：固定复现条件 | 同 CLI/配置下定位 TUI、exec、app-server 的环境差异 | 脱敏启动清单；读取已有日志，真实调用只补证据缺口 |
| B：环境合成 RED→GREEN | 无例外、原有例外、大小写、null、系统例外均满足不变量 | 新增纯函数回归；先观察失败，再最小修复 |
| C：接入启动边界 | 能力、首次、续接及 host 重建收到同一派生规则 | provider/carrier 接线测试；核实际 spawn 与复用指纹 |
| D：验证真实网络路由 | 本机网关收到请求、假企业代理未收到该回环请求；远端目标仍走代理 | 本地假 Responses 服务与假代理分别计数；覆盖 HTTP/HTTPS 与启用的 WS/WSS |
| E：兼容显式系统策略 | 明确静态代理、PAC/WPAD、feature 开关各自结果 | Windows 隔离用户/测试 VM 或可注入 resolver；不修改用户主机注册表做实验 |
| F：完整使用旅程 | 一键添加后首次成功、同 session 续聊、API/整套重启后恢复 | CLI 0.163.0 真实验收；保留应用/原生 session ID、历史读回及源码/构建标识 |

网络矩阵至少包括：无代理；仅系统静态代理；仅环境代理；环境与系统并存；
既有内网例外；IPv4/localhost/IPv6；`respect_system_proxy` 两种状态；PAC/WPAD；
不可达本地网关、真实上游 504 和代理认证失败的错误区分。
纯 mock 接线不能替代原生 CLI 网络验证，订阅登录成功不能替代 custom provider 验收。

拟新增测试：`packages/api/test/issue-1666-codex-network-environment.test.ts`、
`packages/api/test/issue-1666-codex-proxy-routing.test.ts`；具体拆分按实现职责调整。
基线已有 #1654 启动、F320 账号、native admission、carrier/host pool 与 CLI spawn 回归，按影响面复用。

以下为实施后命令，不代表本轮已经执行；从新 worktree 根目录运行，测试依赖须先按本分支锁文件安装：

```powershell
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api build
pnpm --dir packages/api exec node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test --test-concurrency=1 test/issue-1666-codex-network-environment.test.ts test/issue-1666-codex-proxy-routing.test.ts test/issue-1654-native-codex-launch.test.ts test/f320-native-account.test.ts test/f320-account-consumers.test.ts
pnpm --filter @cat-cafe/api lint
pnpm lint
pnpm check
```

格式化与增量检查使用仓库已声明的 Biome：`pnpm exec biome format --write <本次支持的源码/测试文件>`、
`pnpm exec biome check --diagnostic-level=error <本次支持的源码/测试文件>`。
全仓既有失败需在未修改基线上区分；不靠放宽断言或跳过关键路由用例过关。
本轮纯文档仅运行 frontmatter 增量检查与内容/链接、空白差异核对，不安装依赖或跑应用构建。

## 6. 实例、恢复与交付边界

- 后续仅使用本任务的一套隔离验收实例，启动前查重并登记程序、数据目录、端口、PID 与用途。
  dev Redis 使用 6398 或核定隔离 offset；生产 3003/3004/6399 不参与开发验证。
- 原生 HOME 可能同时包含认证、sessions、索引和 SQLite；优先使用隔离 HOME/状态根。
  共享登录不能冒充原生历史隔离，真实测试会话逐项登记并按已授权规则可恢复归档。
- API 重启与 host 重建分别验证；当前 host 的环境保持不可变，忙碌调用不被强制中断。
  新调用按新指纹创建/选择 host，失效空闲 host 通过现有受控生命周期退出。
- 回退：回退本次代码并重建本任务实例；不靠清数据库、删除历史或修改系统代理回退。
- No-Go：覆盖原生配置、丢失原有例外、扩大直连范围、泄露凭据、跨实例停止进程，
  或用检测/mock/订阅成功替代 custom provider 真实成功。
- 后续作者自验与非作者审查分别记录；用户审核本文不自动授权发布、部署、合并或关闭 Issue。

## 7. 本次请审核的决策

1. 是否接受首版限定 Codex、统一启动环境派生与诊断，而不全局改动其他 CLI？建议接受。
2. 是否接受保留原有内网例外、外网代理及原生配置作为必需验收条件？建议接受。
3. 是否接受显式系统代理/PAC 问题独立取证，必要时依赖上游修复，且不静默关闭该功能？建议接受。

审核后的下一步是按上述范围补 RED 与实现；未决的解析兼容细节由实现者先通过源码和实验收敛，
涉及缩减承诺、扩大网络权限或更换 Codex 分发物时再提交具体决策，不将超时视为批准。

## 8. 来源与证据索引

- [Issue #1666](https://github.com/zts212653/clowder-ai/issues/1666)：现象、CLI 0.163.0 与 NO_PROXY 对照记录。
- [PR #1659](https://github.com/zts212653/clowder-ai/pull/1659)：配置归属修复、已合并状态与 custom provider 验收缺口。
- [Clowder buildChildEnv（本文基线）](https://github.com/zts212653/clowder-ai/blob/1baaed2e9fadca8b550ae7041ef5a663994ab2d4/packages/api/src/utils/cli-spawn.ts#L320)：环境继承与覆盖。
- [Codex 0.163.0 Cargo.lock](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/Cargo.lock)：依赖版本锚点；包含 reqwest 0.12.28、hyper-util 0.1.20。
- [reqwest 0.12.28 代理实现](https://github.com/seanmonstar/reqwest/blob/v0.12.28/src/proxy.rs#L514)：默认代理委托 hyper-util 的 system matcher。
- [hyper-util 0.1.20 Windows 默认代理](https://github.com/hyperium/hyper-util/blob/v0.1.20/src/client/proxy/matcher.rs#L664)：环境例外为空时才载入 ProxyOverride。
- [Codex 0.163.0 系统路由](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/http-client/src/outbound_proxy.rs#L364)：显式系统代理选定后的 no_proxy 行为。
- [Codex 0.163.0 feature 默认值](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/features/src/lib.rs#L1457)：respect_system_proxy 默认关闭。

## 9. Codex 方案审查与实施交接（2026-10-22）

结论：方案方向通过，可交 Claude 实施。审查没有发现需要推翻设计的 P1 问题；下列两项 P2
方案缺口已在本文补齐：无法保留系统例外时的安全降级，以及默认开启的 bootstrap fallback
对应的复现基线。本文通过仅指允许实施，不代表代码、网络路由或完整使用旅程通过。

审查对象：原始文档 SHA-256 `8b1255713167da3f37bf48abafa0136ea5b8e3f0e441845421050038f60359f0`；
源码基线 `1baaed2e9fadca8b550ae7041ef5a663994ab2d4`。
授权来源：本 thread 用户消息 `0001792598867684-000234-ca6903da`。

### 接入与回归要求

Canonical source：现有 `utils/cli-spawn.ts#buildChildEnv` 负责继承/删除，Codex 网络规则只在
Codex 自己的最终启动边界派生；新增 helper 不取得账号、认证、插件隔离或系统策略的所有权。

Consumer evidence：在本基线执行以下命令，定位能力/本地读取、普通 exec/app-server、实际
direct spawn、host 签名/auth/spawn 及插件隔离入口。作者须随最终 diff 更新定位与接线证据。

```powershell
rg -n "prepareCapabilityLaunch|createDirectAgentCarrierSession|spawnCli\(|prepareCodexHostLaunch|normalizeEnv|finalEnvironment|inheritParentEnv" packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts packages/api/src/domains/cats/services/agents/providers/DirectAgentCarrierSession.ts packages/api/src/domains/cats/services/agents/providers/CodexUnixWebSocketSession.ts packages/api/src/domains/cats/services/agents/providers/codex-plugin-native-launch.ts packages/api/src/utils/cli-spawn.ts
```

本轮定位：`CodexAgentService.ts` 的 1381/1385、1414/1460、2292、2399、2621 行；
`DirectAgentCarrierSession.ts` 的 23/26/56 行；`CodexUnixWebSocketSession.ts` 的
51/58/213/237 行。当前 host 签名只覆盖传入 overrides，而实际 spawn 再继承父环境；
必须防止网络环境在签名之后被重新继承改变。插件原生入口从最小 env 开始，不能为共用网络
helper 重新引入父环境或系统网络策略。

Claim guard（作者先 RED 后 GREEN，按行为断言，不能只做源码文本匹配）：

- 原有代理与例外保留：大小写冲突、null 删除、空值、`*`/域名模式/`<local>`、读取失败，
  以及回环/远端对照；修改输入会丢例外或扩大直连时必须失败。
- 全入口接线：在最终实际 spawn 检查环境；覆盖普通 native_tool、显式账号、能力/本地读取、
  exec/resume/direct/host，插件隔离路径另设“不重新继承”的反例。
- host 生命周期：改变有效代理或例外后不得复用旧空闲 host；不改变网络环境时保留正常复用；
  忙碌 host 不被环境刷新强制中断，复用现有 host-pool 生命周期测试。
- 真实网络证据：锁定 CLI 0.163.0，分别统计本机网关与测试代理接收请求，覆盖本地直连与
  远端仍走代理；bootstrap 与模型阶段分开记录。Mock 或作者摘要不能代替此证据。

### 外部来源核验记录

| Claim | 一手来源与版本 | 本轮结论与适用范围 |
| --- | --- | --- |
| NO_PROXY 可解除现场回环误路由 | #1666 报告者原始 A/B 描述，2026-10-22 远端回读 | use-with-caveat；尚未独立重现企业网络，不能推出 TUI 与 exec 固有差异 |
| 非空环境例外会替代 Windows 默认例外读取 | hyper-util v0.1.20 `matcher.rs#win::with_system` | use；代码以 `builder.no.is_empty()` 决定是否加载 ProxyOverride；只适用锁定依赖路径 |
| 系统代理选中后没有传入环境例外 | Codex rust-v0.163.0 `outbound_proxy.rs#route_from_system_decision` | use；`SystemProxyDecision::Proxy` 使用 `no_proxy: None`，不是所有路由都忽略例外 |
| respect_system_proxy 关闭、system_proxy_fallback 开启 | 同 tag `features/src/lib.rs`，`core/src/config/mod.rs` 与 `http-client/src/outbound_proxy.rs` | use；源码默认值成立，现场有效值及 bootstrap 调用覆盖需实测 |

以上来源为上游维护者代码或问题报告，没有使用博客互引。Non-triviality：not-compared，
本轮是兼容性审查，不主张新能力；Decision fit：实现方向 direct，企业网络与完整旅程验收
partial。当前官方配置文档未检索到 `respect_system_proxy`，不能用当前文档代替版本源码。

补充来源：

- [0.163.0 工厂与 bootstrap fallback 边界](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/http-client/src/outbound_proxy.rs)。
- [0.163.0 配置到客户端工厂接线](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/mod.rs)。
- [0.163.0 features](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/features/src/lib.rs)。

当前无代码 diff，fallback 新增层数为 0；实现后由 Codex 对最终 PR HEAD 运行 fallback
检测并给出独立结论。作者提交 PR 时附测试、原生路由与恢复证据，并在本 thread 向 Codex
发出 review 请求；合并、部署、关闭 Issue 仍不在本次授权内。
