---
feature_ids: [F155, F229, F320]
topics: [onboarding, windows, installer, review, recovery]
doc_kind: verification-record
created: 2026-10-15
---

# Windows 安装、恢复与最新 review 对账

对应 PR #1519；这是作者实测记录，不是正式 approval 或 #1466 整体验收。生产实例和用户正在体验的 Fresh 实例均未用于故障注入。

## 两条 P2 与同型排查

运行源码 `a73e5829c5092f1c2f193d583b562518e2297d48`：

- zts 6182618670：API 输入目录先 realpath，统一 esbuild 文件路径、dist 边界与相对模块 URL 的坐标。Windows 原生 junction 入口先 RED，再通过；物理入口与别名入口均打包、搬移，然后比较原始 Node 入口与 bundle 的实际模块 URL、资产值 7、worker 值 9，2/2 PASS，零跳过。
- zts 6182789020：成功接受 PUT 是新的读取时序边界。保存期间发起的旧 GET 不能在确认后改回 UI，错误响应同样不能覆盖已确认状态。classic 默认猫 8 项回归通过；同型检查发现 v2 成员 hook 也缺时序边界，补读序号、卸载清理和保存前后两次失效，三个回归先 RED 后 GREEN。没有隐式 PUT 或更改用户默认选择。
- `test:first-run-onboarding` 已纳入这两类前端回归；API bundle 的原生回归由 Windows Desktop 组执行。非作者增量复核当前 SHA 未发现新增 P1/P2；其 fixture 检查不替代下面的完整 EXE 旅程。

## 失败闭锁：最小实验的原始输入与回执

zts 6182938035 要求可追溯的脚本、编译器版本和退出/后置动作日志。以下为独立 reviewer 原始实验的可复现输入；只将绝对 checkout 和实验输出根改为调用者自己的目录。编译器和生成的 Setup 均为 **Inno Setup 7.1.0 (32-bit)**，Windows x64。

```ini
[Setup]
AppName=Independent Runtime Latch Review
AppVersion=1.0
DefaultDirName={tmp}\independent-runtime-latch
Uninstallable=no
CreateUninstallRegKey=no
PrivilegesRequired=lowest
DisableStartupPrompt=yes
UsePreviousAppDir=no
OutputDir=.
OutputBaseFilename=fixture
SetupLogging=yes
[Files]
Source: "payload.txt"; DestDir: "{app}"; AfterInstall: ExerciseLatch
[Run]
Filename: "{cmd}"; Parameters: "/c echo reached > ""{app}\post-run-marker.txt"""; Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded
[Code]
#include "<checkout>\desktop\installer\runtime-failure.iss"
procedure ExerciseLatch;
begin
  if ExpandConstant('{param:Fail|0}') = '1' then
    FailRuntimeExtraction('Independent fixture extraction failure');
end;
```

`payload.txt` 为普通自有文本文件。以 `ISCC.exe fixture.iss` 编译，在三个不同、全自有的空目录运行；基础参数为 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=<case-root> /LOG=<case-log>`，不是操作已有用户目录。

| case / 附加参数 | 实际进程退出码 | post-run-marker.txt |
| --- | --- | --- |
| healthy / 无 | 0 | 存在 |
| failure / `/Fail=1` | 20 | 不存在 |
| failure-nocancel / `/Fail=1 /NOCANCEL` | 20 | 不存在 |

独立 `failure-nocancel.log` 原始关键记录（2026-10-15 10:12:47，本地时区 UTC+08）：

```text
Runtime installation failed: Independent fixture extraction failure
Defaulting to OK for suppressed message box (OK):
Independent fixture extraction failure
Installation did not complete. Your instance data is retained. Run this installer again to repair it.
Installation process succeeded.
Need to restart Windows? No
Deinitializing Setup.
Log closed.
```

**引擎仍会写 `Installation process succeeded.`**，所以该句不能用作成功判定。独立 wrapper 实际等待进程并读取 ExitCode=20，同时检查后置 marker 不存在；失败消息与退出码共同决定失败。作者自己的小型实验得到同样结果，两组不相加、不冒称完整安装恢复通过。

原完整旧故障包确实重现了 API SHA 失败后返回 0，并继续后置接线。`0ae388310` 加失败 latch，后续提取、全部 Run、静默和交互启动均受守卫；`db22e3d1e` 修旧测试断言。失败保留资料，**不承诺恢复旧可执行文件或事务式回滚**。原失败记录和需要手工处理悬空链接的旧恢复记录保留，不能转写为自动恢复成功。

## 最终载体与完整恢复

作者已在自有 Runtime2 实例执行 a73 完整包：故意错误 API SHA 的包在 114873ms 后退出 20，失败后无后续提取和 Run；直接重跑同版正常 Setup 在 152062ms 后退出 0，未手工删除链接或改配置。完整进程重启在 111245ms 达到 ready，API 首次监听 73794ms；逐条回读原三只角色、四个会话十条消息、默认路由和四个配置/身份文件，完全一致。十个全局 CSS 实际 HTTP 200 且与构建内容 hash 相等，安装版本和 API bundle hash 与指定载体一致。

这不是 a73 空目录首装数据，也不是自动回滚保证。之前 4d 空目录首装为 94508ms；两个候选、冷首装与覆盖恢复分开记录。当前没有受控多次缓存/磁盘负载基准，不将单次数据推成所有机器都同样快。

实物还发现隔离遗漏：a73 API 的预览网关沿用默认 4100，因已占用报 EADDRINUSE；没有成功接管旧服务。仅隔离桌面 API 环境改为 `PREVIEW_GATEWAY_PORT=0` 让系统分配独立端口，普通安装不设置此覆盖；renderer 已从本实例 `/api/preview/status` 获取实际端口并限制允许来源。真实子进程断言先 RED 后 GREEN，连同 renderer policy 14/14 PASS、无跳过。

463b582a3 壳包实际覆盖安装 133220ms、退出 0，完整重启 93231ms 达到 ready；预览网关 available，实际端口 54625。三角色、十消息、默认路由及四文件指纹保留；十个 CSS 为 200且 hash 一致。解锁后重新观察实际 Electron 的自动播放、typing、A2A、右侧逐步成果与主题颜色。这是合流下述新 main **之前**的载体，不能当作新消息生命周期的实装证据。

构建来源：Web 与 Electron/安装脚本源为 a73；Web BUILD_ID 为 `_a8gFRzq57qFR9BYEuIaE`。API 原编译 dist 来自 `63bcb3e733fef452b46e79ed9ee2ef63cd6aabef`，相关 API 源码连续未改；API 内部 bundle 使用 a73 工具重新生成。依赖锁不变，未声称 a73 全量重编所有 API。外部角色、默认路由、资料和认证不进入程序归档。

## DSH 与冷启动判断

- 项目使用 ACP stdio `dsh --profile acp`，用户启动 `npx @deepseek-ai/dsh web` 不是 ACP 认证证明。原隔离测试 HOME/npm cache 漏准备 ACP 连接；补齐后同进程重新检测能发现，无需重启。
- 测试快照 helper 默认不复制凭据；只有显式 opt-in，使用 COPYFILE_EXCL 补缺失文件。排除文件历史，canonical source/target 互不包含。用户明确授权两个隔离实例后才补各自缺失的凭据，源配置未改。Runtime2 真 ACP 请求已在 36314ms 返回 42，旧缺凭据失败记录仍保留。
- 旧 120 秒失败记录定位为模块加载/初始化耗尽预算：模块图 94857ms，CPU 6671ms，telemetry 103276ms、memory 105409ms，尚未监听。新的逐模块探针分开记录 read/resolve 与初始化阶段，不延长 120 秒。4d 首启模块图 58449ms，其中 read 49398ms；API 64546ms，桌面 107327ms。可以确定文件加载等待显著，不能直接断言 Defender 或某个磁盘为唯一原因，也不把一次热启动数字当冷启基准。

## Fallback 检查与未关闭的合同

`check-fallback-layers --base ec81f0ae0` 净增长 12，三文件达到单文件阈值。逐项判断：提取器新增 `||` 是路径 containment、SHA/count/入口拒绝条件，非逐层容错；原生 helper 的 SystemRoot 默认值、CPU priority 设置失败和错误码展示不改变解压成功标准；Unicode 是预检查后明确记录的单独引擎契约。DSH helper 的空相对路径与互相包含判定修正坐标边界，EXCL catch 只接受“目标已存在”且不覆盖，其余错误上抛。没有增加静默认证或数据源回退。

当前没有需驳回的具体技术建议，两条 P2 均有明确复现。mind/zts 并未要求自动回滚、默认复制凭据、改变认证 owner 或扩入 #1590/#1591，不能将未提出的要求列成“未采纳”。

保留独立验收项：macOS DMG、Kimi/OpenCode/Pi 真调用、0/1/N 与登录中断后的完整恢复旅程、F155/F229/F320/DSH 原合同及原 11 秒慢保存现场根因。Windows 实装、绿 CI、限定 review 或一个有用回复均不能替代这些项，也不自动关闭 #1466。

## main 7fca378fa 合流

上游合入 #1398 消息生命周期后产生十六个冲突文件。保留 main 的 MessageFrom、显式消息目标与 canonical carrier authority，将本 PR 的引导、保存诊断、native 配置与默认设置读取边界迁到新调用链：

- `configurationSource` 仍表示配置归属，不替代 `carrier`。native Codex 默认 App Server 在统一 resolver 的兼容输入边界处理，显式 canonical 值优先；生产 assembly 与 API 读模型只消费统一 carrier。
- 成员编辑的旧草稿只读转换 `codexCarrier/acpEnabled`，新写入使用 canonical 字段；运行工具切换仍保留各自草稿与用户选择。切离 ACP 后保留休眠启动配置，以 carrier 决定是否使用，不再因配置块存在就隐式路由。
- 未 ACK 的旧一键创建保留原 key 和旧 wire body，服务端只读接收旧 cli.carrier 用于 receipt 与转换，落盘使用 canonical carrier。不得用新 payloadHash 猜测归属，也不迁移角色 ID。
- ACP 最终工具参数的前端补齐迁入 main 拆分出的 active/background handler 与共用 tool event 构造器。历史链测试改用 main 正式的 MessageFrom 前提，仍真实经过 ACP service 和持久化 write/read。
- 锁文件自动合并保留了本 PR 的 Web Playwright 声明，却移除了 main 从其他包删去的同版本快照；仅恢复原精确三项快照后 frozen install 通过，没有放宽 SDK 版本。
- 治理检查原生 Windows 复现了动态 import 误用磁盘路径和 admission source 使用反斜杠的两个坐标问题；分别改为 file URL 和仓库 canonical 斜杠。原生 RED→GREEN，不跳过基线/attestation/cutover 验证；本地检查的保护目标须使用 PR 实际上游 SHA，旧 fork origin/main 不是该目标。

当前作者检查：API/shared 编译、Web 类型检查通过；原生 API 相关 136/136。合流后的完整 MCP 治理在实际上游 base 7fca 下通过，216 工具、各项 delta 为零，未重写 baseline、attestation 或 cutover。MCP 实现 4/4、evidence 5/5 通过。

## 合流增量与新载体来源

独立复核在 cce 发现旧草稿比较基线遗漏：只规范化 form.carrier，没有同步 baseline，导致只改昵称时把 carrier 误判为本地修改。550 同步迁移两侧后，“旧 App Server 基线、本地改昵称、服务端换 CLI”的回归由 RED 转 GREEN；8 项独立回归、11 项补充探针覆盖显式选择、原生默认、managed、三种 ACP 及 canonical 优先级。独立旧创建请求完整对象对照 16/16 一致。dda 只将退役字段删除改为无未用绑定的等价写法；不更改角色、会话或源配置。

dda0b590123bc81156bacf74e19f6bf73d245fcc 的正式 Web 构建通过，BUILD_ID 为 lhFK2ELSXJ6JU7YB5dm0v；正式引导 CI 入口 43文件/198项通过。API 正式构建来自 cce4d51179a108a68e47d1de58d3bbf83ee720a9，cce→dda 的 API/shared/MCP/collective 源码和锁文件没有变化；新生产依赖已按合流锁重新 frozen install，未复用旧 SDK 依赖归档。API bundle 3241 个内部模块、17671748 字节，保持外部依赖、worker 与真实模块 URL。归档和 Electron 壳来自 dda，不将之后的测试/文档提交冒称运行源码重编。

dda 云端 distributable-5 的原始日志另暴露 4 条旧 Codex 模式夹具前提失效。main 已将 carrier 选择收敛到服务构造注入；直接构造服务的夹具没有显式 carrierMode，错误进入 exec_json，而不是所模拟的 App Server。只给 registry 添加 canonical carrier 的第一次复验仍失败，保留此记录；同步明确构造选项后 5/5 通过。负例同时断言实际 thread/start 已到达、turn/start 未发出，避免任意前置错误造成假绿。产品路由/超时/认证规则未改。

最新完整安装、重启、实际请求与云端 CI 的回执继续在 [PR 原位对账评论](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6182906767) 更新；各候选分别记录，不把上文 a73/463 的实物结果挪到新 main 名下。完整 fallback 基线相对 main 的历史 PR 累积量与本轮窄修分开判断；本次草稿修复在同一读取边界统一两侧坐标，没有新增配置/认证静默回退，测试夹具修复也不新增生产 fallback。

作者已实际安装 dda 的 RuntimeMain：覆盖升级 122224ms、退出 0，四文件指纹不变；完整进程启动 106936ms 达到 ready，API http-listening 为 70100ms。模块图 58182ms，read 48884ms、resolve 5387ms；不是清除系统缓存后的受控冷启基准。三角色、四会话十消息、默认猫及配置指纹逐条一致，十项 CSS 与新构建匹配，隔离预览网关 available、实际端口 54376。

新安装版分别实际调用 Codex、Claude Code、DSH，均回复 42，耗时 10105/18155/18135ms；DSH 回复同时在实际 Electron 历史中打开验证。原凭据未再复制到其他实例。强制刷新返回 Codex、Claude、DSH、Kimi、OpenCode、Pi 六项已发现；后三者不据此视为已完成真调用。实际 GUI 已观察一击进入后自动协作、A2A 和右侧从设计稿变为可操作成果，主题正常；已有角色进入普通成员列表，不重新推荐一键配置。

最后自检使用真实 PR base 修正 fork origin/main 的坐标，保留初次错误基线的失败日志。首次配置提醒与 registry 补 tips_exempt：它本身已是自动非阻塞提醒，不额外弹重复 Tips。实际加载器比较源码与已安装版的十个引导对象完全一致；目录校验 10/10、加载器 16/16 通过。元数据不改变运行流程，无需把已有实装冒称重新编译。能力提示覆盖在正确 base 下零错误，九条既有来源警告保留。旧 skill 中架构归属脚本在当前仓库不存在，记录 warning，不伪造其通过。

427e5aff0 的云端最终为 19 SUCCESS / 1 SKIPPED，包括原失败 distributable-5 中上述五条模式用例。实际 checkout 日志为 eb0cb0b，合流 parents 为 427 与 main 7fca。独立复核后相对 cce 的 fallback 净增长 1，是旧草稿读取的 `!cat || cat.carrier` 守卫；它保留空基线和 canonical 权威，不增加静默认证或数据来源。之后提交仅补本段实测记录和上段治理元数据，新的 CI 状态在 PR 对账回执中分别记录。
