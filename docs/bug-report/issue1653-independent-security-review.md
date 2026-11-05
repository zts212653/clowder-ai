---
feature_ids: []
topics: [windows, acp, dsh, pi, security, issue1653]
doc_kind: independent-security-review
created: 2026-10-21
reviewed_head: 4a0b6833b748951f0378793d6cf77aeed24a469c
review_subject: local-task:issue1653
verdict: supported
---

# #1653 独立安全审查

## 结论与范围

**结论：supported。已审范围内未发现阻断本次修复的 P1/P2 问题。**

- 审查者：`security_review_1653`，当前任务的独立非作者 GPT 实例；没有编写生产代码或测试，不声称跨模型家族审查。
- 精确代码版本：`4a0b6833b748951f0378793d6cf77aeed24a469c`。
- 比较基线：`44fb36e65b3a9ea4ebb9a9a875e0605c06f80289`。
- 约定：用户批准的独立 worktree、先安全回归再修复、不改系统盘 ACL、不扩大可信主体；原企业机器尚未验证的部分单列。
- 依据：完整生产代码差异、受影响调用链、定向安全测试、作者原始构建/运行日志；没有修改系统配置或既有 ACL，没有连接生产 Redis、启动真实 DSH/Pi 或发起模型请求。

此结论支持当前代码进入后续交付和原机验收，不能替代原企业机器的普通用户验收、Issue 关闭或 GitHub 正式批准。

## 核心判断

1. **权限例外范围正确。**只有受审启动链能够启用 `allowVolumeRootDelete`。同一原生句柄核验目录属性、卷内名、最终卷 GUID 路径、NTFS、持久 ACL 与固定本地卷；未依赖字符串盘根。普通祖先保留完整危险权限掩码；真实卷根仅排除自身 `DELETE`，仍拒绝非可信主体的 `DELETE_CHILD / WRITE_DAC / WRITE_OWNER`。
2. **信任集合与私有创建保持边界。**当前用户、SYSTEM、Administrators 及祖先 owner 的既有 TrustedInstaller 规则未扩大。新 root/cwd 使用原子 owner-only、禁继承 DACL；已有目录只检查、不接管、不修复。已有 root/cwd 完整性检查先于祖先迁移判断，不能通过迁移掩盖已遭破坏的私有目录。
3. **ACL 与原生查询失败关闭。**原始 DACL 中未知、对象、回调 ACE 和 null DACL 拒绝；Generic rights 展开后检查。SUBST、junction、身份查询失败不能取得卷根例外。只有结构化祖先错误可以继续检查候选；私有目录错误、特殊 ACL 和校验器不可用不会被错误文本正则转成迁移许可。
4. **共享祖先发现受到限制。**内置 Pi bridge 的初始化不启动 Pi；真实 Pi 在 `session/new` 使用请求项目 cwd。DSH 只接受已审 0.2.0-rc.2 关键编译文件、精确 `--profile acp`、默认 bundles 和无操作 patch。新 profile 仅在目录缺失或完全为空时准入。该 DSH 启动链只读精确 cwd/HOME 的 `.env`，安装/profile 为模块解析锚点，默认 ACP 禁用 HMR。外部 bridge、其他版本和自定义 patch 不取得例外。
5. **最终环境和冷启动契约一致。**Windows 环境变量按大小写无关方式检查，歧义 key、Node hooks、相对/tilde DSH_HOME、默认 HOME 与子环境 USERPROFILE 不一致均拒绝例外。池签名含实际 cwd 与隔离类型；冷启动固定原 root，并在两个真实 spawn 入口重新核验实际计划、环境与目录。Factory 管理的 Windows 启动不会通过普通 `mkdirSync(..., 0700)` 绕过私有创建。

微软机制依据：[真实卷根不能重命名](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)、[目录创建时提供安全描述符](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw)、[Generic access rights](https://learn.microsoft.com/en-us/windows/win32/secauthz/generic-access-rights)。未对真实卷根尝试删除、改名或设置 reparse。

## 独立运行的测试

本轮独立运行 7 个文件，**46 tests，46 pass，0 fail，0 skip，进程退出 0**：

- `acp-bootstrap-ancestor-security.test.js`
- `acp-bootstrap-volume-root.test.js`
- `acp-bootstrap-relocation.test.js`
- `acp-bootstrap-startup-policy.test.js`
- `acp-bootstrap-spawn-recheck.test.js`
- `acp-bootstrap-windows.test.js`
- `acp-pool-signature.test.js`

命令采用 `node --import ./packages/api/test/helpers/setup-cat-registry.js --test --test-concurrency=2 --test-timeout=90000` 加上述文件。TMP/TEMP/TMPDIR 指向作者为本任务新建的私有 fixture，`ACP_BOOTSTRAP_TEST_VOLUME=G:\`，显式指定已审 DSH 安装入口，Redis 地址为不可连接的 `127.0.0.1:0`，配置根在本 worktree `.tmp/isolated-config`。第一次在受限文件系统沙盒中因 fixture `mkdtemp EPERM` 在测试加载阶段退出，随后按已授权的原生测试范围提权重跑并通过；该首次退出不作为产品回归。

覆盖普通祖先的五种危险权限、原始 GenericAll/回调 ACE、SUBST、目录完整性优先、卷根正/反向、迁移分流、受审启动链、spawn 前复检、private DACL/继承/junction/owner/校验不可用及池签名。G 卷正向测试比对卷根 SDDL 前后相同，测试 UUID 直属目录在结束后已无残留。

没有重跑 `acp-bootstrap-audited-runtime.test.js` 的真实 DSH/Pi 运行验收。既有 startup-policy 测试中的 bridge 初始化指向不存在的 Pi 命令，证明初始化不会启动 Pi，没有模型调用。作者此前真实 Pi/DSH 各两次初始化日志和标准 API build 日志已回读；作者运行两项通过不等于当次混跑整套通过，最终更大范围的 177 项结果属于作者证据，不计入独立 46 项。

原生测试令牌为管理员，不能据此宣称标准用户或第二账户攻击测试已完成。

## 测试残留只读核验

作者 fixture base 内的两个 `dsh-acl-skill-*` 目录各有 `SKILL.md` 与 `scripts/diagnose-windows-sandbox-acl.ps1`，文件 SHA-256 分别为 `9c616c78892daeaea864a9b2d6baaea91ff133cf83cde0b725c6caee2d4933cb`、`adba89f3b10692302723d231d003cdf365311effaff996d32416f9531e3b63d9`，与已安装官方 DSH 包的 bundled assets 完全一致。官方 `registerAclDiagnosisSkill` 在挂载时创建该目录。两个 `dsh-spill-*` 目录为空。创建时间与作者真实 DSH 初始化对应，没有会话、数据库或其他用户持久数据；它们不是本审查者创建。

本轮测试另产生隔离 registry template fixtures，均在同一本任务 base。审查者未执行任何清理。作者应结合本任务 manifest、reparse 与进程归属检查收尾，不能以名称前缀清理其他位置的数据。

## 原企业机器仍未验证

1. 企业机器实际 DSH 版本、编译文件哈希、默认 bundles、patch 与启动环境是否满足准入；未知版本和自定义启动链继续拒绝例外。
2. 原机数据卷的真实身份、owner、原始 ACL，以及普通用户是否能创建直属私有目录；没有合格候选时应继续失败。
3. AppLocker、WDAC、PowerShell Constrained Language 等是否允许原生查询和原子 ACL 创建；不可用时不能旁路。
4. 第二个非可信普通账号不能读取、修改、删除、重命名或替换私有目录，以及恶意祖先配置不能影响 bootstrap 的实际攻击测试。
5. 原机安装包/GUI 中实际成员绑定、`session/new` 的真实项目 cwd、模型往返、取消、关闭重连和历史回读。
6. 原机 C/D 卷根及相关用户路径 ACL 前后比对。本机 C 根 owner 与原企业镜像不同，本机正向测试不能当作原问题端到端复现。

以上缺口应在最终交付中保留；当前结论没有将其标为已完成。
