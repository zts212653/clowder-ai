---
feature_ids: []
topics: [intranet, desktop, release, updater, gitlab]
doc_kind: plan
created: 2026-10-26
---

# 内网 Release 检测、下载与升级方案（待实施）

来源：本线程要求先合并最新 main，再研究内网独立 Release 更新；内网平台访问参考 repo-sync。
状态：方案，不启用更新、不改运行配置、不发布或安装新包。当前已验收 EXE 仍绑定 c7a67cc55。
研究基线：main eb05c1cffd5b81095dc381c649bd177b070c63af；内网合并前 c7a67cc55。
参考仓：feat-repo-sync-plugin@674c89fc63fa48897a121becb1b1e0c5eb6764c4，只读，不改该仓未跟踪文档。
Architecture cell：runtime-deployment；Map delta：当前研究 none，实施时新增桌面更新源 adapter。
更新生命周期仍由 Electron 主进程拥有；API、插件和 renderer 都不能决定可执行的安装目标。

## 1. 目标与使用体验

利用已有内网 Release：管理员预置仓库首页/API 地址与项目；用户首次提供必要认证并选择记住，
以后启动自动检查，沿现有“检查更新 → 下载进度 → 确认升级 → 下次启动验证”入口操作。
既有配置优先，升级不覆盖配置、角色、认证、Redis、SQLite、历史、会话绑定或数据根。
只更新内网发行版，不切换公共发行通道；断网、认证失效、发布不完整分别诊断，不能显示“已最新”。
本次仅研究 Windows 安装版；不把公共版 macOS 全平台齐备规则强加给 Windows 内网发行。

旧 c7 版主动关闭了更新入口，不能靠服务端发布 Release 让旧程序自动开启。
需要先手动安装一次具有内网 updater 的新包，此后配置长期生效、后续更新走现有应用入口。

## 2. 已核实的当前实现与缺口

| 位置 | 已有机制 | 必须调整的地方 |
| --- | --- | --- |
| desktop/desktop-update-runtime.js | Electron net/session、UI、服务启停接线；固定 intranet 通道 | 注入已校验的 update provider、配置和凭据服务 |
| desktop/update-manager.js | 串行检查、24h 调度、下载进度、跳过版本、安装失败恢复 | intranet 直接禁用；Release 页面及检查来源写死 GitHub |
| desktop/update-installer.js | GitHub JSON feed、ETag、Electron 流式下载、Range/If-Range、UAC 安装 | API/下载源固定 GitHub；下载无内网 Token；元数据/二进制需分离 |
| desktop/update-checker.js | semver、按资产名选择、API digest/size、完整发布检查 | 资产名固定公共版，要求 Windows + 两个 macOS 包；不能直接识别内网 Release |
| desktop/update-prompt-controller.js | IPC sender/window 校验、受信 Release 链接 | 域名和路径固定 github.com；改为当前 provider 的精确 URL 策略 |
| desktop/update-install-flow.js | 安装前复验、journal、失败重试重新读取远端元数据 | retry 另行硬编码 GitHub；必须与初次检查消费同一 source/version 身份 |
| desktop/update-downloader.js | SHA256/大小校验、空间检查、pending journal、启动判定 | 当前只按 app.getVersion 判断成功；需绑定发行版、来源、版本与真实构建 |
| desktop/scripts/build-desktop.ps1 | 冻结依赖、完整包 manifest、Inno/portable 版本参数 | CATCAFE_VERSION 没有同样传入 Electron builder；必须统一所有版本来源 |
| desktop/package.json / installer | appId ai.clowderai.intranet，包内仍是 1.14.0 | Release tag、Electron、Inno、manifest、UI 必须统一，不能只改 Release 名称 |

已验收 EXE 名含 1.14.0，曾另以 v1.14.4-intranet 分发；这个历史标签不能当作包内版本。
实施时必须以实际包内版本作本机基线，首个新包使用统一的新版本号，不回写旧包或旧 Release。

## 3. 可以复用 repo-sync 的什么

- src/platform-detect.mjs：显式 API/仓库地址推导；GitLab v4 与 GitHub REST 区分；项目路径编码。
- src/gitlab-api.mjs：apiUrl + /projects/{encodeURIComponent(projectId)}，PRIVATE-TOKEN，超时、HTTP 错误、Retry-After、分页完整性。
- src/system-ca.mjs：合并默认与系统 CA 的 Node TLS 方案；不关闭证书验证。
- src/issue-auth.mjs：凭据绑定 API/project/auth 作用域、切源使旧凭据失效；Token 不进入业务 JSON/历史。

不能直接依赖插件启动或共享它的内存 Map：session 模式服务重启会要求重输，不能满足长期配置。
不能原样拿 gitlab-api.mjs 下载 EXE：它限 2 MiB、解析 JSON、redirect:error；本次 EXE 约 650 MiB。
保留桌面 Electron net 的系统代理路径；Node TLS 的 CA 设置不会自动配置 Chromium net。
企业 CA/代理须在最终所用 Electron 运行时验证，不能用 Node 请求成功替代桌面下载成功。

README 明确平台是 CodeHub/GitLab v4 兼容接口，并已有 Issue 封套等差异。
这证明接入模型可参考，尚不证明该平台 Release、附件、Range、私有下载均兼容。

## 4. 内网 Release adapter 契约

新增 provider 接口用于 list/select/revalidate/resolveReleasePage/resolveAsset；公共 GitHub adapter 保持原契约。
内网优先 GitLab v4 兼容实现：GET /projects/:id/releases，按页读取并验证格式。
读取 assets.links，必要时读取 /releases/:tag/assets/links；按 releaseVersion/平台/架构选择。
不能把 permalink/latest 当成最高版本：GitLab 的 latest 按 released_at，需本地版本排序并过滤未来/测试通道。
版本不能从文件名随意猜测，Release tag 与 manifest 的版本/通道必须一致。

GitLab links 通常只有 id/name/url，缺少现有 GitHub 资产授权依赖的可信 size/digest。
每个可更新 Release 增加 update-manifest.json：由发布流水线计算，不由客户端下载 EXE 后自行生成“期望 hash”。
manifest 包含 schemaVersion、edition、releaseVersion、tag、sourceSha、publishedAt、平台/架构、
资产稳定 ID/文件名/字节数/SHA256；限定文件名为 basename，拒绝绝对路径、路径穿越、重复资产和未知必填语义。
manifest 通过已认证、校验证书的发布源获取；不读取用户可写缓存作为安装授权。
其信任等级是发布仓与 HTTPS/认证，不能把同源 hash 宣称为独立发布者签名。
已有企业代码签名/manifest 签名可接入；新增签名基础设施作为单独决策，不假设现成可用。
Windows 内网完整发布仅要求声明支持的平台资产＋manifest，避免没有 macOS 包就永远不提示。

## 5. 一次配置与认证

建议安装包预置只含非敏感字段的 intranet-update-defaults.json；新增文件须列入打包清单。
安装数据根保存 update-source.json：schema、provider、apiUrl、projectId、webUrl、channel、credentialRef。
优先级：已有用户持久配置 > 安装包默认。API 不写它，普通启动不改 .env 或覆盖已有值。
update-settings.json 继续保存自动检查/跳过选择；ETag/跳过版本/下载缓存按 provider+project+channel 作用域隔离。
不要把这些新键直接写进 intranet-host.json：当前该文件只允许四个 Host policy/audit 键。

公开可读仓库不要求 Token；私有仓库只用读取 Release/附件所需权限，不能复用 CI 的发布写令牌。
有受支持的现有同站点只读凭据引用时经明确绑定复用；不能扫描其他插件/原生认证来猜 Token。
用户输入可用当前 Windows 用户的 OS 加密持久化（Electron safeStorage，按锁定 Electron API 选择）。
Token 不写入 manifest、URL 查询参数、日志、命令行或发行包；首次输入经专用、受校验的 IPC 提交给主进程。
不向 renderer 回显或广播 Token，也不在 renderer 持久化；安全存储不可用时明确诊断。
主进程保存配置和加密凭据须原子写、幂等、失败保留旧文件；变更源后重新检查，不继续安装旧目标。
最小用户入口复用现有更新设置，首次仅缺配置/认证时补充；不另建一套成员/插件管理入口。

## 6. 下载、安装与恢复的完整状态

idle → checking → available → downloading → verified → awaiting-confirmation → installing → next-start verification。
网络/认证错误回到可重试状态；用户取消保留原应用；失败下载可续传，但 asset 身份变化不能混用旧片段。
Release 与下载是两个网络边界：元数据不接受登录页/HTML，附件按受控重定向最多 5 跳。
凭据只发给当前绑定的 API origin；跨 origin 不能携带 PRIVATE-TOKEN，不允许 HTTPS 降级。
附件主机需来自配置允许范围；外部对象存储须有无须转发 Token 的下载授权，否则明确报兼容缺口。
Range/If-Range/206/Content-Range/ETag 复用现有下载算法并增加 source+asset 身份，重下只清理本次片段。

下载后按可信 manifest 做大小和 SHA256 复验；确认安装前重新获取同源 Release/manifest 并核身份。
304 不能让同用户可写缓存成为执行授权，保留现有无条件重新获取要求。
journal 记录 sourceFingerprint、edition、releaseVersion、sourceSha、资产 ID/大小/hash、安装包/日志位置。
恢复时重新验证原目标身份；不可取得权威元数据则保留已下载文件并解释，不能改从公共 GitHub 重试。
已有旧格式 journal 保留识别路径，不静默删除历史或把旧文件当内网安装授权。
启动后成功判定同时核版本/edition/source，不能只因版本号大于目标就宣称安装了同一包。
清理限本次拥有的下载工件；日志、回退包及用户状态仍遵守既有保留边界。

升级继续使用 Inno 的实例身份与数据边界。先确认正在进行的会话并正常停止该实例，禁止按通用进程名批杀。
当前内网安装器不自动启动；第一阶段升级完成后用户手动从桌面打开，提示文字必须与此一致。
若后续要真正“重启并升级”，必须另证普通用户令牌下的重启交接，不能恢复从提权安装上下文直接启动。

## 7. 工作单元与验证

| 工作单元 | 主要位置 | 可观察验证 |
| --- | --- | --- |
| Release 兼容探针 | 新建只读诊断脚本 | 真实内网列表/附件 JSON 脱敏样本，私有下载、CA/代理、分页、Range 结果；不发版 |
| 配置与凭据 | defaults、source store、safeStorage 接线 | 初装默认、一次输入、重启复用、切源失效、写失败保留、无明文 |
| provider/元数据 | GitHub/GitLab adapter、checker | 版本乱序/未来发布/通道/Windows-only/坏 manifest/资产替换；公共选择保持 |
| 下载与 UI | installer transport、prompt-controller、runtime | 正常/跨站重定向、Token 不外泄、401/403/429、断网续传、取消；可信 IPC/URL 不放宽 |
| 安装与 journal | install-flow、downloader、现有安装器 | UAC 取消、安装失败重试、断电恢复、升级后真实版本/身份/历史/会话绑定回读 |
| 发布一致性 | build-desktop.ps1、windows-builder、发布脚本 | Electron/Inno/Release/manifest 同版本，同一 EXE hash；Windows-only 完整发布 |

先在单元/合成 HTTP 场景确认 RED→GREEN，再跑实际锁定 Electron 与内网样本，最后两版真实 EXE 升级。
既有回归命令已确认：node --test desktop/update-checker.test.js desktop/update-checker-selection.test.js
 desktop/update-downloader.test.js desktop/update-installer-fetch.test.js desktop/update-installer.test.js
 desktop/update-manager.test.js desktop/update-prompt-controller.test.js desktop/desktop-update-menu.test.js。
实现新增的 adapter/config/恢复用例加入该集合；本方案不声称这些未来能力已经通过。
发布前保留完整 EXE 构建与实际升级验收，不能拿 API/Node 假服务证明已在企业网络下载成功。

## 8. 待真实平台核实，不阻止先完成 main 同步

Release 与附件端点及响应封套、只读认证 scope、附件是否需要二次鉴权、重定向目标、Range/ETag 支持。
部署维护者的一次性仓库/API/project 信息可复用 repo-sync 的非敏感配置，具体 Token 不进入本文或 PR。
先提供只读连接诊断回执；若平台不兼容某个 GitLab 端点，再基于实际样本适配，不要求另建静态发布服务。
本计划尚未获得更新功能实施授权；本轮只交研究和 main 合流验证。

参考：[GitLab Releases](https://docs.gitlab.com/api/releases/)、[Release links](https://docs.gitlab.com/api/releases/links/)、
[Release 附件与重定向](https://docs.gitlab.com/user/project/releases/release_fields/)、
[Electron net](https://www.electronjs.org/docs/latest/api/net)、[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。