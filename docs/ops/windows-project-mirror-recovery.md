---
feature_ids: []
topics: [windows, desktop, startup, junction, troubleshooting]
doc_kind: guide
created: 2026-10-22
tips_exempt: 首启自动恢复缺陷修复，沿用现有启动及日志入口，不新增用户操作。
---

# Windows 首启项目资源镜像恢复

关联 [Issue #1689](https://github.com/zts212653/clowder-ai/issues/1689)。本修复针对安装完成后，桌面在 `Project mirror readiness failed before API start` 阶段退出的问题；此时尚未启动 API，也未调用 agent client。

## 自动恢复的边界

桌面把安装目录中的只读资源提供到用户数据根下的 `project`。Windows 启动会把 `docs`、`cat-cafe-skills`、`assets`、`guides` 四份完整资源树准备为普通目录，避免关键消费者依赖用户创建的 NTFS junction；其他便利镜像仍可使用链接。就绪检查覆盖以下三份实际会使用的资源：

```text
docs/harness-feedback/eval-domains/eval-design-gate.yaml
cat-cafe-skills/refs/shared-rules.md
cat-cafe-skills/custody-recognition/SKILL.md
```

插件分离后，旧 `plugins/github/plugin.yaml` 不再是 Host 首启的必需资源；安装目录仍有 plugins 时仍可映射该目录。

四根资源准备并完整读取通过后继续启动。读取失败时，在原有有限就绪预算内区分安装源文件和项目镜像的错误，执行退避重试及受控的链接恢复；还可使用本次启动 API 所选的同一 Node 可执行文件，在继承当前用户权限的新进程中实际读取源文件和全部关键镜像。只有完整读取通过才允许启动后续服务，不以 source 正常或进程退出码为零代替镜像实读。

恢复只处理已知资源目录中可确认的链接入口，不递归删除链接目标。已有真实目录、自定义文件、配置、角色、认证、Redis、SQLite 和会话历史保持原样。真实目录缺少必需资源、源文件确实缺失或持续无法读取时，仍明确拒绝启动，不通过覆盖用户文件、提权或修改系统盘 ACL 解决。

取消启动时同时停止本次的探针子进程；不会继续启动 API。代码不改变 ACP 的信任、审计、权限模式或客户端命令参数，内网包可继续保留其 CodeAgent 接入。

### 自动准备、升级及失败重试

Windows 首次和旧包升级启动均主动准备四根完整资源，随后验证源与项目路径。API、治理规则、提示词和 ACP 客户端继续使用原来的项目相对路径，不是只复制三个探针。此过程无需用户配置新环境变量、提权、修改 ACL 或重建角色。非 Windows 或后续实际读取失败仍保留原 consumer 恢复路径。

复制由隐藏的独立 Node worker 执行，另有最多 60 秒的有界预算，支持取消启动。它先核对入口确实是本次安装源的链接，拒绝源树中的 reparse entry，在旁边创建受管理 staging，完成全量源/副本摘要校验后再交换入口。复制或发布失败会恢复原入口；取消留下的已记录事务由下一次启动先恢复，避免反复积累 staging。空间不足或文件访问失败保留原错误及可重试状态，不通过覆盖用户数据解决。

实体目录含 `.clowder-bundled-resource.json` 全量清单。每次启动验证所有受管理原文件；内容未变不重写。新增评测结果等普通用户文件不会被读取、复制或删除，也不阻止普通重启。安装源有更新且目录包含用户新增内容时，保留整个原目录并记录 `refresh deferred`，由用户合并资源变更，不自动搬运或覆盖业务数据。受管理原文件被修改、未知真实目录、非法清单、链接、变更后的备份/staging 仍保留并明确拒绝替换；请勿手工修改清单绕过保护。配置、身份、认证、Redis、SQLite 和历史不参与复制和替换。

旧静态回退完整校验后先原子移出恢复槽，再清理；清理失败只留下独立 `retired` 静态副本并在结果记录其路径，不会让下次健康启动永久卡在部分删除的回退上。被用户修改的回退不进入清理。

MCP 二进制使用安装根 `CAT_CAFE_RUNTIME_ROOT`，可写数据配套映射到 `CAT_CAFE_WORKSPACE_ROOT`；由 Host 启动时传给 API，无需用户手写配置。普通部署保留已有显式工作区，隔离实例强制使用自己的 project，配置和历史仍在既有持久根，不经 project/packages 的便利链接解析 MCP。

## 如何看日志

启动失败弹窗的“打开日志目录”指向当前实例实际目录。查看其中 `desktop.log`，搜索：

```text
Project mirror parent read failed
Project mirror consumer diagnostic
Project mirror materialization
refresh deferred
Project mirror readiness verified
Project mirror readiness failed before API start
failed to prepare mirror
Preserving existing non-link mirror
```

成功日志会标明读取验证路径：父进程、重试后的父进程，或实际 Node consumer。失败日志区分 `source` 和 `mirror`，并保留路径、`code`、`errno`、`syscall`，用于判断安装源文件问题还是项目镜像入口问题。`UNKNOWN` 本身不能确认 Windows 原始错误码或缓存机制。

每次 consumer 都记录 `started` 和 `settled` JSON 事件。用 `attempt` 配对，查看 `pid`、实际 `executable`、`budgetMs`、`elapsedMs`、`entryCount`、退出码/信号、输出字节数、`status` 和逐文件失败项。`started` 表示已尝试启动，非空 PID 说明进程已创建；只有 `settled` 且 `status: ready` 才证明本次六项读取全部完成。`read_failed` 是已完成读取但有文件失败；`timed_out`、`aborted`、`spawn_failed`、`exited`、`invalid_output` 分别表示超时、取消、启动失败、异常退出、返回协议无效。退出码为零本身不代表文件可读。

弹窗和 `startup-state.json.message` 保留短摘要。完整结构化失败记录另外写入 `main.log` 的 `Desktop startup diagnostic` 行和 `startup-state.json.diagnostics`，包含最终父进程读取结果及所有 consumer 完成结果，不再丢失末轮诊断。不记录文件内容、环境变量、原始 stdout/stderr 或任意异常堆栈；只记录输出字节数和已知资源路径的错误字段。异常规模超过防护上限时，会明确记录 `omitted`/`omittedFailures`/`truncatedFields`，而不是无提示截断。

在弹窗打开的日志目录执行（不要自行假定其他安装实例的目录）：

```powershell
Get-Content -LiteralPath .\desktop.log -Tail 500 |
  Select-String 'Project mirror|failed to prepare mirror|Preserving existing'
Get-Content -LiteralPath .\main.log -Tail 150 |
  Select-String 'Desktop startup FAILED|Desktop startup diagnostic|identity'
$state = Get-Content -LiteralPath .\startup-state.json -Raw | ConvertFrom-Json
$state.diagnostics | ConvertTo-Json -Depth 12
```

| 日志结果 | 含义及处理 |
|---|---|
| parent reader 验证通过 | 普通启动路径，无需额外操作。 |
| bundled Node consumer 验证通过 | 当前桌面读取失败，但真正启动 API 的 Node 已完整读取源和镜像，自动继续。 |
| source 读取失败 | 保留对应安装路径和错误码，核查安装资源及实际运行账户。 |
| mirror 读取失败、source 正常 | 检查同次日志中的建链/重建信息、目标路径及真实目录保留提示。 |
| Preserving existing non-link mirror | 已有真实目录或不能安全确认类型的入口已保留，不自动覆盖。 |

反馈时附上发生时间、`projectRoot`、`User data dir`，以及对应 source/mirror 错误和恢复结果。用户名和企业路径可以脱敏，但保留路径层级及错误类型。

## 核对安装包和实际运行组件

`1.14.0` 是产品版本，相同版本号可以对应多个测试构建。安装器文件名、API/Web 的提交标记、桌面 `app.asar` 分别核对，不能用 API 提交号推定桌面源码。先从 `main.log` 的 `[identity]` 行确认实际 `execPath`、`resourcesPath`、`projectRoot`，避免读取另一个安装实例。下面的路径由这次运行的实际值填写；Windows 的 `projectRoot` 通常是安装根，不能直接当成 `resourcesPath`：

```powershell
$setup = 'D:\交付包\实际安装器.exe'
$resources = 'C:\实际安装目录\desktop-dist\resources'
$projectRoot = 'C:\实际安装目录'
Get-FileHash -LiteralPath $setup -Algorithm SHA256
Get-FileHash -LiteralPath (Join-Path $resources 'app.asar') -Algorithm SHA256
Get-Content -LiteralPath (Join-Path $projectRoot 'packages\api\dist\.build-commit')
Get-Content -LiteralPath (Join-Path $projectRoot 'packages\web\.next\.build-commit')
```

将安装器 SHA256 与交付的 `build-manifest.json` 对照，同时记录安装目录的两个标记和 ASAR 哈希。manifest 描述构建时的输入与产物，不能证明后来安装目录未被其他安装/部署覆盖。API/Web 标记不同或与交付源提交不同，应先查清组件来源；不要覆盖已有配置或历史来排除问题。

开发者进一步核对实际 `app.asar` 中入口、readiness、consumer 与诊断模块，以及 `app.asar.unpacked` 中 `project-mirror-materialization-worker.js`、`project-mirror-resource-state.js` 的内容哈希。使用本仓库 `desktop` 的 `@electron/asar` 依赖读取，不在内网临时下载工具。例如在已安装开发依赖的源码目录执行：

```powershell
@'
const a = require('./desktop/node_modules/@electron/asar');
const c = require('node:crypto');
for (const n of ['service-manager.js', 'project-mirrors.js', 'project-mirror-readiness.js',
  'project-mirror-consumer.js', 'project-mirror-diagnostics.js', 'startup-error-diagnostics.js']) {
  try {
    const b = a.extractFile(process.argv[2], n);
    console.log(n, c.createHash('sha256').update(b).digest('hex'));
  } catch {
    console.log(n, 'MISSING_OR_UNREADABLE');
  }
}
'@ | node - (Join-Path $resources 'app.asar')
```

这里通过标准输入传递脚本，兼容 Windows PowerShell 5.1 的参数引号规则，不需要修改执行策略。`MISSING_OR_UNREADABLE` 表示未读到模块，还需区分确实不存在与 ASAR 无法读取；不能直接当成旧版本的证据。

这一步只读安装包与组件，不启动服务、不执行资源中的脚本、不修改安装目录或 ACL。确认缺少桌面模块可以说明版本不含对应实现；仅有恢复日志、PID 或安装器的同名版本号不足以证明具体源码提交。

## 验证口径

回归需要覆盖首个读取失败、父进程持续失败而实际 Node 可读、docs 和 skills 两类镜像、旧/失效 junction、真实目录保护、源缺失、持久失败、取消和超时后的探针回收。

真实 Windows RedirectionGuard 回归使用一次性进程启用并读回继承的 EnforceRedirectionTrust：旧的非管理员 junction 三份镜像稳定 UNKNOWN/-4094/open，随后四根准备、实际 Node 读取、design-gate/custody/governance/提示词/L0/ACP MCP 消费者及 ACP 夹具/MCP 握手通过。未模拟该 UNKNOWN、未修改系统策略或磁盘 ACL。这证明一种可产生同类故障的 Windows 机制，不能唯一归因现场天擎或 Defender。

正常安装后的实测另外验证最终 EXE 接线、Medium 启动和历史/绑定回读；原生 Guard 源码回归不能代替安装包验收，ACP 夹具和 MCP 工具发现也不代表企业 CodeAgent 或真实模型调用验收。
