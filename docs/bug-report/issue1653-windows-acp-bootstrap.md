---
feature_ids: []
topics: [windows, acp, dsh, pi, security, issue1653]
doc_kind: verification-report
created: 2026-10-21
tips_exempt: 修复既有 ACP 启动隔离边界，不增加用户操作入口
---

# #1653：Windows ACP bootstrap 修复与验证

## 约定与证据边界

用户要求：独立 worktree、先安全回归再修复、不改系统盘 ACL、不扩大可信主体，交付测试和独立安全审查结果。原故障是**另一台企业镜像机器**，当前机器只能提供同类机制的原生 Windows 验证，不能代替原机验收。

- 问题：[zts212653/clowder-ai#1653](https://github.com/zts212653/clowder-ai/issues/1653)。
- 分支：`fix/windows-acp-bootstrap-1653`；基线：`44fb36e65b3a9ea4ebb9a9a875e0605c06f80289`。
- 工位：`G:\AIwork\clowder-ai\worktrees\fix-windows-acp-bootstrap-1653`。
- Architecture cell：现有 ACP provider/process lifecycle；Map delta：none。只调整原 Factory、bootstrap 和两个客户端的启动边界，不新增状态库或并行运行入口。
- 适用范围：Factory 管理的 ACP 连接。直接构造底层客户端的调用不获得卷根例外；自定义 `spawnFn` 仍仅为测试注入。

## 根因与修复

原检查把所有祖先的 `DELETE` 都视为可替换目录。普通目录上的该拒绝是必要的；真实卷根不能重命名，且只要它没有向非可信主体授予 `DELETE_CHILD`，其私有、非空直属子目录就不能靠卷根自身的 `DELETE` 被移除。因此对**真实本地 NTFS 固定卷根**，可以只排除卷根自身的 `DELETE`，保留其他条件。

原企业机器的系统盘根 owner 不在既有信任集合；旧逻辑又仅匹配错误文本 `permits unsafe directory replacement`，不能从 owner 拒绝继续查找独立候选位置。修复改为结构化错误，仅祖先 owner/替换权限/卷身份拒绝可以继续寻找候选；私有目录、特殊 ACL、校验不可用均立即失败。已有私有 root/cwd 先检查，避免祖先错误掩盖目录完整性失败。

候选顺序仍先用户 temp、再 ProgramData；都无法通过时，只有已审启动链可以枚举非系统盘的 NTFS 固定卷，在卷根下创建 SID 摘要命名的私有直属子目录。候选仍完整核验；没有安全候选就拒绝启动。显式传入 root 不自动迁移。

### 不变的安全条件

1. 可信主体仍为当前用户 SID、SYSTEM、Administrators；祖先 owner 额外接受既有 TrustedInstaller。未增加安装账户、Authenticated Users、Users、Everyone。
2. 新 root/cwd 使用 .NET Framework 原子创建的 owner-only、禁继承 DACL；不修补已有目录 ACL、不接管 owner。
3. 普通祖先仍检查 `DELETE | DELETE_CHILD | WRITE_DAC | WRITE_OWNER`；真实卷根仍检查后三项和 owner。
4. 卷身份来自同一原生句柄：非 reparse 的目录、卷内相对名为根、最终卷 GUID 根路径、NTFS、持久 ACL、本地固定卷。不是仅检查 `D:\` 字符串。
5. Generic rights 先展开；null DACL、未知/对象/回调 ACE 等不支持形式保守拒绝。junction、SUBST、校验失败不能获得例外。
6. 池签名包含隔离类型和实际 cwd；冷启动固定原位置，不重新选择另一个 root。两个客户端在真实 spawn 前用实际 command/args/env 复验启动链和目录，避免普通 `mkdirSync` 绕过私有创建。

机制依据：[Windows FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)、[Directory.CreateDirectory 的 DirectorySecurity 重载](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1)。未对任何既有磁盘根尝试删除或重命名。

### 为什么限制启动链

共享卷根可能包含其他用户写入的 `.env`、AGENTS/CLAUDE 或 skills。安全目录并不能阻止 CLI 主动向上查找这些文件。因此通用 ACP 和外部 `pi-acp` 仍采用原严格策略。例外仅接受：

- 精确的内置 `pi-acp-bridge.js --pi-command <绝对路径>`。`initialize` 不启动 Pi；真正 Pi 在 `session/new` 使用真实项目 cwd，原生项目发现语义不变。
- 已逐项核验的 DSH `0.2.0-rc.2`、精确 `--profile acp`，版本及关键编译文件 SHA-256 匹配；bundles 精确为 `dsh-base → dsh-acp-app`，HOME/profile patch 缺失或严格无操作语法。新 profile 必须不存在或为空；部分 profile、自定义 patch、其他版本拒绝例外。
- Node hooks、Windows 环境变量大小写歧义、相对/tilde DSH_HOME、默认 HOME 与子环境 USERPROFILE 不一致均不能获得例外。

DSH 默认启动链只读取精确 cwd/HOME 的 `.env`，模块由安装位置/profile 解析；默认 ACP bundle 禁用 HMR。自定义安装/覆盖仍需重新审计。纯空白或仅注释 patch 无执行风险，但 DSH 自身要求顶层数组，可能自然拒绝启动；本修复不改用户配置。

已审编译文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| dsh/lib/bin.js | `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f` |
| dsh/lib/profile-boot.js | `c53d4e2caf21428e263b525e657dafaf63fd183f7ef016aabda56af7998b6c4f` |
| dsh/lib/profile-boot-BZ2ZjNWi.js | `c394b2aa2ce08a3b1fcc8c544257c7d689dd4d0b1cfaf8602687e65eeaba5aa1` |
| dsh-app-boot/lib/index.js | `234db45e1b3f8c683b5bc1f551948b2a2ec52a6468c7b6937725a23f1c0e0d96` |
| dsh-acp/lib/index.js | `c08ed51ebe53b7b45ca8f475630afc0271bf4ccb8b53f13b456fe2b4568a61b3` |

## 验证

所有原生测试均为本机 Windows、管理员令牌；没有标准用户/第二用户证据。测试只对 UUID 命名的新 fixture 设置 ACL。真实数据卷测试每次独立读取既有卷根 SDDL，创建/重开/清理私有直属目录后比对 SDDL 完全一致。

| 阶段 | 实际结果 |
| --- | --- |
| 原始卷根回归 RED | 2 项，1 失败：G 盘根 Authenticated Users Modify 被原检查拒绝 |
| 迁移错误分流 RED | 6 项，5 失败：owner 不迁移、文本匹配误把完整性失败当迁移许可 |
| 启动链 RED | 4 项，3 失败：大小写 env、池后环境变化、默认 profile 准入 |
| 已有私有目录检查顺序 RED | 9 项，1 失败：祖先错误掩盖已有目录失败 |
| 最终受影响回归 | **177 项：176 通过、0 失败、1 跳过**；跳过项仅 POSIX mode 位，Windows 使用原生 ACL 验证 |
| 真实 Pi/DSH initialize | 两者各启动两次成功，关闭后重开；真实 DSH、真实内置桥，无模型调用 |
| 完整 API TypeScript 编译 | 通过 |
| 标准 `pnpm --dir packages/api build` | 通过；共享包、API、资源拷贝、F299 recorder 12 implementers 均完成 |
| Biome 检查、git diff --check | 无错误；启动链校验函数有新增复杂度警告，另有既有大文件/规则警告 |
| capability-tips checker | 通过，10 条既有 stale anchor 警告 |

回归覆盖：root/cwd 广泛 Allow、错误 owner、继承、junction、普通文件、不可用验证器、普通祖先各危险权限、原始 GenericAll/回调 ACE、SUBST、卷根正向、通用 ACP 反向、配置变更、实际 spawn 接线、池签名与冷启动、账号/注册诊断、STDIO/HTTP 和进程池生命周期。

本地原始日志保存在该工位 `.tmp/issue1653-*.log`，不提交含本机 SID/进程路径的日志。真实启动两个用例首次与一项 fixture 快照测试同跑：真实启动两项通过，快照项发现 Windows 修改父 ACL 时会更新子目录 auto-inherited 标志；快照已改到 fixture 准备完成后采集，最终回归该项通过。未把该次整套日志说成全绿，也未重复制造模型调用。

复验环境：`ACP_BOOTSTRAP_TEST_VOLUME=G:\`、`ACP_DSH_AUDITED_ENTRY=<上述已审安装入口>`，TMP/TEMP 指向全新私有 fixture，`REDIS_URL=redis://127.0.0.1:0`，配置根为本 worktree 的 `.tmp/isolated-config`。

运行测试：`node --import ./packages/api/test/helpers/setup-cat-registry.js --test --test-concurrency=2 --test-timeout=90000 <上述 bootstrap/client/httpstream/pool/factory/registration 测试文件>`。真实启动用例位于 `packages/api/test/acp/acp-bootstrap-audited-runtime.test.js`，只在显式提供原生 fixtures 时运行。全量仓库测试未执行。

fallback checker 的语法计数触发自检：startup policy 的布尔拒绝条件及 native 身份校验被计为 fallback，并非吞掉异常后换方案。真实位置候选只有既有 temp、ProgramData 加新增数据卷一层；同一验证器统一检查，私有目录/校验不可用失败不降级。坐标修正是区分“可重命名的普通祖先”和“经原生证明的真实卷根”；移除新增候选会重新落回同一不可信系统盘链，不能解决原问题。

安全论证针对 bootstrap 边界，沿用既有进程执行契约对安装的 Node/CLI/依赖和用户选择的真实项目的信任；不声称修复操作系统或任意第三方 CLI 的全部风险。

## 独立审查与原机验收

独立审查由非作者 `security_review_1653` 完成，结论为 **supported，无 P1/P2 阻断项，独立安全测试 46/46 通过**，覆盖代码提交 `4a0b6833b748951f0378793d6cf77aeed24a469c`。完整记录见 [独立安全审查](./issue1653-independent-security-review.md)。作者测试不替代该结论。这是独立 GPT 实例，不声称跨模型家族审查或 GitHub 正式批准。其后仅补文档与收尾记录，生产代码和测试内容无变化。

原企业机器仍须逐项验收：

1. 实际 DSH 版本、关键文件哈希、ACP bundles/patch/env 是否符合已审条件；其他版本不在放行范围。
2. 原机数据盘的真实卷身份、owner、原始 ACE、当前标准用户可创建私有直属目录；无安全卷时应继续拒绝。
3. 企业 AppLocker/WDAC/Constrained Language 对 WinPS/.NET/原生查询的影响；校验不可用必须失败，不绕过企业策略。
4. 标准用户和第二个非可信用户的攻击验证：不能读写/删除/重命名私有目录，不能借 ancestor 配置影响 bootstrap。
5. 原机安装包/GUI 的 DSH/Pi 实际绑定、`session/new` 真实项目 cwd、真实模型往返、关闭重连和历史读取。
6. 原机 C/D 根和用户目录 ACL 前后只读比对。当前 C 根是 TrustedInstaller，不能把它当作原机安装账户 owner 的同一复现。

这些项目尚未验证，因此不据此关闭 Issue、不声称原企业机已经恢复。工作分支保留供进一步验收；主分支、其他 ACP 工位和生产运行态未修改。

## 收尾回执

- 四个真实测试子进程均通过客户端 close 退出，按记录 PID 只读回查均不存在；未启动应用/Redis 服务。
- 临时 SUBST 映射已解除，G 卷上的本任务 UUID 测试根均已回收；卷根 SDDL 比对通过。
- 新建的 C 盘 UUID fixture 共 46 个文件已逐个 SHA-256 核验归档，原 UUID 目录已移除。归档为本 worktree `.tmp/issue1653-native-fixtures.zip`，SHA-256 `47d3618fdd5aca57a53146c9f86809f87620f81219c2ad225ccf84e24a9b82e5`；清单和实例台账在 `.tmp/issue1653-native-manifest.json`、`.tmp/issue1653-instance-ledger.json`。
- 归档前已确认无 reparse、数据库、原生会话或认证文件。DSH 临时技能 assets 与官方包哈希一致，空 spill 和 registry 模板均为本任务新生成物。
- 没有安装 EXE、创建快捷方式、修改原生 HOME 或操作生产历史。工位及日志保留，供用户继续原机验收。
