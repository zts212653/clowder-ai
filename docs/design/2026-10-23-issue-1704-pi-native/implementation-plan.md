---
feature_ids: []
related_features: [F241, F289]
topics: [pi, acp, sessions, recovery, diagnostics, issue-1704]
doc_kind: plan
created: 2026-10-23
status: proposed
---

# 实施计划：冷恢复与首轮空响应同步闭环

本计划于方案阶段编写，用户随后批准按推荐路线实施并提交 PR。以下保留已接受的工作单元；实际执行状态与分层证据见[实施报告](implementation-report.md)，不能把计划要求当成已完成验证。目标、兼容和状态契约见[推荐设计](recommended-design.md)，全部验收项见[证据与验收](evidence-and-acceptance.md)。

## 顺序与交付组织

建议一条 Pi 修复分支，按“契约/持久化 → 精确恢复 → 空响应 → 集成”提交可审阅变更；首轮异常取证可从 W0 开始。W3 的事件修复可独立于 W1/W2 验证，但最终通过同一 Host 用户旅程验收。

| 单元 | 依赖 | 可观察产物 |
| --- | --- | --- |
| W0 契约与技术验证 | 最新 main/相关 PR 再核对 | 固定 ID、scope、版本门槛、写者互斥和错误映射；已知失败用例 |
| W1 原生状态与新建 | W0 | 新会话写入受信根，ID 原生一致，close 保留文件 |
| W2 精确 load 与生命周期 | W1 | 池回收/Host 重启后恢复同一历史，当前 MCP 可用 |
| W3 首轮输出与错误 | W0 | 空 delta/final 文本修复，空完成和真实错误分类准确 |
| W4 集成、独立审阅和包 | W2 + W3 | 定向检查、真实调用、MCP、最终安装包证据 |
| W5 企业机复验与 issue 收口 | W4 | 分别确认冷恢复及首轮空响应的结果和未决项 |

不为验证分步长期运行多套实例；已有复现可复用，新增模型调用只覆盖新增实现/未覆盖疑点。

## W0：把关键假设变成可执行契约

改动前核查位置：`pi-acp-bridge.ts`、`pi-acp-session.ts`、`AcpClient.ts`、`AcpAgentService.ts`、`native-session-defaults.ts`、`AcpServiceFactory.ts`、`acp-pool-signature.ts`、Windows bootstrap policy 及所有 sessionId 消费方。完整路径索引见证据页。

1. 重新 fetch 并记录实现 HEAD；复查 #104、fork #14、#1596 的状态和实际文件差异，先合并兼容意图，避免重复实现。协调公开评论/其他聊天需另有用户授权，本计划不自动发消息。
2. 对 Pi 1.3.0 验证自定义 ID、指定目录、精确文件 load、惰性落盘、`cancelled`、cwd 和版本行为；不推定所有 Pi 版本支持相同协议。确定本修复支持的最低能力门槛和不支持时的明确失败。
3. 普查 sessionId 存储、显示、路由、长度/字符校验及恢复；锁定不透明 ID 契约、scope 稳定性和显式账户/原生 profile 更换边界。
4. 验证双桥/双 Host 写者互斥、父桥崩溃而 Pi 子进程仍活着、锁回收及 Windows 路径/ACL；核对原生历史中的 MCP 工具身份与重启后命名。选择已有可靠原语或窄范围互斥实现，不引入泛用会话框架；没有证明前不启用 load。
5. 固定 Host `empty_response`、Pi 明确错误、取消、handled、终止前退出的映射，防止仅在 bridge 单测通过、Host 却退化为另一错误码。

RED：补出实际桥重建后 load 不支持、空 delta 后 final 文本丢失、跨写者竞争的精准检查；观察失败原因。W0 输出“已证实/待解决/最终选择”记录，不把技术验证脚本当正式修复。

## W1：建立原生持久化与新建

预计修改：Pi provider 下新增窄职责 session storage/ownership 模块，调整 `pi-acp-session.ts`；`AcpServiceFactory.ts` 注入受信根/scope，必要时调整 `acp-pool-signature.ts`、准确的 bootstrap matcher。文件遵守 200 行警告/350 行硬限；拆分按职责，不搬入完整外部适配器。

1. 用当前 `resolveCatCafeDataRoot()` 建立确定的目录派生与 ID 格式，补路径边界/同 ID 重复/cwd/scope 测试；不建立第二 transcript store。
2. 新建先取得所有权，再以显式 ID 和目录启动 Pi；删除 `--no-session`，回读 native ID/文件身份后返回。失败只停止本次归属子进程，保留已写原生历史。
3. 区分无 prompt 的 provisional 与真实持久历史；native defaults probe 不发模型请求，也不产生用户对话；close 不删除 JSONL。
4. 仅给准确内置桥注入参数，不影响外部 `pi-acp` / `clowder-pi-acp` / 其他 ACP 工具。确认新参数参与池/启动审计，不把不受信 command 纳入白名单。

GREEN：真实 Pi + 可控接口首轮后文件可读、header 与 ACP ID 一致；close 后文件保留。覆盖中文/空格路径、权限拒绝、目录冲突、默认数据根与显式根；原用户 Pi 配置哈希不变。

## W2：精确恢复、当前 MCP 与并发

预计修改：`pi-acp-bridge.ts` 增加 `session/load` 和能力声明；`pi-acp-session.ts`/storage 模块增加恢复工厂及身份验证；`pi-rpc-process.ts` 只补必要运行契约。原则上不改通用 `AcpClient` 的失败回退。

1. load 只接受版本化 ID 和当前受信 scope。读取准确原生文件、核验 header/cwd，取得互斥后启动；missing/corrupt/duplicate/out-of-root/legacy 均不能走 new。
2. 回读原生 ID 和 sessionFile；switch 被取消、Pi 仍忙或身份不符时恢复失败。成功后纳入同桥 sessions Map，重复 load 复用/合并；同 session prompt 保持串行。
3. 重建当次 MCP extension，使用跨重启稳定的 session 级 server/tool 身份，覆盖名称碰撞；刷新 credential-file 所指凭据，不恢复旧 env/token。结构/权限变更仍受绑定校验；测试模型/effort 与既有配置策略一致。
4. 将 `loadSession:true` 与真实实现一起发布。保留 restricted policy 的 fail-closed、close/cancel 和 `agent_settled` 终止边界。
5. 经真实 AcpProcessPool 注入短 TTL 触发 eviction，再从 Host service 恢复；再做 Host 重启。补并发 load、崩溃残留写者、损坏文件及旧 UUID 的边界测试。

GREEN：恢复前后同 native ID，provider messages 包含首轮测试词，MCP 在恢复后使用新调用凭据成功读写；恢复失败 provider 请求数为 0、旧绑定和消息未被替换。

## W3：首轮空响应与错误诊断

预计修改：`pi-acp-events.ts`、`pi-acp-session.ts`、`pi-rpc-process.ts`；若 Host 需要消费新增错误数据，只增加 Pi 专属最小映射及相应集成测试，不重做 ACP/DSH 错误框架。

1. 对照 fork #14 的 Pi 片段与测试，确认可复用范围和当前差异；保留原贡献来源，不复制无关 DSH/profile/account 改动。
2. 将实发文本、最终文本快照、tool 输出、终止和错误分开追踪；空/空白 delta 不得阻断有效 final content，正常流式 final 不重复，多个 assistant/tool 阶段不丢累计有效输出。
3. 覆盖正常空完成、thinking-only、tool-only、显式 provider 错误、RPC `success:false`、handled、cancel、早退出、超时。保证 `agent_settled` 前不会误报任务成功。
4. 保留 RPC 拒绝细节与有界 stderr，复用 sanitizer：先脱敏再截断，只输出白名单关联元数据；禁止 raw stderr、完整 env 或 prompt 落盘。
5. 经真实 `AcpAgentService.invoke()` 验证：有效 final 有文本；真正空完成仍是 `empty_response`；明确错误携带真实脱敏原因；不自动重试、不切新 session、不强设默认模型。

GREEN：桥单测与 Host 分类同时通过。企业机首次空响应在取得同版本事件链前仍标为“实际触发原因未确认”，不能仅凭错误变清楚判定解决。

## W4：集成、自检、独立审阅与安装包

测试文件沿用现有 `.test.js` 发现机制。拟新增的 `pi-native-session-recovery.test.js` 等名称是计划项，落地时须证明进入公开测试集合；不能写了测试却未被 CI 发现。

以下命令来自当前 `package.json` / 现有测试包装器；路径以本工位为根，执行前安装本分支依赖。每次编译使用当前源码，不能复用前轮 dist。

```powershell
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/api build
pnpm --filter @cat-cafe/api lint
pnpm biome format --write <本次修改的TS和JS文件>
pnpm biome check <本次修改的TS和JS文件>
```

构建、类型和格式检查预期 exit 0；占位文件列表需替换为实际清单，不在整个仓库运行自动修复。完整终态检查为 `pnpm check`；基线红灯须单列来源与受影响范围，不掩盖新增失败。

在 `packages/api` 下运行现有回归集，Windows 先把 TMPDIR 指向本任务已有的独立临时目录，避开包装器 `/tmp` 映射问题：

```powershell
New-Item -ItemType Directory -Force -Path '.cat-cafe/issue1704-test-tmp' | Out-Null
$env:TMPDIR = [System.IO.Path]::GetFullPath('.cat-cafe/issue1704-test-tmp')
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test test/pi-acp-bridge.test.js test/pi-rpc-process.test.js test/native-acp-session-cache.test.js test/native-acp-resume.test.js test/native-pi-discovery.test.js test/acp/acp-process-pool.test.js test/acp/acp-pool-signature.test.js
```

新增测试按实际文件加入上述集合；涉及注入/bootstrap 时补跑 `test/acp/acp-pool-registry.test.js`、`test/acp/acp-bootstrap-startup-policy.test.js`、`test/native-runtime-routes.test.js`；涉及错误投影时补跑 `test/route-message-metadata-persistence.test.js`、`test/route-serial-error-persistence.test.js`。预期全部通过且没有生产 Redis/原生 HOME 写入。

随后按验收矩阵完成真实 Pi + 可控接口、少量真实自定义 LLM、真实 MCP，以及最终包路径的 UI/重启验证。逐项记录源码 SHA、包 SHA-256、Host/Pi/bridge 版本、入口、端口、PID、状态根、native sessionId、归属测试会话和日志脱敏状态。

质量自检后按风险安排独立审阅；本作者不能自审。只有形成完整证据后再按既有门禁决定 PR/合入，不能以相关 PR 已合入代替本修复验收。

## W5：企业机复验与分别收口

1. 以实际安装包和进程 argv 确认仍走内置桥；精确记录版本、根目录、模型协议及脱敏运行链。不能仅凭 `Get-Command pi.ps1` 判断真实子进程入口。
2. 新建隔离测试会话：首轮 → 热续聊 → 受控回收/重启 → 同 ID 冷恢复 → 当前 MCP 调用；回读应用历史及原生文件，不触碰业务会话。
3. 对首轮空响应采集 admission、message_end、stopReason/error、agent_settled 和 ACP 更新的关联元数据；按现场证据确认诱因。若是自定义网关/模型兼容问题，再补准确修复和回归；不预先归因于 ACP。
4. 输出两项状态：冷恢复是否通过；首轮空响应是否找到并消除实际原因。仍缺现场证据时只关闭已经验证的子项，#1704 保留未闭合范围。
5. 后续获准更新 GitHub 时使用 UTF-8 无 BOM 文件发布并立即 API 回读；本轮不发布评论。

## 数据保护、回退与收尾

实施前登记唯一交互验收实例；开发 Redis 使用 6398 或独立测试实例，不连接 6399，不占 3003/3004。真实 Pi 使用独立原生状态根；如需共享用户原生 HOME，先明确其历史/SQLite 影响和用户认可的收尾方案。

只停止本任务已确认归属的进程，核对监听释放。所有配置、原生历史、应用消息、绑定和测试持久数据保留；测试目录不能以“清理”为由递归删除。最终记录已停止对象、仍保留环境及理由、用户环境健康/历史回读。程序回退遵循设计中的版本限制，不删除新会话文件以兼容旧包。
