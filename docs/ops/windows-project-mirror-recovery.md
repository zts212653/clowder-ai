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

桌面把安装目录中的资源提供到用户数据根下的 `project`。Windows 的 `docs`、`cat-cafe-skills`、`assets`、`guides` 现在使用普通目录，首次启动自动完成，不需要设置兼容变量或寻找引导目录。已有旧 junction 只替换链接入口，目标不变；其他便利映射沿用原逻辑。MCP 二进制直接从安装根解析，避免依赖 `project/packages` junction。就绪检查仍覆盖以下三份实际会使用的资源：

```text
docs/harness-feedback/eval-domains/eval-design-gate.yaml
cat-cafe-skills/refs/shared-rules.md
cat-cafe-skills/custody-recognition/SKILL.md
```

插件分离后，旧 `plugins/github/plugin.yaml` 不再是 Host 首启的必需资源；安装目录仍有 plugins 时仍可映射该目录。

普通目录发布前，完整读取源资源树并计算逐文件 SHA256，暂存副本写完后再次实读比对，展开安装根内的资源链接，拒绝越界和环。准备完成后，仍在原有有限就绪预算内区分源文件和项目资源的错误，执行退避重试；还可使用本次启动 API 所选的同一 Node，在继承当前用户权限的新进程中读取全部探针。只有完整读取通过才允许启动后续服务。

RedirectionGuard 开启时，Windows 可能禁止跟随非管理员创建的 junction；已在真实开启该防护的进程及继承防护的 Node 子进程中复现 UNKNOWN/-4094/open，并验证普通目录可读。该实验解释了一种机制，不能单凭 UNKNOWN 唯一归因现场 EDR；修复不关闭 RedirectionGuard、Defender、EDR 或任何安全防护。

已有真实目录无受管理标记时保留，不自动采用或覆盖。受管理副本内容未变时重复启动不重写；升级先准备新副本，再发布并保留一个静态回退副本。发布失败回滚，下次启动可恢复两次 rename 间的中断；不完整暂存改名留存后重试。配置、角色、认证、Redis、SQLite 和会话历史保持原样。

受管理资源中的原有文件被修改、标记损坏或存在不安全链接时，日志给出路径并停止，不自动覆盖。新增评测结果等用户文件保留且不阻止普通重启；若同时发生资源版本变化，日志显示 `Preserving extended resource directory ... bundled refresh deferred`，该目录继续使用当前副本，资源更新需人工合并，不把业务数据移入暂存/回退目录。真实目录缺少探针、源缺失或持续不可读时仍拒绝启动。不要为此修改系统盘 ACL 或关闭防护。

取消启动时同时停止本次的探针子进程；不会继续启动 API。代码不改变 ACP 的信任、审计、权限模式或客户端命令参数，内网包可继续保留其 CodeAgent 接入。

## 如何看日志

启动失败弹窗的“打开日志目录”指向当前实例实际目录。查看其中 `desktop.log`，搜索：

```text
Project mirror parent read failed
Project mirror consumer diagnostic
Project mirror readiness verified
Project mirror readiness failed before API start
failed to prepare mirror
Preserving existing non-link mirror
Bundled resource materialized
Bundled resource verified
Bundled resource preparation failed
Restored interrupted bundled resource publication
Retained interrupted bundled resource staging
Retained retired bundled resource backup
Preserving extended resource directory
```

成功日志会标明读取验证路径：父进程、重试后的父进程，或实际 Node consumer。失败日志区分 `source` 和 `mirror`，并保留路径、`code`、`errno`、`syscall`，用于判断安装源文件问题还是项目镜像入口问题。`UNKNOWN` 本身不能确认 Windows 原始错误码或缓存机制。

每次 consumer 都记录 `started` 和 `settled` JSON 事件。用 `attempt` 配对，查看 `pid`、实际 `executable`、`budgetMs`、`elapsedMs`、`entryCount`、退出码/信号、输出字节数、`status` 和逐文件失败项。`started` 表示已尝试启动，非空 PID 说明进程已创建；只有 `settled` 且 `status: ready` 才证明本次六项读取全部完成。`read_failed` 是已完成读取但有文件失败；`timed_out`、`aborted`、`spawn_failed`、`exited`、`invalid_output` 分别表示超时、取消、启动失败、异常退出、返回协议无效。退出码为零本身不代表文件可读。

弹窗和 `startup-state.json.message` 保留短摘要。完整结构化失败记录另外写入 `main.log` 的 `Desktop startup diagnostic` 行和 `startup-state.json.diagnostics`，包含最终父进程读取结果及所有 consumer 完成结果，不再丢失末轮诊断。不记录文件内容、环境变量、原始 stdout/stderr 或任意异常堆栈；只记录输出字节数和已知资源路径的错误字段。异常规模超过防护上限时，会明确记录 `omitted`/`omittedFailures`/`truncatedFields`，而不是无提示截断。

在弹窗打开的日志目录执行（不要自行假定其他安装实例的目录）：

```powershell
Get-Content -LiteralPath .\desktop.log -Tail 500 |
  Select-String 'Project mirror|[Bb]undled resource|failed to prepare mirror|Preserving'
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
| Bundled resource materialized / verified | 已完成普通目录全量准备或校验，条目数和耗时在同一行。 |
| Restored interrupted / Retained interrupted | 已自动恢复旧副本或留存不完整暂存，下次启动重试，无需删除用户数据。 |
| Retained retired bundled resource backup | 旧静态备份清理失败，已退出发布槽位并留存，不影响当前副本或下次重试。 |
| bundled refresh deferred | 目录有用户新增内容，当前副本保留；需要人工合并该目录的资源升级。 |

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

开发者进一步从实际 `app.asar` 读取 `service-manager.js`、`project-mirrors.js`、`project-mirror-readiness.js`、`project-mirror-consumer.js` 四个文件，比较内容哈希并记录是否统一换行；新增诊断版本还应包含 `project-mirror-diagnostics.js` 和 `startup-error-diagnostics.js`。使用本仓库 `desktop` 的 `@electron/asar` 依赖读取，不在内网临时下载工具。例如在已安装开发依赖的源码目录执行：

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

故障注入回归证明恢复行为，正常安装后的实测证明打包接线与启动流程；二者分别记录。它们不等同于已在企业文件系统环境重现 Windows 底层竞态，也不代表真实企业 CodeAgent 的端到端验收已经完成。
