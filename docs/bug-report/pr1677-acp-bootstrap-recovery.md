---
feature_ids: [F241]
topics: [acp, windows, plugins, security, recovery]
doc_kind: verification
created: 2026-10-22
---

# PR #1677：ACP 安全引导目录与失败恢复

## 问题与修复

企业 Windows 的系统盘祖先 owner 或 ACL 不符合信任边界时，ACP 进程会在启动前被拒绝。
只把 exe 放到其他盘、在不可信父目录下新建文件夹，不能解决祖先可被替换的问题。
此前通用客户端没有数据卷候选发现入口，失败的服务构建 Promise 又被缓存，修复实际条件后仍无法重试。

- 自动模式向所有 ACP 客户端开放本地固定 NTFS 数据卷候选发现；每个候选仍执行完整的 owner、私有 DACL、祖先权限、reparse 与真实卷身份校验。
- 插件目录项可配置 `bootstrapRoot`。显式路径失败即拒绝，不自动切换，也不获得 DSH/Pi 专用审计特例。
- 本地所有者可在插件页检查目录；CLI 与 UI 使用同一检查器。没有跳过校验、增加可信 SID 或修补已有 ACL 的选项。
- 构建失败或未返回服务时，释放该次失败缓存；下一次显式消息可重试。成功服务继续复用，旧失败不能清除新配置的服务。
- Windows 缺失目录错误改为可读的结构化结果；严格模式同样验证真实卷身份，拒绝 SUBST 隐藏物理祖先。
- Linux/macOS 检查及显式路径只创建新的私有目录，已有目录仅检查 uid/0700，不执行 chmod；同时检查完整逻辑和真实父链，拒绝非可信 owner 或非 sticky 的组/其他用户可写祖先，允许可信的 sticky `/tmp`。

没有修改系统盘、用户目录或其他已有目录的 owner/ACL。普通自动 Unix runtime 的既有权限兼容行为不在此次变更范围。

## 用户具体操作

1. 更新到含本次修复的 Host PR #1677，重建并重启 API 和 Web。
2. 在 **Host 电脑本机浏览器**以所有者身份进入「设置 → 插件 → ACP 客户端目录」。现有插件管理仍只允许直接本机访问。
3. 找到目标 client 的「引导目录」，先留空，点击「检查引导目录」。成功后页面会列出实际完整路径。
4. 点击「使用此目录」再「保存配置」，即可固定该路径；继续留空则保留自动选择。随后给绑定的角色发消息。

无需猜目录或到磁盘中逐个寻找。也可填本机绝对路径（如 `D:\ClowderBootstrap\my-agent`）再检查；
父目录必须已存在且合格，最后一级专用目录可以由 Host 创建。该目录用于 ACP 进程启动，项目目录仍由会话传递。

源码环境在 Host 根目录运行：

```powershell
node --import tsx scripts/check-acp-bootstrap.ts
node --import tsx scripts/check-acp-bootstrap.ts --root 'D:\ClowderBootstrap\my-agent'
```

使用运行 API 的同一个账户。`ok: true` 返回的 `root` 才是通过校验的路径。
检查会创建专用目录和空诊断子目录，不启动客户端或调用模型；目录成功不等于 ACP、认证、模型、MCP 已成功。
修复实际条件后再次发消息即可恢复；没有后台自动重发。清空字段并保存可恢复自动模式。

若所有卷的祖先均不合格，需要管理员提供祖先链可信的专用本地 NTFS 位置（必要时专用数据卷），或换用合格 Host。
默认严格模式不能靠新建普通文件夹、改 exe 路径或接管系统盘解决。后续用户明确授权的[可信主机兼容模式](../ops/acp-trusted-host-compatibility.md)允许跳过祖先信任校验，并清楚呈现风险与审计告警；其余目录自身与鉴权限制保留。具体说明见：

- [Host 启动、安装及配置](../ops/acp-client-plugin-user-guide.md)
- [新客户端入口发现与分阶段能力验证](../ops/acp-client-onboarding-and-verification.md)

## 本轮验证证据

代码基线为 `a61526a565c9efa1d9a23f73118c9fb721653614`，主修复为 `0b3064f957ac2c295abbac07adb800f05ed4f7d7`；
独立审查补充的 POSIX 权限及父链修复为 `b01a42748baee71c4e0ec520318e7f17456d5864`、`fb95fab9c69a932f910721d3ebe57a5cc4f84bac`。

| 范围 | 结果 |
| --- | --- |
| bootstrap + session contract 核心回归 | 238 项：232 PASS、0 FAIL、6 SKIP；跳过项需显式原生数据卷/审计 DSH fixture 或属于 POSIX 原生检查 |
| POSIX 检查、显式冷启动及共享祖先 | 5 PASS；先观察 chmod/共享父目录反例为 RED，再修复为 GREEN；本机 Windows 模拟 POSIX 元数据，原生执行已加入 Linux CI |
| Web 目录字段、插件管理及成员绑定 | 35 PASS；Web TypeScript 检查通过 |
| shared/API/MCP 构建 | 通过；源码与受影响文件格式检查通过 |
| UI | 自动发现实际目录 → 选用 → 保存 → 重进仍存在；指定缺失父目录显示可读拒绝信息 |
| 自定义 ACP 恢复 | 同一个 API 进程、同一配置：缺失父目录导致首次失败 → 创建合格父目录 → 再发消息成功，无须重启 |
| dsh → Claude → pi | 插件安装、命令配置、成员绑定后，真实调用 Clowder MCP 读取上下文、派发下一角色、持久发布回执 |
| API 重启续接 | 三客户端均保持各自原生 session ID，重启后再次实际调用 MCP 读写并完成回复 |

真实调用使用独立的项目、Redis 和原生 HOME；仅复用本任务隔离认证设置，没有绑定用户生产原生历史。
MCP 实测为 stdio；HTTP 只有参数映射测试。最后两条 POSIX 修复没有改变 Windows 执行分支，复用已完成的模型验证，不重复制造调用。
原始日志、会话 ID、认证及持久数据留在作者隔离目录，没有上传。

扩大 ACP 检查为 639 项：632 PASS、4 FAIL、3 SKIP。三项（AGY permission alias、两个 host-media-ledger fsync EPERM）
已在原始基线分别复现；另一个 Windows 取消夹具清理 EBUSY，串行重跑 2/2 PASS。
这不是全仓全绿结论；须消费本次新 HEAD 的远端 CI。

## 内网续办：显式可信主机兼容模式

用户报告自选目录检查通过，但保存显示 `Plugin audit log is unavailable`；CodeAgent 另有 `prompt_failure: EPERM`。
保存路径在调用配置服务前先追加审计；追加失败返回 503，因此不能把目录检查通过当作配置已经生效。审计实现只是追加文件，不执行 bootstrap 祖先校验；不能把两种错误统称为同一个安全检查问题。

当前契约已将目录信任 B 和审计准入 C 拆成两个 Host 持久配置键，详见[兼容模式指南](../ops/acp-trusted-host-compatibility.md)。旧 `CAT_CAFE_TRUSTED_HOST_COMPATIBILITY=1` 仅在对应新键未设置时映射受限组合，并在启动时告警。
Windows 的 B 跳过祖先 owner / DACL 信任，保留自身私有 DACL、真实 NTFS、非 reparse 与 spawn 复验。C 仅对已安装且授权的已有 ACP client 的真实引导目录变化开放；命令、参数、名称、ID、MCP、其他字段、新增 client 或混合更新均不获例外。成功保存的审计缺失以独立 warning 展示。
登录、owner、本机/Origin 与受限角色策略不变，其他插件生命周期和工具审计仍按原规则。
默认严格模式保持。API 不写部署配置；一次准备与模板归独立 D 交付，普通启动不补键、不迁移日志。以下早期验收数字对应当时版本，不能替代最新 HEAD 的回归和 CI。

本机已验证：目录祖先宽泛授权的默认拒绝→开启后创建私有目录→不修改祖先 ACL→坏自身 ACL/junction/SUBST 仍拒绝→关闭后重新拒绝。
生产 HTTP handlers 配合真实配置文件及合成 ACP 原生子进程完成检查、审计失败告警保存、重新读取、initialize、session/new、prompt 和严格模式恢复。零模型调用，未连接原企业机或真实 CodeAgent。
配置 API 回归 34 PASS，Web 相关 24 PASS，注册表核心 29 PASS；既有 233 项元数据序列化内容和顺序保持不变。
扩大运行注册表测试有 4 个 Windows 限制：两项断言绝对路径以 `/` 开头，两项依赖缺失的 `sh`；相关代码未改，不能将此描述为全文件本机通过。

## 验收边界

- 未连接报告问题的企业/内网机器，也未完成其标准用户/第二账户验收；远端需按上述步骤复验。
- 本机没有真实 CodeAgent；通用 ACP fixture 的启动及恢复成功不等于已验证 CodeAgent 的模型、MCP 或续接能力。
- 接入新客户端仍需逐项验证 ACP 初始化、会话、工具、MCP、失败恢复；仅配置 `codeagent --acp` 不能证明全部能力。
- 插件仍为本地候选包；没有 npm 发布、PR 合并或生产部署。临时服务按实例台账受控停止，持久认证和历史保留。
