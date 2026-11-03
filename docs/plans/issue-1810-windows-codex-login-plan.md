---
feature_ids: [F320]
topics: [windows, codex, oauth, accounts, acceptance]
doc_kind: plan
created: 2026-11-03
---

# Issue #1810：Windows 新增 Codex 账户技术方案与验收

状态：两猫方案已收敛，已按后续授权在独立 worktree 实施；未部署、未做真实 OAuth 或可见浏览器验收。

- Issue：<https://github.com/zts212653/clowder-ai/issues/1810>，正文已远端逐字回读。
- 源码基线：`zts212653/clowder-ai next@6c2021d494b7fe0f7a5423868709d4ae99c097ed`，已与远端 branch API 核对。
- 默认分支复核：`main@42017e0cea07e3e259e7fb183be70433f05e131c` 的平台 guard 与 macOS-only 终端实现相同，缺失不局限于本机安装产物。
- 参与：砚砚（分析、实施、综合、验证边界），宪宪（独立方案、反例、实现审查）；讨论结果见文末。
- 原托付及后续授权：提交 Windows 功能缺失 Issue、共同讨论方案与验证验收；随后明确「先做方案和拉 worktree 实施，我目前自己在用」。当前禁止本机真实登录和打开网页验收，不包含部署。

## 1. 成功终态

用户从现有账户页添加 Codex OAuth 账户，Windows 终端执行该账户独立目录中的官方 `codex login`，CLI 自己打开浏览器，用户亲自授权。Clowder 核对官方登录状态和身份后保留备注、允许绑定成员；第二个账户同样可登录，默认账户不被替换，重启后账户与会话可以恢复。

保留 F320 既有契约：凭据独立，原生 state/config/SQLite 按现有约定共享。测试环境使用独立的 state/config/SQLite，不能把「共享状态」解释为可以写入日常原生历史。

窗口出现、退出码为零、`auth.json` 存在、fixture 返回身份都只证明其中一步。完整成功还需要官方 status、身份回读、账户绑定及实际调用归属。

## 2. 已证实与尚未证实

| 项目 | 证据 | 判断 |
|---|---|---|
| Windows 登录立即失败 | 安装版同函数只读调用返回 `win32 / codex_managed_platform_unsupported`；本次 attempt 在 20ms 后由 driver 异步 catch 保存为 `failed` | 已证实；start 先返回 preparing，不是同步异常 |
| 平台仅限 macOS | `codex-managed-support.ts:20` 明确拒绝非 `darwin` | 本次直接根因 |
| 终端仅实现 macOS | `codex-login-driver.ts:24` 调用 `/usr/bin/osascript` | 删除平台判断仍无法完成登录 |
| 错误映射缺陷 | manager 的 unsupported 正则吞掉平台错误，显示为版本/策略不支持 | 已改为精确的平台错误分支 |
| worker 未适配 Windows carrier | 本机 resolver 实际返回 `codex.CMD`；直接 `execFile --version` 得 `EINVAL`，用已有 Windows spawn adapter 后得 `codex-cli 0.161.0`；worker 的 login/status 均直接启动 | 已证实 carrier 启动缺口；必须覆盖 npm shim 与原生 `.exe` |
| capability probe 存在 Unix 假设 | `probe.ts` 固定 `/tmp`；`probe-host.ts` 用冒号 PATH、Unix socket；`native-version.ts` 直接 execFile carrier | 不能把 capability admission 当作 Windows 现成能力 |
| 现有登录测试不证明 Windows | `f320-terminal-login.test.ts` stub 掉 assertSupport、使用 `/bin/sh` 及 Unix executable fixture | 保留其有效覆盖，另补原生 Windows 测试 |
| 普通用户布局权限 | #1709；本次账户 layout 已 `prepared=true` | 是另一阻断点；本次成功不能外推无 symlink 权限用户 |
| 目标 CLI transport | 两猫均验证 Windows stdio；实现后的原生 managed probe 14 项通过 | 已证实，包括原生 config/value/write 保留链接 |
| Windows 组织策略语义 | 原生 layers 报出 ProgramData 系统配置；官方文档列出系统 requirements 与 Windows legacy managed 文件 | 已补平台路径及系统层投影；策略存在或无法读取时拒绝新增 |

本机环境核对：Windows 11 专业工作站版，build `26300`；全局 npm Codex CLI 包 `0.161.0`。问题发生在版本探测之前，不将其归因为 CLI 版本。未来验收另记录实际使用版本，不能用这里的版本号作硬编码白名单。

## 3. 现有调用链与职责

```text
账户页：创建账户 → POST /api/accounts
  accounts.ts → describe/prepareCodexManagedLayout → 持久账户条目
账户页：开始或重试 → POST /api/accounts/:id/codex/login/start
  accounts-codex-login.ts → CodexLoginManager.start/drain
    → 同一队列、attempt revision、取消与身份采用规则
    → login driver：独立 attempt home、平台/策略/carrier/版本能力准入
    → 终端 → terminal worker → 官方 login → 官方 login status
    → 只读身份 → manager 处理重复/不同身份 → 采用该账户凭据
```

`start()` 的 preparing 与 driver 后续异步失败是两个状态，不能把创建条目成功或 preparing 当成原生登录已经启动。实现增加 worker-ready 回执，在 worker 真正开始前不进入 waiting；启动失败在有界时间内显示终端错误。

CLI 负责浏览器和 OAuth；Clowder 负责账户目录、启动官方命令、回读结果和可恢复状态。不要增加浏览器控制器、认证代理、回调端口抢占探测或新账户管理服务。

## 4. 推荐实现

### 4.1 先验证最可能推翻方案的三个入口

先在独立 worktree 和临时 HOME 做无真实凭据实验，给代码确定边界；本轮已有以下结果：

1. 用实际 Windows npm `.cmd` 与直接 `.exe` 执行 `--version`、启动 stdio app-server 并完成 `initialize → config/read(includeLayers) → configRequirements/read → account/read`。`account` 应为空，不启动登录、不发真实模型请求。
2. 在临时 state/credential 根核对目录链接和共享 config 原生写入行为。真实 config/value/write 后 A/B 配置一致且链接仍在，既有契约成立。通用 rename 覆盖链接的实验不能替代原生 writer 证据；不引入配置复制、hardlink 或同步收敛机制。权限场景分开运行，保留 #1709 的诊断。
3. 明确该 exact CLI 版本在 Windows 加载的组织策略来源以及是否因 HOME/USERPROFILE 改变而遗漏。优先使用原生 effective config/layers/requirements；若字段不足，再核对该版本一手实现并只读检查实际来源。不能套用 macOS CFPreferences，更不能删掉策略准入。

本轮已完成 carrier、stdio、真实 managed probe 与策略拒绝样本。Windows 路径按 [OpenAI 官方托管配置文档](https://learn.chatgpt.com/docs/enterprise/managed-configuration) 与 0.161.0 原生 layers 核对：系统 config/requirements 位于 `%ProgramData%/OpenAI/Codex`，legacy managed 配置跟随 Codex home。默认本机 home、父进程选择的原生 home 与当前私有 home 都检查 legacy 策略；有策略时沿用既有拒绝契约，不擅自迁移或绕过。

系统 `config.toml` 是可由用户/profile 覆盖的默认配置，不等同于 requirements 或 legacy managed 策略，见 [官方默认值说明](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#distribute-defaults-and-requirements)。保留与 macOS 一致的处理：读取并合成普通系统默认值，在 driver 打开终端之前验证有效 OAuth 配置；API-only、外部端点/提供方、无效 TOML 均拒绝。不能因存在一个普通系统默认文件就一律禁止新增账户。

协作核验中曾临时写入真实 ProgramData 的探针配置，随后已还原，作者独立确认对应目录恢复不存在；该方法不符合后续的本机隔离要求，不再使用，也不能算隔离验收。实现回归只把测试子进程的 ProgramData 指向临时目录，未改用户环境或真实系统配置。

### 4.2 平台准入与 capability probe

- `codex-managed-support.ts` 保留 macOS 路径，增加经过证实的 Windows 策略路径；其他未支持平台仍返回平台错误。
- 保留同一原生 carrier 和 exact CLI 版本能力测量。版本查询、probe 内的 status、app-server 与实际 login/status 消费同一命令选择和 Windows spawn 规则，不能换成另一份 PATH 中的 CLI。
- 复用 `resolveWindowsSpawnPlan` 处理 npm shim/原生 `.exe`。对需要交互或精准清理的路径，优先已解析的 shim/native argv 模式；不能用未经验证的 shell fallback 掩盖未支持 carrier。
- Windows managed probe 使用 stdio JSON-RPC，保持现有 `ProbeHost.rpc/events/stop` 消费接口；macOS 既有 Unix transport 保持原路径。借鉴仓库已有 stdio RPC 和 Windows 进程清理实现，不引入新外部依赖或本地 WebSocket 服务。
- probe 的路径使用 `os.tmpdir()`，PATH 使用 `path.delimiter`；Windows 运行必需环境来自经过选择的系统字段，账号/认证字段仍由 canonical 环境合成剔除或覆盖。空私有 HOME 不能借用日常登录。
- 无凭据 host 正常退出先关闭 stdio、等待原生 writer 锁释放，超时才清理拥有的进程树。此处实测抓到强制结束后续接仍报 active writer，已在同一原生检查上修复。
- 完整保留 managed_accounts 的私有登录不借宿主、单写者、跨 home 续聊/目标/记忆、共享 SQLite、config 写入与端点语义检查；不通过删检查让 probe 变绿。
- 结果至少区分平台与 probe revision，避免同版本的 macOS 结果被 Windows 复用；继续保留现有版本缓存与安装变更失效规则，不扩展为新的通用缓存系统。
- 不把 `readonly_sandbox` 的 `/bin/bash` 改造成另一项 Windows sandbox 项目。若共用 probe-host 有变化，回归原能力；本文只承诺 Windows managed_accounts。

### 4.3 Windows 终端与 worker

- 保留现有 driver 接口、request/result/cancel 文件和 manager 队列；仅为终端唤起加 Windows 分支。
- 优先使用系统 Windows PowerShell，不把 Windows Terminal、Git Bash 或额外终端软件当必装依赖。以 `-NoProfile` 启动可见终端，失败输出留在终端；不得使用 `-ExecutionPolicy Bypass` 或自动提权。
- 终端只接收受控 node 路径、worker 路径和 request 路径。若使用 EncodedCommand，只是编码固定启动逻辑和按 PowerShell 字面量规则处理的路径；备注、OAuth URL、token 和任意用户文本均不拼进 shell。实际 Codex argv/env 仍由 worker 从既有结构化 request 读取。
- 命令启动成功只进入 waiting，不能标记已登录。终端启动失败、worker 未启动、CLI 失败要能收敛为可重试失败，不挂到统一 15 分钟超时才报错；根据最小实验选择启动确认方式，避免建立新终端注册表。
- worker 的 login 与 status 复用同一 Windows spawn 规则、同一 env 和 carrier。官方 login 零退出后还须 status 成功及账户身份可读，才交 manager 采用。
- 取消、关闭终端、API 退出和超时必须停止本次拥有的完整进程树。已知 `.cmd → node → codex.exe` 会产生后代，单独 `child.kill()` 不足以视作证明；优先复用已存在的 Windows owned-PID tree 清理方法，并用实际子孙进程验证。禁止按进程名称批量停止。
- Windows owner birth 使用系统进程 StartTime，替代无条件 `/bin/ps`；重启后的判断能区分活 owner 与相同 PID 的不同进程，读取失败仍保守处理。

### 4.4 布局权限与错误显示

- #1810 修复本次已证实的准入、终端和执行路径；#1709 是同一真实旅程的布局前提，保持关联，不重复声明已解决。
- 创建/重试前尽早提供明确的平台或布局权限原因，避免先成功创建条目再只显示笼统未登录；已有失败条目仍从原入口恢复，不删除后重建来掩盖失败。
- 分开显示 platform unsupported、policy unsupported/unavailable、CLI unavailable、layout symlink unavailable、terminal open failed、login failed/timeout，保留当前账户页结构，不另做 UI 改版。
- 标准用户无 symlink 权限时，必须在出现 OAuth 前显示可操作的布局原因；不得静默提权或修改 Developer Mode。若当前 layout 仍要求该能力，交付必须明确支持条件，不能宣称 Windows 普通用户全支持。
- 若要承诺无 symlink 权限也能完成，须先完成 #1709 对应、保持现有共享状态与配置写入契约的设计与验收；单用 junction 解决目录、不解决配置文件的方案不合格。

## 5. 文件落点与实施顺序

| 顺序 | 必要改动位置 | 交付与验证 |
|---|---|---|
| 1 | 临时 experiment 与 `test` 证据 | 固定 CLI/carrier/策略/链接事实；旧代码 RED；不碰日常 HOME |
| 2 | `codex-managed-support.ts`；`codex-native-compat/{native-version,probe,probe-host,probe-managed,admission}.ts` | Windows managed 准入完整通过；macOS 保留；缓存不跨平台误用 |
| 3 | `codex-login-driver.ts`、`codex-login-terminal-worker.ts`；既有 Windows spawn/cleanup 工具 | 可见终端、正确 argv/env、login/status、退出清理；只在确有复用需要时抽出 helper |
| 4 | manager 的错误映射、必要 schema/view 及现有账户错误文案 | 具体失败可读、同条目重试、取消/重启状态正确；新增字段才调整 schema |
| 5 | 原有测试文件与新增 Windows 原生 fixture | targeted API/Web 回归、Windows/macOS CI；禁止用跳过平台检查的测试替代 |
| 6 | 隔离安装包 | 用户授权的真实双账户旅程、独立 review、合入后隔离验收；授权部署前不改日常安装 |

每一步以最小闭环推进，不先建统一终端框架。实际文件数由实验决定；保持短文件和既有风格。

## 6. 验证矩阵与合格证据

| 层级 | 场景 | 断言与证据 |
|---|---|---|
| L1 单元 | 支持平台/未支持平台；策略无/有/读取失败 | win32 能走正确策略分支；未知策略不放行；macOS 原规则不变 |
| L1 单元 | 失败映射与 UI | 错误可区分且用户能读全；同条目可重试；平台限制不显示成版本升级建议 |
| L1 单元 | 新旧 attempt、排队、重复或不同身份、重启 | 沿既有 CAS/队列规则；旧 attempt 不覆盖新状态，不误采用其他账户 |
| L1/L2 | 同一 manager 并发登录与重启归属 | 现有队列串行执行；真实 owner birth 与模拟 PID 复用均验证；保留跨进程场景待验 |
| L1 单元 | exact version/platform/probe revision | 只复用同一适用范围的通过结果；不绕过失败检查；CLI 升级重新测量 |
| L2 原生 Windows | npm `.cmd` 与 `.exe`；中文/空格/单引号路径 | 实际 fixture 收到精确 argv、cwd、account CODEX_HOME；备注不进入命令 |
| L2 原生 Windows | ambient API key/issuer/其他账号环境 | fixture 检查不会继承；只保存布尔结果或脱敏标识，不写原值 |
| L2 原生 Windows | 终端/worker/CLI 缺失；非零退出；status 失败；无身份 | 状态及时失败、原因正确、原条目可重试；不能因窗口或 auth 文件判成功 |
| L2 原生 Windows | 取消、关闭终端、API 退出、超时 | 本次进程及其后代都退出；后续重试可执行；不停止其他账户或日常 Codex |
| L2 原生 Windows | 原生 managed capability | exact CLI + 临时 HOME + 本地假模型；所有既有 managed 检查通过；无真实凭据/外部模型调用 |
| L2 原生 Windows | 真实配置 writer | config/value/write 后两个 home 内容一致、config symlink 保持；不以普通 rename 实验替代 |
| L2 权限 | 非管理员，有/无 symlink 能力 | 有权限完整测试；无权限明确诊断；若 #1709 未解决，不标记普通用户全支持 |
| L3 真实安装 | 从账户页开始登录 A、用户亲自授权 | 终端和官方浏览器出现；status、身份与持久条目一致；备注保留 |
| L3 真实安装 | 从同入口登录不同身份 B，再逆序重登 A | A/B 凭据独立；身份可区分；不会改写默认账户；登录同身份触发既有复用处理 |
| L3 真实安装 | 分别绑定成员、各发一轮真实请求 | 执行选择的 accountRef、脱敏身份与实际 provider 成功结果对应；不以模型自称作为身份依据 |
| L3 真实安装 | 重启 Clowder、续接测试线程 | A/B 状态/备注/绑定仍在；指定身份续接成功；已有测试会话/目标历史可回读 |
| L3 跨平台 | macOS 原旅程 | 原终端入口、OAuth、取消/重试及管理规则回归；不能以 Windows CI 代替 |

Windows CI 要运行原生 PowerShell/进程测试，不能依赖 runner 恰有 Git Bash 而继续测试 `/bin/sh`。无可见桌面的 CI 只证明 L1/L2；可见终端与真实浏览器必须在交互桌面验收。

1455 端口的第二 login 打印 URL 只证明冲突待查，未证明 OAuth 错绑。本轮不启动真实 login，也不新建端口抢占或总控服务；真实验收需同时核对登录实例、回调与最终身份，不允许两个并发进程的日志冒充双账户成功。

既有 macOS 原生验收若同源码、同场景有可追溯证据，可复用；发现新变化或覆盖缺口才追加真实调用。

## 7. 真实验收环境与步骤

1. 合入前在 feature checkout 的隔离环境测试；合入后固定 exact merged SHA，在独立验收目录制作并运行安装包。登记唯一实例台账：责任猫、Issue/PR、源码 SHA、包版本/SHA-256、程序/数据/原生 state 根、端口、PID、用途与保留状态。
2. 与日常实例隔离：不得使用生产 Redis `6399` 或占用日常 `3003/3004`；按项目约定使用独立测试 Redis/数据目录与空闲端口。原生共享 state/config/SQLite 也要指向本次测试根，不能仅隔离 Clowder Redis。
3. 先做无凭据 fixture 和真实 CLI capability；全部通过后，再安排用户在可见桌面手动完成 A/B OAuth。不得自动输入密码或读取浏览器 cookie。使用实际独立身份，不能用两个备注相同身份冒充双账户。
4. 按 L3 顺序完成绑定、各一轮实际请求、重启及续接。证据保存脱敏状态、时间、accountRef/身份对应、进程退出和请求结果，不采集 token、完整 OAuth URL、验证码或个人邮箱截图。
5. 记录默认账户凭据文件指纹，比较新账户创建前后；若外部客户端自然刷新导致变化，单独解释并核对身份，不能单凭哈希变化判覆盖或掩盖覆盖。测试环境默认不绑定日常原生 HOME。
6. 结束后受控停止作者实例、核对进程树和端口释放；记录测试会话 ID 与测试目录，仅按已有授权处理已核验的测试历史。保留状态和凭据，不删除数据库或日常会话。

执行真实 OAuth 前须具备真实用户授权、两个可用身份和交互桌面。这些条件不是本轮已执行的验收；缺少任一条件都如实标为待验，不用 mock 补成通过。

## 8. 合入、发布和回退

- 作者先红后绿，非作者审 final exact HEAD；审查范围必须包括 Windows carrier/env、完整进程退出、平台策略、布局前提和验收证据。
- 自动测试通过仅允许进入人工验收；Windows 功能完成声明以 L3 和明确支持矩阵为准。若无 symlink 权限用户仍被阻断，保留 #1709 与支持条件，不把整个 Windows 旅程宣布完成。
- 发布前核对包内 driver/worker 与受审 SHA 一致。未完成的外部环境、macOS 或真实 OAuth 项目分别列为 pending，不压缩成「全绿」。
- 回退以代码提交/安装包为单位，恢复上一已知可用版本；账户目录、认证、attempt、备注和历史保留。schema 尽量不变；如必须新增字段，旧版读回兼容需有明确测试，不执行数据回滚删除。

## 9. 两猫讨论记录

- 砚砚首轮：完整适配须包含平台策略、Windows 终端、carrier、capability probe 和真实验收；#1709 单独作为前提处理，不只删 guard。
- 宪宪补充：异步 preparing→failed、平台错误被正则吞掉、Windows owner birth 降级、系统配置路径与并发登录验证。已纳入。
- 分歧一：宪宪建议 detached login + URL UI；砚砚按 F320 现有可见终端契约保留原入口，stdio 仅用于能力探测。宪宪确认两者用途不同、撤回“互相矛盾”的判断，接受保留终端。
- 分歧二：宪宪曾按 generic rename 推断 config 必然分叉；真实原生 writer 检查通过后撤回。保留现有共享配置，不新增同步机制。
- 分歧三：1455 的实际错绑尚未证明。共识为加入冲突和归属验收，不在本次增加端口总控。
- 共识：Windows 平台、carrier、系统配置投影、stdio probe 与进程生命周期一起实现；无权限 symlink 和真实 OAuth 分别如实标记，不能被自动化通过替代。

## 10. 本轮完成状态

- 已完成：根因复现、Issue 发布与回读、两猫方案收敛、独立 worktree 实现、RED/GREEN、实际 Windows managed capability 测量。构建、定向回归与独立审查结果见 [验证记录](issue-1810-windows-codex-validation.md)。
- 当前未做：真实双账户 OAuth/远端模型调用、可见浏览器和终端验收、macOS 实机新验收、安装包发布或部署。用户正在使用本机，这些项目不在当前执行范围；不标记 Issue 完整验收完成。
