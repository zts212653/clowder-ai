# #1727 插件生命周期与技能冲突验证

问题与接受范围：<https://github.com/zts212653/clowder-ai/issues/1727>。代码基点 `a8a8ae9e46`，特性分支 `fix/plugin-lifecycle-1727`。运行实例未改动、未重启；验证使用本分支代码与临时文件存储，不连接 Redis。

## 行为

- `/restart` 使用原生命周期队列、兼容性检查和 revision fence，支持运行中重启与失败重试；`/repair` 保留兼容，但界面不再称“修复”。
- 卸载和重启放在详情顶部操作区，长详情滚动时固定可见。
- 普通技能注册/挂载冲突不回滚整个插件。冲突读现有 capabilities 配置和真实挂载路径，展示技能、来源、位置。
- 选择插件技能来源须先确认；真实本地占位内容通过 rename 永久保留到同目录唯一备份，不自动删除。登记来源切换保留原技能文件。变动过的冲突凭据拒绝执行。
- 仅迁移指向已移除内置技能的受管断链；活来源、其他内容和其他插件归属不自动覆盖。卸载亦覆盖未完成登记的历史断链。
- 来源选择与卸载/重启通过同一实例队列串行；只读/Alpha 发布隔离继续有效。

## 边界与消费方

Architecture cell: plugin；Map delta: 冲突投影和来源选择复用 skill registry/classifier/mount API，新增两个 Manager REST consumer；无第二份持久资源状态。
Canonical source: `skills/skill-manage.ts`、`skills/skill-mount-ops.ts`、`external-plugin-lifecycle.ts`。
Consumer census: `rg -n 'onRepair|onRestart|actions\??\.repair|actions\??\.restart' packages/web/src/components/settings/plugin-manager packages/api/src/domains/plugin packages/api/src/routes/plugin-manager*`。
Convention graph 命令在此公开仓报告 `No projects matched the filters`，未把它记作成功索引；以实际代码引用检查和契约测试覆盖消费方。

## 验证证据

1. RED：新增 4 项技能冲突回归在修改前均失败，失败分别指向全部挂载冲突、断链遗留、幂等激活误判和同名登记异常。
2. API/生命周期/持久化/技能路由定向套件：142/142 通过。
   `pnpm --dir packages/api exec node scripts/with-test-home.mjs node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 test/plugin-manager-routes.test.js test/plugin-manager-service.test.js test/plugin-manager-projection.test.js test/plugin-external-lifecycle.test.js test/plugin-manager-restart.test.js test/plugin-alpha-capability-publication.test.js test/f202-c1-installed-skill-persistence.test.js test/skills-route.test.js`
3. 新资源边界及真实 Host 流程：18/18 通过。
   `pnpm --dir packages/api exec node scripts/with-test-home.mjs node --import tsx --import ./test/helpers/setup-cat-registry.js --test test/plugin-skill-conflicts.test.ts test/plugin-skill-lifecycle.journey.test.ts`
4. 前端插件管理范围：20 文件、167/167 通过。
   `pnpm --dir packages/web exec node scripts/run-with-node-env-test.mjs pnpm exec vitest run src/components/settings/__tests__/PluginManager src/components/settings/__tests__/PluginSkillConflicts.test.tsx src/components/settings/plugin-manager/__tests__`
5. API/Web TypeScript 及 changed-file Biome 检查通过。没有用测试数字替代实物核对。
6. 独立审查发现并修正三条失败路径：能力列表读取重建被替代的内置登记、来源切换 I/O 失败只回滚登记、受阻父路径令诊断连带锁住卸载。新增 RED→GREEN 回归覆盖已有/原先缺失挂载的完整回滚、历史重复登记、ENOTDIR 与无权限挂载下的真实 Manager 卸载。普通受阻挂载不会阻断卸载；操作系统拒绝访问的路径无法清理，保留其内容。
7. 能力发现相关 4/4 通过（显式来源选择、旧插件元数据、外部同名技能、插件登记保留）。扩大到 `capabilities-route.test.js` 全套为 80/90；在同一 worktree 临时移除本次自动发现改动并复跑，原有 10 项失败全部相同，另新增来源选择用例如预期失败（79/90）；恢复后验证文件与原字节一致。本次没有宣称此全套通过，也未改动这些无关测试。
8. 扩大检查时发现 4 项原先已失败的前端断言；在同一工位临时还原 main 生产代码复跑确认后，校准相关旧断言与请求 mock，不改无关产品实现。

## 完整旅程（Dogfood）

走通：真实 Host Manager 安装 → 带普通技能冲突启用 → 显示具体冲突 → 确认保留旧内容并选择插件技能 → 重启 → 卸载 → 重新安装和启用。测试使用技能 contribution 插件，生命周期、安装、配置存储与 REST 都是真实实现；未宣称验证外部插件业务服务。

浏览器在本 worktree 的隔离 5417 服务使用生产 `PluginManagerLiveContent` 与真实 Manager 路由：处理后 `live=running/conflicts=0`；重启 revision 由 4 进到 7；确认卸载后 `_local` 列表为空；重装后 `live=running/conflicts=0`，备份 user.md 原文仍在。

桌面 1280×800 与手机 390×844 下滚到长详情末尾，卸载/重启仍在视口，页面无横向溢出。截图检查发现并修正固定栏透明导致内容透出的缺陷；复验使用卡片背景 token。技能来源确认复用产品 ConfirmDialog，不依赖 iframe 内可能受限的原生 confirm。

Hub Preview 请求曾返回 `unconfirmed/no_matching_client`，因此没有宣称面板已打开或用户已验收。作者浏览器取证与 operator 体验确认是不同状态。

未执行 merge、生产数据清理或运行实例重启。按 fork 既有流程，独立 review 后交由 operator 体验，再推进 fork 合入与 soak。
