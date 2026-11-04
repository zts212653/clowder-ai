# #1793：Git 插件市场的 pnpm 版本选择与失败诊断

授权：本线程 `0001793761821935-000023-2c6016ee`。目标分支 `next`；砚砚负责方案和实施，宪宪负责独立审查验证。交付为修复 PR、更新线程标题、评论请求 `mindfn` 审查；不包含合入、部署或发版。

## 原因与范围

`runtime-composition.ts` 的 Git 市场安装经 `GitMarketplaceSources.install`、`GitMarketplaceRepository.withDirectory` 进入 `prepareMarketplaceDirectory(directory, root)`。

原实现只读插件包的名称和 build 脚本，在仓库根执行环境中的 `pnpm install --frozen-lockfile`。没有显式绑定根 `packageManager`，也不核对执行版本。Issue 的受控证据为 pnpm 9.15.4 成功、12.11.2 在 `CI=true` 下报 `ERR_PNPM_IGNORED_BUILDS`；不外推为所有 pnpm 10+ 都会失败。

本次实际下载并执行官方 12.11.2 Windows 原生包：继承禁用版本管理的环境时，仅加旧、新 CLI 配置参数仍输出 12.11.2；用新环境变量启用下载后，本机 engine-store 锁失败只给警告并继续 12.11.2。因此不能把请求自动切换等同于已经选中版本。

## 方案

1. 在接收仓库 JSON 的边界校验插件包名称/build，以及仓库根的 `packageManager`。根有精确 `pnpm@x.y.z`（可带预发布版本）时，通过已有 npm 运行 `npm exec --yes --package=pnpm@<version> -- pnpm ...`。复用 `manager/npm-invocation.ts` 的规范入口，Windows 显式启动随 Node 的 `npm-cli.js`；通用 shim 解析可能误取 `npm-prefix.js`，不能用于这里。安装版构建脚本会校验 `npm.cmd`；不新增 Corepack 或全局 pnpm 要求。
2. 同一执行链先查实际版本，再执行 frozen install 和原过滤 build。实际版本不符则在安装前停止。无根声明时保留环境 pnpm 路径；明确的其他包管理器、范围/tag、错误类型和暂不支持的 hash 声明在执行前失败，不猜测版本。
3. 保留 `CI=true`、锁文件和目标版本本身的依赖构建审批语义。不添加 `strict-dep-builds=false`、允许全部构建或改锁文件。工具下载沿用 npm 的 registry/认证/cache 配置，不修改用户全局配置。
4. 命令失败携带阶段、声明/实际版本、退出码、有限输出。pnpm 的错误也可能写到 stdout，因此合并 stdout/stderr，复用现有 CLI 脱敏器后再截到 2048 字符。由错误 `cause` 穿过已有 `INSTALL_UNAVAILABLE` 包装，仅对此具名诊断追加 reqId 对应的结构化 warn。原 HTTP code 和 error 字段保持可用。

暂不支持带 Corepack hash 的声明：npm exec 不能强制该独立 hash，故明确拒绝，避免静默丢弃约束。官方市场当前为普通 `pnpm@9.15.4`；不把这点表述为所有声明形式都已覆盖。

## 验证

- RED/GREEN：调用生产准备函数、真实子进程和受控 npm/pnpm CLI fixture；覆盖根/子包声明冲突、继承禁用版本管理、错误实际版本、无声明、无效声明、安装/构建失败、限长脱敏及禁止静默放开构建。
- 真实工具：隔离目录用 npm exec 精确选择 9.15.4；合成 Git 仓库固定 pin 与 esbuild 0.28.1，走生产 Git 安装准备/归档准入路径，记录实际版本、锁文件、结果与限制，不碰安装版数据。
- 诊断：生产 HTTP install 路径返回相同业务错误并记录同一 reqId；任意其他错误仍不写原始 error/cause。
- 受影响 Git 市场、插件管理路由/诊断回归，以及 API build/type、Biome、diff 检查。
- 宪宪对最终 exact HEAD 独立审查；PR 创建后单独请求 `mindfn` 的维护侧审查。

当前实测：旧实现新增回归 6 项中 5 项失败、1 项通过；修复后 6 项通过。首轮受影响路由/目录/诊断共 43 项通过；改用规范 npm 入口后的准备/入口检查 10 项通过。完整最终定向结果与独立审查在 PR 中记录。

Windows 真实工具验收已完成：PATH 中为官方 pnpm 12.11.2、继承禁用自动切换的环境；生产 Git clone → 准备函数选择 9.15.4 → frozen install → esbuild 0.28.1 原生 transform/build → 本地归档准入 → inventory。实例为 `disabled/stopped`，锁文件 SHA-256 前后一致。插件和 inventory 是隔离的合成样本；这不等同于原 CodeAgent 私有克隆、内网镜像、安装版重装或 macOS 实机验收。

## 风险、回退与证据来源

行为面：Git 市场准备，增加 npm 工具缓存/首次下载需求。离线环境需要已缓存的精确 pnpm；失败明确诊断，不能悄悄使用另一版本。普通 npm registry/认证配置沿用；不引入固定外网地址。数据、权限和持久化 schema 无迁移。回退为 revert 本次修复提交。

Architecture cell: plugin-management / marketplace preparation。
Map delta: none。
Why: 修复既有安装入口的工具选择和失败回传，不改变仓库发现、安装授权或插件生命周期归属。
Canonical source: `packages/api/src/domains/plugin/manager/marketplace/git-marketplace-preparation.ts#prepareMarketplaceDirectory`。
Consumer evidence: `rg -n 'prepareMarketplaceDirectory|withDirectory|INSTALL_UNAVAILABLE' packages/api/src/domains/plugin`；实际调用为 runtime composition 的 Git 市场安装路径。
Claim guard: 版本选择/审批保持 → `plugin-marketplace-preparation.test.js` → 裸调全局 pnpm 或丢失冻结参数时失败。

外部原始材料：

- [Issue #1793 与维护者回复](https://github.com/zts212653/clowder-ai/issues/1793)：问题、对照范围、审批和诊断边界。
- [pnpm 11.0 官方发布说明](https://pnpm.io/blog/releases/11.0)：配置项及环境变量前缀的变化；实际 12.11.2 选择行为另以固定版本实测，不把当前文档当全部版本证据。
- [pnpm 官方 CLI 配置](https://pnpm.io/settings/cli)：`pmOnFail` 语义。
- 本工位 `artifacts/issue1793/`：原始选择实验、官方工具包和本地验证输出；工具与私有环境数据不提交到公共 PR。
