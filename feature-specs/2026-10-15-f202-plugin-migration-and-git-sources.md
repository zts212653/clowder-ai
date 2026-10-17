# F202：迁移忠实性与 Git 插件仓

来源：operator1650进一步明确“同结构Git仓→元数据→packages目录→既有目录安装”；owner thread `thread_mu8dg6h7l2x4ohsk`，operator 1491、1504、1521、1523、1607；原 Task1843 / accepted094。本计划补充原 5628 收口计划，不替代未完成的扫码、材料与真实账号验收。

## 用户结果

迁移后保留旧 connector.yaml / plugin.yaml 的配置、条件、指引与操作语义；用户无需逐插件排查迁移错误。配置独立于启用意图。删除迁移额外加入的旧配置导入、手动读权限/应用权限、个人号群管理等步骤，不迁移或删除用户旧数据。

插件管理保留“从本地目录安装”；齿轮管理 Git 插件仓。官方 GitHub main/catalog/catalog.json 继续作为 npm 发布目录（operator1772）。用户可添加多个本机 Git 能访问的仓地址及分支，留空取默认分支；环境变量可预置。打开插件页刷新目录，新增插件/版本在现有列表出现；刷新不修改已安装制品、配置或启用意图。

## 当前事实与责任

- H：`clowder-ai-f202-c1-core`，Astra 持有 Host 迁移、设置生命周期与 Manager。普通配置/目录记忆已批准提交 `a6fcbef087`，不是整个范围完成。
- W：`clowder-ai-plugins-train-c1`，Sol 持有包/SDK/Contract 原责任。七 IM 原声明/default 修复冻结 `da86224`；继续核所有包的旧声明及实际消费者，修同根差额。不得并发修改其工作区。
- 既有机器目录 `catalog/catalog.json` 的发布契约只支持 npm 制品，来源 provenance 不是安装坐标。Git 仓的元数据定位原有 packages/<插件> 目录，直接复用本地目录安装。官方已有 npm 制品路径继续保留；不新增 GitArtifact/tgz 发行协议，不要求内部发行者打包或发布 npm。目录刷新不运行构建脚本；安装时必要的依赖/构建准备沿所选仓现有声明完成。
- 既有安装器、摘要校验、归档检查、inventory、启用/禁用继续复用。新增目录来源不自动扩大插件 grant；来源记录不是授权记录。

## 工作单元与证明

1. **原行为还原（原责任继续）**：逐包对照旧字段/requiredWhen/mode/steps、operation 和 runtime 消费。包侧补回旧声明，删新增迁移入口；Host 恢复 loaded setup 与 active runtime 分离，扫码 challenge 在连续调用间保留，三个原群端独立控件读取唯一存储。直接消息插件无群控件。验证配置前扫码、轮询、停用保存、默认首消息、既有群命令、原指引数量与条件；测试不能只看 manifest。
2. **Git 来源存储与同步**：官方 npm 目录保持原入口；额外 Git 来源按 URL＋分支合并 env 预置和用户保存项。用户来源持久写入 Host 数据目录，缓存可重建，不以临时目录保存用户配置。首次 clone，之后仅打开插件管理页或手动重试时 pull（operator1687）；保留本机 Git 的 SSH/凭据配置。串行同仓更新；读 exact commit 的目录元数据，在安装期间锁住所选仓目录，页面轮询不每五秒 pull。单源失败保留最后可用目录并显式显示失败，不影响其它来源及已安装管理。移除来源只影响发现，不卸载插件，不删除用户数据。
3. **目录与安装接线**：读取已跟踪的 packages/*/plugin.yaml 与 package.json 定位对应目录，不改变发布 Contract。由 Host 将已配置来源、所选 commit 和 package path 解析到自己的克隆目录，交原 LocalPluginPackageAdmission。所选目录不得越出克隆根；安装时重新核来源/commit/version。多源同 pluginId 合并为一行，默认 npm 来源；详情保留带分支/版本的显式来源选择。选来源不安装；显式安装才可替换，不更改已安装来源的展示事实。来源更新不触发安装。
4. **入口呈现**：复用当前 toolbar、Settings modal/token。仅目录按钮和齿轮；来源弹窗提供地址＋分支添加/移除、官方/env标识与同步状态，不显示 JSON/commit/摘要。列表已安装全部展示、未安装首批5条，滚动或“查看更多”追加；搜索覆盖完整目录。保留开发文档入口，支持独立项目包根目录安装。首次打开页面自动刷新；关闭重开能发现仓库更新。移除旧 Git/离线 UI 入口，不误删 npm/仓内制品仍需要的归档安装底层。
5. **组合验证**：用隔离本地 Git 远端真实 clone→提交新版本→重新打开/刷新→新版本可见→按所选 packages 目录安装；断线保留目录、并发打开、重启恢复来源、移除不影响安装。官方 npm 路径回归。浏览器核完整列表/齿轮/添加/失败和窄屏。最终同一 H/W 组合独立复核，未验收的真实供应商账号明确保留，不转嫁逐功能测试给 operator。

## 实施约定

环境变量采用 `PLUGIN_GIT_MARKETPLACE`（一个地址或 JSON 数组，成员可以是地址或 `{url, branch}`）；官方目录保持原 `main/catalog/catalog.json` npm 路径，不重复创建默认 Git 源。env 预置项在页面标明来自部署配置，用户项由页面管理。不改运行实例 .env。

待源码收敛的技术项：干净clone的既有依赖/构建准备与目录安装组合；未知插件沿现有 grant 机制的实际呈现；原设置独立加载签名。由原责任猫查代码解决，不向 operator 提交技术 A/B 决策。

验证命令以 H package.json 为准：`pnpm --filter @cat-cafe/api build`；API 定向 `node --import tsx --test <test files>`；web 定向 `pnpm --filter @cat-cafe/web exec vitest run <test files>`；格式检查 `pnpm exec biome check <changed files>`；`git diff --check`。不为未变包重复全仓门禁。

Architecture cell：现有 Plugin Manager/catalog/Host inventory。Map delta：增加 Git 目录来源，安装器与运行生命周期归属不变。Why：将用户添加内网仓的单一操作接入既有目录与安装路径，同时修复原迁移中增删的行为。

operator1798补充：显式选择本地目录可按相同pluginId替换原npm/目录/Git安装版，保留实例、配置、数据和启用意图；在现有lifecycle queue内停旧runtime、更新制品/grant、重算配置readiness、按意图恢复。目录刷新不触发替换，不要求用户先卸载。验证跨来源替换及失败/并发事实。
