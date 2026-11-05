---
feature_ids: []
topics: [onboarding, cat-catalog, issue-1651]
doc_kind: plan
created: 2026-10-21
---

# #1651 空名单首启

来源：[#1651](https://github.com/zts212653/clowder-ai/issues/1651)；用户于 2026-10-21 明确将原 A+B 调整为「全新安装从零成员开始，检测后由用户选择并确认添加；已有安装保留成员」。不扩展默认品种。

## 用户体验与范围

- 全新安装只有所有者，无自动创建的猫猫。沿用 #1519 已有界面与检测、手动添加流程；不新增空态卡片，不调整按钮位置、名称或入口跳转。角色模板保留为可选菜单。
- 检测只展示工具、登录证据和候选角色；勾选并确认后才创建成员，不因检测产生模型调用。
- 已登录不等于调用成功；缺少安装、需要登录和连接待验证沿用现有就绪状态。
- 首次引导由明确的安装初始化标记与个人持久化回执控制，关闭/完成后不反复弹出。旧安装不凭空名单或成员数量认定首启。
- 重启、读配置、模板升级均不能给新安装补入未选择的品种或变体。已有成员、修改和删除选择保留；旧安装保持现有兼容迁移。

## 契约与实施

Architecture cell: 成员 catalog / 首次引导 / 成员设置。
Map delta: none；继续使用 catalog 单一写入源和用户偏好回执。
Why: 移除历史 seed 绕过空态的行为，恢复检测后由用户确认的创建边界。

Canonical source: `cat-catalog-store.ts#bootstrapCatCatalog`、`cat-config-loader.ts#mergeTemplateWithCatalog`、`config-onboarding.ts`。
Consumer evidence: `rg -n 'bootstrapCatCatalog|pickSeedBreed|persistMissingTemplate|removeUnavailableTemplateVariants|useDemoAdmission' packages/api/src packages/web/src`。
Claim guard: 首启、三次重启、选择单个变体、删空、旧 catalog、个人回执 → `empty-first-run-catalog.test.js` 与 onboarding 回归；任何自动加入未选成员、误认旧安装或丢回执都应失败。

新 catalog 写入版本化 `memberInitialization: user_selected_v1`；只控制自动添加与引导资格，不迁移旧 catalog，也不新增角色来源猜测。普通 CRUD 持有并保留根元数据。回退代码仍可读取原 catalog；回退旧行为会恢复旧版补齐策略，因此应保留本 PR 代码直到维护者确认。

## 验证

先观察新回归在原实现的失败，再修改初始化、升级补齐与只读合并三处消费路径。API 使用实际 bootstrap/loader/HTTP route，Web 使用真实 hook/组件与既有检测创建测试。

格式化使用 `node node_modules/@biomejs/biome/bin/biome check <本次文件>`；API `tsc`、Web `tsc --noEmit`，运行受影响回归。浏览器使用独立 worktree 和测试数据验证首页空态、检测候选、无工具、取消与确认、刷新；不使用生产端口，不调用真实模型。

## 首次实现验证（4c749e700）

- API：`empty-first-run-catalog`、catalog store/loader 和 onboarding 偏好/回执/读取失败回归，共 172 项通过；API TypeScript 编译通过。
- Web：首次引导、检测创建、成员故障与默认成员并发、新对话和文案回归，共 31 个文件、199 项通过；`tsc --noEmit` 通过。此提交包含下方已撤回的界面调整，其截图及相关界面测试不作为最终 UI 验收证据。
- Biome 检查本次 20 个源码/测试文件，无错误；保留既有大文件复杂度等警告。`git diff --check` 通过。
- 在本 worktree 启动实际 API 和 Next 应用，独立端口 3198/5198，使用隔离 HOME 和内存存储，不连接 Redis。实际走过：首次空名单 → 关闭引导并刷新 → 检测候选 → 取消仍为空 → 再次检测并确认一位 → 刷新仍仅一位。检测确认前磁盘 catalog 仍为零成员，整个旅程无模型请求。

原生工具登录状态使用隔离的 `claude.cmd` 测试替身，因此以上只证明实际应用中的检测、确认与持久化旅程，不代表真实账号、模型调用、安装器首装或生产环境验收。已有安装的兼容保留通过 catalog/loader 回归覆盖；本次不部署生产环境。

独立审查结论随最终 PR 记录。验证日志、实例台账及测试数据保留于任务 artifacts；提交不包含 HOME、凭据、运行日志或测试临时目录。

## 2026-10-21 用户纠偏：恢复既有 UI

用户指出新增空态卡片、入口布局和命名未经同步，要求改回。此次明确撤回这部分 UI 设计，而非重新定义为原方案内容。

- 成员页 classic/v2、首页、引导演示和推荐团队页的界面源码恢复到 PR 前版本 `36e325a10`，包括原有按钮、位置、文案和链接。保留 catalog 空名单初始化与个人引导回执的功能修复。
- 恢复既有引导和首页测试，先观察原入口约定的 4 项失败，再恢复实现。移除已撤回动态空态专用的 hydration 测试，其触发机制随 UI 一起移除；检测、选择和确认添加继续由原有回归保护。
- 纠偏后 Web 8 个文件、62 项通过，API 空名单和兼容性回归 5 项通过；Web `tsc --noEmit`、本次源码 Biome、diff 检查通过。独立审查需覆盖此修正后的提交，旧提交批准不代表本次已获批准。
- 纠偏后实际 Next 页面浏览器验证 2/2 通过：classic/v2 均恢复旧版布局，取消检测无成员写入，重新进入既有检测流程并只确认一位时仅提交一位。此轮使用合成 HTTP 边界，不连接真实账号、模型或生产服务；截图留在任务 artifacts，不替代真实后端验收。

## 独立审查反馈跟进

- 名单首次读取失败时，`useCatData` 不设置 `hasFetched`，检测入口的 `MemberCreationPage` 保持等待/重试；刷新失败会保留原名单。手动创建始终可达是 #1519 的既有约定，本轮不隐藏该入口。补回归验证读取失败不会进入团队推荐，显式手动操作仍可进入单成员编辑。
- 审查基于首版提出的演示 CTA 和 classic/v2 空态文案调整，随用户要求的 UI 回退撤销，不重新引入布局或动态 CTA。此修复只改变全新安装；已有安装保留成员，不推断角色来源。
- 采纳 marker 契约建议：在共享类型和 v1/v2 schema 中保留 `memberInitialization`；未知 `user_selected_*` 标记仍禁止模板自动补齐。标准 loader 的结果不再丢该标记。账户绑定使用的 `parseRawCatConfig` 本来就返回已验证的原始 JSON，回归证明该路径在修复前已保留 marker，不将它描述为已复现的数据丢失。
- 采纳 catalog 异常与个人回执分离：catalog 读失败/损坏时关闭自动引导并记录日志，个人回执仍可读写；不改写或修复损坏的 catalog。真实偏好读取/写入异常仍保持 503，不默认覆盖已有偏好。
- RED 实际复现未知标记补入 GLM 与 catalog 损坏返回错误 503；修复后隔离 HOME 下 API 6 个文件、175 项通过。Web 名单加载与成员创建入口定向 11 项通过；shared/API TypeScript 编译、Biome、diff 检查通过。UI 源码与 `097cd21f6` 一致。
- 此时 PR base 为 `44fb36e65`，GitHub 报告 `MERGEABLE`；仅落后一个无关文档提交不要求重写已推送分支。独立审查仍需覆盖最终提交，未自行 merge。
