---
doc_kind: plan
created: 2026-11-06
topics: [acp, process-pool, defaults]
---

# Issue #1882：ACP 默认进程容量按客户端分流

来源：本线程用户消息 `0001793958152841-000092-1a6c618b`，Issue <https://github.com/zts212653/clowder-ai/issues/1882>。
目标分支：`zts212653/clowder-ai:next`；起点 `43c1c3cb7e4e2ba0285c993d5cc5bd016824a663`。
责任：砚砚实现，鲸鲸分别审方案与最终代码。此方案提交后先请求鲸鲸审查，再实施。

## 约定结果与范围

未显式配置容量时，通用 ACP（含 DSH、Pi、CodeAgent）默认最多 20 个存活进程；Gemini ACP 保留 3。显式配置始终优先，例如已有 DSH 配置 10 继续为 10，Gemini 显式设 8 仍为 8。

Gemini 例外使用现有客户端身份 `clientId === 'google'` 判定，不按昵称、模型名或命令字符串猜测。通过通用 `clientId: 'acp'` 接入的自定义程序采用通用默认 20；需要较低容量可显式设置。这是现有客户端契约下的技术选择，须由鲸鲸审查。

本次不启用 multiplex，不修改 idle TTL，不改用户已保存的配置，不抢占活动进程，也不改失败回传/容量等待。Issue #1882 的等待与接续缺口继续保留，PR 使用 `Refs #1882`，不宣称整个 issue 已修复。

Architecture cell：现有 ACP 工厂与成员编辑器的默认值投影。
Map delta：none；不新增生命周期对象、权限边界或外部依赖。
Why：当前各线程共享的通用 ACP 池继承了 Gemini 时代的默认 3，导致第 4 个活动调用过早失败。

## 实现位置与契约

1. 在 `packages/shared/src/acp-pool-defaults.ts` 放置一个可供 API/Web 共用的纯函数，输入已类型化的 ClientId，返回 google=3、其他=20，并从 shared 根入口导出。
2. `AcpServiceFactory.ensureAcpPool()` 只解析一次有效容量：显式值 ?? 客户端默认值。将同一值用于 spawn signature 与新池构造，避免缓存身份和执行容量不一致。
3. 原 Hub 编辑器的 `ACP Max Processes` 占位符与设置页“最大进程数”共用同一默认值函数。设置页容量字段改为在 `MemberAdvancedFields` 内直接渲染 `TextField`，不扩展 `MemberField` 三元组。输入值仍留空代表默认，不把 20 写入保存的配置；不改布局和入口。该显示约定仅作用于原本可编辑的字段：plugin-managed ACP 保留隐藏，官方 AGY ACP 在设置页也保留隐藏，不借本次改动扩大配置权限。
4. 生命周期复用现有逻辑：上限仅按需使用，不预启动 20 个进程。配置/签名变化按现有 retirement fence 等旧代活动任务 drain 后切换；不增加新的等待或回收层。

## 代价与回退

满负荷时通用 ACP 允许比原来更多进程、原生工具与 MCP 连接，可能增加内存及模型并发消耗；空闲或没有任务时不会仅因默认 20 而启动进程。20 是用户选择的默认政策，不是已完成的机器容量压测结论。Gemini 保留原值，减少既有特殊路径的行为变化。

回退可撤销本 PR，或通过已有成员配置显式设置较低容量。运行数据与保存的显式配置不迁移。

现有显式 10 要变为 20：普通 ACP 成员在既有“最大进程数”输入框中改填 20，或清空以跟随通用默认。本线程当前 DSH 未绑定 agentProvider，属于此路径。本轮不替用户执行此配置迁移。

plugin-managed ACP 的成员页容量字段继续隐藏；进一步核对 `plugin-agent-provider.ts` 后发现插件声明的严格 schema 当前也不开放 `pool`，因此不能建议向插件 client 配置直接添加该字段。此类 client 在当前声明能力下采用 Host 通用默认 20；插件个性化池覆盖不在本次新增范围。此处纠正方案审查中“只能改插件配置”的推测，以实际 parser 契约为准。

## 实施与验证

1. **方案审查**：鲸鲸已在消息 `0001793958405541-000112-dc7a327e` approve；本版补齐其要求的 Issue 设计说明与字段可见性边界，不另开方案轮次。
2. **RED**：在现有 factory 测试中使用 fake client，通过实际 acquire 验证通用 ACP 第 4～20 次成功、第 21 次拒绝；Gemini 第 4 次拒绝；显式容量（含 10）优先。该测试调用生产工厂与池，不复制解析实现。
3. **GREEN**：实现共用默认值与两个编辑器投影；覆盖留空不写入默认值、保留显式值及客户端切换后的占位符。
4. **检查**：从仓库 package scripts 使用 `pnpm --filter @cat-cafe/shared build`、`pnpm --filter @cat-cafe/api build`；API 测试通过 `packages/api/scripts/with-test-home.mjs` 隔离 HOME/日志，定向运行 factory、pool、signature、registry 测试。Windows 容量 fixture 的 Temp 祖先不满足严格 ACL，测试命令显式使用既有 `--env CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host`；此处只验证容量，不宣称启动隐私边界验收，不修改运行配置。Web 使用 `pnpm --filter @cat-cafe/web exec vitest run <本次测试>`，并对修改文件执行 `pnpm exec biome check <files>`。按结果运行相关类型检查，不用运行态 3003/3004 验证未合入改动。
5. **真实呈现**：在此 feature 工位验证编辑器显示的 20/3 与显式值；只使用隔离 fixture，不请求真实模型、不写用户配置。DOM/浏览器验证须记录入口、操作与结果；无法验证的范围明确保留。
6. **代码审查与 PR**：完成检查后提交 exact HEAD，鲸鲸独立审最终代码。处理有效 findings、必要时复审；创建 base=`next` 的 PR，登记 issue/方案/验证/审查证据，不合并、不部署、不关闭 issue。
7. **Issue 设计说明验收**：Issue #1882 中明确记录通用 20 / google 3 / 显式优先矩阵；Gemini 保留既有特殊路径默认值而非宣称压测最优；不启用 multiplex、不改 idle TTL；等待与接续仍待实现并保持 issue open；显式 10 的变更路径与 plugin-managed 字段隐藏边界。20 是默认政策，按每成员的进程/内存/MCP 连接数量观察实际成本。

工位：`G:/AIwork/clowder-ai/cat-cafe-issue1882-acp-pool-defaults`。
开发数据：Redis 6398；本任务仅 mock/fixture 测试，不启动业务实例或连接生产 Redis。

## 已完成验证

- 基线容量矩阵 6 项中，通用 ACP / Pi / OpenCode 在第 4 次 acquire 失败（3 RED）；Gemini 默认 3、显式 10 / 8 原本已通过。实现后矩阵 6/6 通过。所有用例故意使用含 gemini 的模型名，证明判断依赖 clientId。
- API 定向回归 60/60 通过：`acp-service-factory.test.js`、`acp-process-pool.test.js`、`acp-pool-signature.test.js`、`acp-pool-registry.test.js`、`acp-account-source.test.js`。从 `packages/api` 经 `node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host --env LOG_LEVEL=error node --test --test-concurrency=1 <上述 test/acp/ 文件>` 执行。
- Web 定向回归 91/91 通过：`member-acp-pool-defaults.test.tsx`、`member-runtime-contract.test.ts`、`hub-cat-editor.test.tsx`，使用 Vitest `--maxWorkers=1`。编辑器类型当前不接受 pi，Web 矩阵使用 acp / opencode / google；Pi 的容量由生产工厂用例覆盖，不为本次默认值扩大编辑器类型。
- `pnpm --filter @cat-cafe/api... build`、shared/API TypeScript 编译、Web `tsc --noEmit --incremental false` 均退出 0。7 个修改的代码/测试文件 Biome 检查退出 0，保留既有 5 个警告和 2 个提示；`git diff --check` 通过。
- 浏览器在此工位 `http://127.0.0.1:5193` 加载两个生产组件与真实 payload builder 的隔离 fixture：通用 ACP / OpenCode 显示 20，切换 google 显示 3，填写 10 在两处同步且保存为 10，清空后 payload 不含容量；无页面 JS 错误。证据在 `%TEMP%/cat-cafe-evidence/dsh-pool-20261106/browser/`（JSON 与截图），fixture 为本工位忽略的 `.tmp/issue1882-browser*`；脚本完成即关闭浏览器与服务器。
- 完整设置页隔离预览被起点已有的 `search-group-picker.module.css` / `cafe-surface-paper` 样式编译错误挡住，因此只接受组件级浏览器验证，不宣称整页验收。Windows trusted-host fixture 也不代表严格启动隐私边界验收；没有运行 20 个真实 DSH 进程压测。
