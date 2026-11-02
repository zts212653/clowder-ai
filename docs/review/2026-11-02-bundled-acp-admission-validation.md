---
feature_ids: []
topics: [plugins, acp, bundled-packages, regression]
doc_kind: verification
created: 2026-11-02
---

# 内置 ACP 插件准入：实施与验证记录

## 目标与边界

来源：[插件仓 Issue #178](https://github.com/zts212653/clowder-ai-plugins/issues/178)；[已批准方案](../plans/2026-11-02-issue178-bundled-acp-admission.md)。PR 目标为 `next@74b5bfd4d59c3722c76140d9df36e332b72a0acd`，本轮不合并，不打包 EXE。

Architecture cell：`plugin`，复用既有包准入、carrier、配置存储和 ACP provider。Map delta：none；没有新增架构所有者。五轴风险：包安装行为有变；数据无迁移；保留摘要、注册表、隔离和本机 owner 鉴权；固定连接声明增加可配置字段与默认拒绝权限；代码可回退，无不可逆数据操作。

`next` 尚未包含 develop 的固定客户端连接能力。本次仅移植 #1745 中必要的声明解析、连接覆盖、权限决策和 root-only 恢复，未整体合入角色重构或 #1762。固定客户端继续使用 manifest 的普通 string 配置字段；多客户端目录的编辑器契约不变。

## 根因与修改

- 旧安装器将 `distribution=bundled` 等同于 `runtime.transport=builtin`，纯 ACP 声明包在启动原生程序前即被拒绝。新规则仅接纳原有 builtin 或无 runtime 且具有合法 ACP 声明的包；不按客户端名称分支。
- 构建与安装共用同一声明解析/准入规则，构建将声明实际打入归档；没有 icon 的声明包不必伪造 SVG。坏构建输入保留上一次输出，`--check` 只读。
- 包仍需注册身份匹配、SRI、完整归档预检、路径/类型检查、manifest 身份/版本及 inventory 生命周期校验。损坏摘要保留隔离，不提供重试绕过。
- Windows 系统 tar 的 CRLF 列表留下尾部 CR，使静态读取器找不到 canonical manifest。仅识别行分隔符，不放宽归档路径规则；后台 tar 调用隐藏窗口。旧测试的 URL pathname 改用 fileURLToPath，保留原有断言。
- install/update/upload 失败各记录一次安全 warn，带 reqId、操作、可用来源/标识及公开错误码，不记录 body、命令参数、路径、认证和 cause。

## RED 证据

1. 新增真实 catalog 路由测试在旧门禁返回 422 / UNSUPPORTED_TRANSPORT，错误为 `bundled archive must retain its builtin runtime`。
2. 构建测试在旧 producer 上发现归档缺少 `package/agent-provider.json`。
3. 诊断测试在旧路由得到 0 条失败日志，期望 3 条。
4. Windows tar 列表测试在修复前得到 `package/manifest.json\r`，无法匹配应有成员名。

## 已执行的验证

本机 Windows，Node 24.16.0。命令从本 worktree 执行；测试统一使用 `packages/api/scripts/with-test-home.mjs`，不启动或连接共享 Redis。

| 检查 | 结果及含义 |
| --- | --- |
| `bundled-acp-admission.test.js` | 最终 9/9（含成员投影、再启用）。两客户端真实 catalog 路由及同字节上传、启用/停用、瞬时下载失败重试、失败更新后合法更新、坏摘要隔离、非法声明负例、不同名称客户端 |
| 构建/准入/路由/权限/恢复组合回归 | 121/121。包括 source/compiled producer、check 只读、坏输入保留旧输出、canonical gzip/闭包、固定连接与 root-only 恢复、CRLF、旧 builtin/身份/摘要/资源、日志脱敏 |
| 声明/目录/生命周期/绑定组 | 81/81，测试进程使用已有 trusted-host 模式；未改部署默认值或系统盘/祖先 ACL |
| 临时目录收尾后的恢复套件复验 | 29/29，属于上述 121 项的子集，不重复累计；仅清理 helper 当次记录的自有 fixture 根 |
| `pnpm --filter @cat-cafe/api run build` | 通过，包含 shared、MCP、API TypeScript、bundled 产物和 recorder census |
| Biome / frontmatter / capability tips | 修改的 TS/JS 无错误；3 份 Markdown frontmatter 通过；tips 检查通过，既有复杂度及失效文档 anchor 告警保留 |

三组主回归共 211 项通过；29 项收尾复验不重复累计。CodeAgent 和 RelayAgent 的同一客户端连续会话与不同成员隔离、权限拒绝、停用后再启用均有实际 ACP 管道输出。最终构建后未再修改产品代码。

公共测试：原有 Windows planner CLI 在 `spawnSync('pnpm')` 无法执行 pnpm.ps1 时返回 `could not resolve pnpm version: undefined`。未将这项报绿或顺带改 CI；改用同一 resolver/planner/validator API，并通过 PowerShell 实测 pnpm 9.15.4、记录真实 tree/lockfile/toolchain，得到 2968 个入选测试，新增 5 份测试分别进入 distributable 分片。记录为 `public-test-selection.log` / `public-test-plan-manual.json`，不冒充全套公共测试执行结果。

Fallback scanner 已按 next 基线执行并提示净增 25。核对：修复的是“发行来源被当成 runtime”这一错误分类，没有增加安装失败降级；scanner 把测试协议/动作分派的布尔条件也计为 fallback。生产连接读取的优先级是“owner 已存值 → manifest 默认 → 空覆盖”，用于保留已有配置；权限缺省固定为 deny。JSON 边界拒绝和已知 I/O 分类保留原错误语义，不通过另一执行器或不受校验路径重试。

固定连接成员投影使用普通 connection 字段，避免误选多客户端目录编辑器；执行 fixture 同时覆盖停用后重新启用。新增该调用时曾漏传 invocationId，Host 正确拒绝，已补齐测试输入，未放宽生产校验。

上述 9 项集成使用隔离的发行布局：复制本工位编译产物，写入真实 bundled index 和 canonical tgz，在独立进程加载冻结注册表，经真实 Manager、文件 inventory、包定位器和 HTTP 路由执行。鉴权测试身份与审计 writer 为测试注入，不声称覆盖浏览器登录或生产审计落盘。

CodeAgent 0.1.0 和 RelayAgent 1.0.0 的声明形状来自 Issue；执行阶段明确改用 Node NDJSON fixture，通过真实 RegisteredSessionAgentService → ACP factory/pool。验证两个成员不共用 native session、同成员续聊、权限默认拒绝。fixture 不读取认证、不连接模型或外部网络。

更新测试跨子进程重载真实插件配置，比较同一实例与配置；另检查绑定/历史哨兵文件未被包生命周期改写。实际成员配置磁盘回读由既有 client-library-persistence 测试覆盖；哨兵文件不等于真实原生会话历史或业务存储恢复验收。

原始严格模式回归中，5 项既有 invocation 测试因本机临时目录祖先 ACL 返回 PARENT_REPLACEMENT。仅为测试子进程设置 trusted-host 后，这 5 项及相应组通过；严格模式原始失败保留在日志中，不报告为默认严格模式全部通过。

## 现场仍需验证

未取得包含 `71020406f` / `8270e59a9` 的企业源码与实际 tgz；没有真实 CodeAgent/RelayAgent 程序及企业认证。故不宣称已验证现场归档、真实模型、system/persona、MCP/角色协作、企业安装包升级或重启续接，也不自动关闭 Issue #178。

集成者按[操作指南](../ops/bundled-acp-plugins.md)保留实际归档版本/SRI，吸收 Host 增量后验证 catalog 安装和更新；已有用户只在必要时修正原连接字段，不清 inventory、配置、认证或历史，不重建角色。

## 环境与收尾

- 工位：`G:/AIwork/clowder-ai/worktrees/fix-issue178-bundled-acp-20261102`；负责人 codex，关联 Issue #178。保留用于 PR 修改，2026-11-09 复查。
- 原始日志集中在仓库外 `G:/AIwork/clowder-ai/artifacts/issue178-codeagent-install-analysis-20261102`，包括 RED、各组回归、原始严格模式失败与兼容模式复验。
- 没有安装测试 EXE、创建快捷方式、后台交互服务或监听端口；新增集成测试的 finally/shutdown 关闭 fixture 进程，测试退出移除自己的临时目录；恢复 helper 也只清理它当次记录的 fixture 根，不按名称批量清理旧目录。
- 没有改用户运行环境、系统盘根/祖先 ACL、.env、认证、角色、会话、Redis/SQLite 或历史；现有引导逻辑仅维护自己创建的临时私有目录。回退仅回退代码。PR 不合并。
- 最终测试退出后，已核对没有遗留 `bundled-acp-agent.mjs` / `bundled-acp-probe.mjs` 进程；没有停止其他任务的服务。既有、无法核实归属的旧临时目录未按名称批量删除。

## 回归命令

以下从 `packages/api` 运行；完整构建在仓库根运行上表命令。

```powershell
$regressionTests = @(
  'test/plugin-archive-member-listing.test.js',
  'test/f322-bundled-plugin-icons.test.js',
  'test/plugin-official-package-installer.test.js',
  'test/plugin-official-package-installer-refresh.test.js',
  'test/plugin-manager-routes.test.js',
  'test/acp-bootstrap-config-recovery.test.js',
  'test/acp-bootstrap-config-route-recovery.test.js',
  'test/acp/acp-pool-signature.test.js',
  'test/bundled-acp-build.test.js',
  'test/bundled-plugin-build.test.js',
  'test/bundled-plugin-artifacts.test.js',
  'test/bundled-plugin-closure.test.js',
  'test/fixed-acp-connection.test.js',
  'test/plugin-package-diagnostics.test.js'
)
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=120000 @regressionTests
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=240000 test/bundled-acp-admission.test.js

$clientTests = @(
  'test/agent-session-contract/plugin-declaration.test.js',
  'test/agent-session-contract/client-library.test.js',
  'test/agent-session-contract/client-library-persistence.test.js',
  'test/agent-session-contract/client-library-lifecycle.test.js',
  'test/agent-session-contract/client-library-invocation-ownership.test.js',
  'test/agent-session-contract/plugin-lifecycle.test.js'
)
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=120000 @clientTests
```
