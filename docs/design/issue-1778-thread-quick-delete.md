---
feature_ids: []
topics: [thread-sidebar, deletion-confirmation, windows-desktop, user-journey]
doc_kind: design
created: 2026-11-02
updated: 2026-11-03
tips_exempt: 行尾入口、确认复选框和个人设置开关均在原操作位置自解释，不新增需要单独提示才能发现的能力入口。
---

# 会话快捷清理：用户旅程设计与技术方案

来源：[Issue #1778](https://github.com/zts212653/clowder-ai/issues/1778) 及当前聊天中的三张现状/参考截图。用户要求先看基于项目现有界面的效果图、用户旅程及技术方案。

状态：用户已接受设计并授权实现；这表示需求方确认，不代表维护者已正式接纳。初次草稿隔离修复后，维护者又复现了认证等待时跨身份发送 DELETE 的 P1，以及读取完成后显示旧提示的 P2；本轮补充修复及回归，仍待维护者复审。Issue 已有 `triaged`，仍带 `needs-maintainer-decision`；正式接纳与合入结论以 [PR #1780](https://github.com/zts212653/clowder-ai/pull/1780) 为准，尚未合入或发布。早期原型与产品验证分别记录。

设计与实施起始基线：`zts212653/clowder-ai` 的远端 `next@b926134a02dec551d857d378fc0519ebe66dc090`。后续同步了 `next@917120d55bb5bf618a3cc49c0749d5f5172ace46`，本轮复审修复又同步至 `next@1016aa7a3`。实施分支 `feat/issue-1778-quick-delete`，复用原设计工位。runtime 仍保持原检出与构建。

## 1. 设计判断与复用依据

判题：在保持现有回收站和保护规则的前提下，是否可以让经常清理普通会话的用户把每次三次点击降为一次，同时让其他用户继续得到二次确认。

设计类型：`product_experience_gate × internal_product_gate`。本稿保留已接受的体验与技术契约，第 6 节记录产品实现验证边界。

| 画面 | 实际复用 | 本次设计变化 |
| --- | --- | --- |
| 会话列表 | 直接渲染 `ThreadItem.tsx`；沿用标题、置顶、更多、时间、状态和现有布局 | 在原有动作区增加普通会话的垃圾桶入口 |
| 垃圾桶 | `hub-icons.tsx` 内已有的 `HubIcon name="trash"`，24×24 viewBox，统一描边风格 | 行尾用 14px 线性图标，不新增图标库或重画图标 |
| 确认框 | 从 `ThreadSidebar.tsx` 提取现有 `DeleteConfirmDialog` 渲染，保留颜色、384px 最大宽度、遮罩、按钮和提示 | 普通会话增加“不再提醒”复选框 |
| 设置 | 沿用 `YouSettingsPage.tsx` 的“你”入口、卡片结构和项目 token | 增加“会话操作”卡片及确认开关 |
| 色彩与字体 | 本分支 `theme-tokens.css`、`console-tokens.css`、`shell-v2.css`、`@cat-cafe/ui/styles.css` 及 Tailwind 配置 | 不建立另一套视觉主题 |

会话行与确认框为真实组件的设计变体；周边聊天内容、设置资料和导航为同一套 token 下的静态语境。用户/猫的名字、内容均为演示数据。灰色设计控制条属于评审工具，不进入正式界面。

保留：会话标题优先、现有更多菜单、置顶/未读/状态、回收站恢复、当前会话删除后的返回大厅行为、系统会话增强确认。

## 2. 用户旅程

### 旅程 A：首次删除，继续保留确认

1. 用户把鼠标移到普通会话行，行尾出现垃圾桶；键盘进入该行时也可到达。
2. 点击垃圾桶，沿用现有确认框，显示目标会话名称和回收站说明。
3. “后续不再提醒（仅普通会话）”默认不勾选。
4. 用户直接点击“移入回收站”。成功后该会话离开列表，显示轻提示。
5. 下一次删除普通会话仍然弹框。无需额外设置即可保持二次确认。

### 旅程 B：记住选择，后续一次点击

1. 用户在确认框勾选“后续不再提醒（仅普通会话）”。
2. 用户确认删除；仅在本次软删除成功后保存关闭确认的偏好。
3. 后续点击普通会话的垃圾桶，直接移入回收站，显示“「会话名称」已移入回收站，可从回收站恢复。”
4. 从原有更多菜单选择“删除对话”也读取同一偏好。
5. 删除非当前会话时，用户继续留在原对话；删除当前打开的会话时返回大厅。

成功标准：关闭确认后，发起一次普通会话软删除只需要一次点击。不同会话可以连续清理，不要求每次重新进入菜单。

### 旅程 C：恢复二次确认

1. 用户进入“设置与管理 → 你”。
2. 在新增的“会话操作”卡片看到“删除普通会话前确认”开关。
3. 将开关重新打开，立即保存；不与姓名、头像等资料的“保存”按钮耦合。
4. 返回会话列表，下次删除恢复确认。

说明文案：“关闭后，点击删除将直接移入回收站。系统会话仍需确认，你可以随时重新开启。”

### 旅程 D：找回误删会话

1. 用户打开侧栏现有“回收站”。
2. 找到会话，使用现有“恢复”动作。
3. 会话回到列表；正式验收须进一步核对历史可读，而不只检查标题回来。

### 取消、失败与受保护会话

| 场景 | 结果 |
| --- | --- |
| 勾选后取消、Esc、点击遮罩 | 不发删除请求，不保存这次勾选；下次继续确认 |
| 删除失败 | 会话保留，显示原因；不显示成功，不因勾选而关闭未来确认 |
| 正在运行 | 继续消费后端 `409 / ACTIVE_INVOCATION`，提示等待当前任务完成 |
| 大厅 | 没有删除入口 |
| IM Hub / `systemKind` 会话 | 不显示行尾快捷入口；保留菜单、输入名称确认及后端 `force=true` 保护 |
| 偏好读取失败或用户身份未确定 | 默认显示确认 |
| 确认框开启期间认证身份变化 | 旧确认框失效并关闭；旧勾选和旧确认回调不能用于新身份 |
| 删除成功但偏好保存失败 | 告知会话已移入回收站、偏好未保存；下次仍确认 |

## 3. 视觉与交互规格

- 行尾排布为“更多操作 → 垃圾桶”。保留原有时间与状态位置，垃圾桶占固定槽位，隐藏时也不让标题跳动。
- 使用项目现有 `HubIcon name="trash"`，按钮命中区 24×24px，线性图形 14px。默认灰色与“更多操作”一致、背景透明；仅悬停在删除按钮时图形变为危险色，保持透明背景。
- 行尾图标在 hover / focus-within 时显示；触屏保留原有菜单，并显示可直接操作的快捷入口。
- 使用现有 `RowTip`：v2 走 `AppTooltip`，classic 延续现有提示形式。可访问名称包含目标标题，例如“移入回收站 问题反馈分析”。
- 点击按钮阻止行点击冒泡，避免同时切换会话；不引入列表级快捷删除键。
- 复选框置于回收站说明之后、底部按钮之前；取消保持次要样式，“移入回收站”保持现有强调样式。
- 设置开关命名为肯定语义“删除普通会话前确认”，默认开启；不使用需要推理双重否定的开关名称。
- 首版同时覆盖 classic / v2，以及最近、项目、置顶、收藏等复用 `ThreadItem` 的列表。

## 4. 技术方案

### 4.1 复用既有命令与删除接口

`ThreadItem.onDelete(id)` 仍是行组件唯一的删除回调。行尾按钮和菜单删除项都调用它，不在行组件中直接调用 API，也不在两个入口各存一套确认状态。

`ThreadSidebar` 的 `handleDeleteRequest(threadId)` 负责决定是否弹框：系统会话始终走增强确认；普通会话按确认偏好决定弹框或执行软删除。把目前 `handleDeleteConfirm` 中的请求主体整理为共享的 `performDelete(thread, rememberChoice)`，供两条路径调用。此处抽取有真实复用，不拆出一次性工具层。

保留现有接口：

```text
普通会话：DELETE /api/threads/:id
系统会话：DELETE /api/threads/:id?force=true（增强确认通过后）
恢复会话：POST /api/threads/:id/restore
```

本改动不需要调整软删除数据结构、回收站生命周期或删除 API 的授权规则。

执行顺序：捕获目标会话 → 标记该行处理中 → 请求 → 根据明确结果更新列表和当前路由 → 成功提示 → 必要时保存个人偏好 → 结束处理中。相同行按钮在请求期间禁用，其他空闲会话仍可操作。

失败处理消费现有状态/错误码。对于连接中断造成的结果不确定，沿用 API client 的连接反馈与列表重新读取，不直接宣称已删除，也不自动重复发删除请求。

### 4.2 个人偏好保存

增加一个轻量的前端确认偏好 hook/模块，由侧栏和设置页共同消费。建议文件：`packages/web/src/hooks/useThreadDeletePreference.ts`。只有存储读写、当前快照和订阅职责，不建立通用偏好框架。

- 字段语义：`confirmBeforeDelete`，默认 `true`。
- 持久化：当前客户端的 `localStorage`。键带版本，并以当前 API 来源和已验证 `ownerUserId` 分区，例如 `clowder:thread-delete-confirm:v1:<api-origin>:<ownerUserId>`。
- 用户身份来自现有 `apiSessionIdentity`，不能从显示名称、会话标题或用户输入反推。
- `on/off` 在存储边界解析一次；内部传明确布尔值。未设置、不可读、身份未确定时均保持确认。
- 正常刷新/重启并回到相同实例地址后复用该偏好；不以提交 SHA、安装版本作为 key，避免每次升级重置。
- 不写 `.env`、实例共享配置或其他用户的偏好，不提供跨设备同步。若桌面实例地址发生迁移，首版回退为默认确认；该迁移不承诺自动继承“不再提醒”。
- 弹窗的勾选状态只是本次局部草稿。普通会话软删除成功后才写入持久偏好；设置页开关则独立保存并即时通知侧栏。
- 草稿与偏好写入回调绑定现有认证身份快照。身份变化会关闭旧确认框；即使切回原用户，旧草稿也不复活。请求过程中身份变化时，旧响应不保存偏好或导航当前用户。
- 每次删除订阅同一身份源，变化时取消该操作的 `AbortSignal`；信号传给现有 `apiFetch`，覆盖认证等待、401 重试与实际发送。正常的同用户刷新仍允许继续。身份变为未知或变化后，用户需在新身份下重新发起操作；不自动重放旧确认。
- 身份约束持续到列表和回收站读取完成；每次 await 后检查取消状态，旧操作不能继续发起回收站刷新或显示旧标题提示。不改写全局 Sidebar 数据体系。

原型里的偏好仅保存在组件内存，用于评审旅程，不构成这部分持久化实现的证据。

### 4.3 最小状态与所有者

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 确认偏好 | 共享前端偏好模块 | 用户主动修改；当前客户端刷新/重启可恢复 |
| `deleteDraft` | 现有侧栏 | 请求确认时捕获目标与身份；取消、确认或身份变化后失效 |
| 本次“不再提醒”勾选 | 确认框 | 打开时为 false；随本次弹窗销毁 |
| 请求中会话 ID | 删除执行逻辑 | 请求开始到结果处理结束；只供按钮处理中使用 |
| 操作身份订阅 / AbortController | 删除执行逻辑 | 发请求前创建；身份变化同步取消；请求及结果处理结束后在 finally 解除订阅 |
| 软删除标记与回收站 | 现有后端 ThreadStore | 原有删除/恢复流程；不在客户端另存一份会话事实 |

### 4.4 建议改动文件

| 文件 | 改动 |
| --- | --- |
| `components/ThreadSidebar/ThreadItem.tsx` | 复用图标增加行尾按钮、提示、固定槽位、处理中样式 |
| `components/ThreadSidebar/ThreadSidebar.tsx` | 共用删除执行、确认分支、成功/错误反馈 |
| `hooks/useThreadDeletePreference.ts`（新增） | 单一确认偏好、存储与订阅 |
| `components/settings/YouSettingsPage.tsx` | 增加独立的会话操作卡片；按文件体量决定是否独立组件 |
| 对应 `*.shell-copy.ts` | 新增按钮、复选框、开关和反馈的中英文文案 |
| 既有会话动作、确认框与设置测试 | 更新旧断言并补充行为用例 |

`ThreadSidebar.tsx` 已是大型文件。此改动不顺带重构整个侧栏；对新增职责使用小范围模块，新增文件遵守 200 行预警/350 行硬限。

代价：每行多预留一个 24px 动作槽，长标题可能更早换行；首次弹窗增加一行复选框；前端多一个小型偏好订阅。换取连续清理时省去菜单和确认两步，不增加常驻服务、模型调用或后端轮询。

Architecture cell：现有会话侧栏 / 个人前端偏好。Map delta：none，沿用既有 thread 删除与恢复契约。

## 5. 实施与验证工作单元

1. **确认偏好与弹窗分支**：先给现有确认测试增加默认确认、成功后记住、取消不保存、失败不保存、设置恢复的失败用例，再实现并观察通过。
2. **行尾入口与双入口一致**：更新 `thread-item-actions.test.tsx` 中“删除仅在菜单”的旧断言，覆盖图标复用、目标 ID、点击不触发行选择、大厅/系统无快捷入口；确认菜单也读取同一偏好。
3. **状态反馈与恢复**：覆盖成功/失败、运行中拒绝、当前/非当前路由和回收站恢复，避免只断言 toast 文本。
4. **页面视觉与 Windows 安装版**：用同一组长中文标题、未读、运行中、窄侧栏，对照 classic / v2；在真正包含实现的 Windows 包中验证首次默认、重启保留、恢复开关、恢复历史。

以当前仓库脚本为准，产品实现后至少运行：

```powershell
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/thread-item-actions.test.tsx src/components/ThreadSidebar/__tests__/thread-delete-confirm.test.ts
pnpm --filter @cat-cafe/web exec tsc --noEmit
pnpm biome check <本次修改文件列表>
```

新偏好模块和设置行为测试补入定向命令。涉及正式合入时按受影响范围完成 `pnpm check` 及仓库要求的独立审查；本设计稿不以原型检查替代产品自检、review 或安装版验收。

## 6. 产品验证记录（2026-11-02）

实际实现复用 `ThreadItem`、侧栏删除回调和既有回收站恢复；将确认弹窗和删除执行整理为局部模块。偏好 hook 由侧栏与“你”设置共同订阅。后端接口与持久数据结构无改动。

五轴风险：behavior=中（新增直接操作和确认分支）；data=中（复用可恢复软删除）；security=低（不改授权）；contract=低（不改 API）；irreversible=低（不新增永久删除）。Architecture cell=会话侧栏/个人前端偏好，Map delta=none。

### 作者实际旅程

浏览器从真实 `ThreadSidebar` 行尾进入确认框，验证勾选后取消不保存、成功后记住；刷新后另一个普通会话一次点击移入回收站；运行中会话返回真实 API 的 409；恢复首个会话并读取原 MessageStore 中保留的历史；进入真实 `YouSettingsPage` 重新开启确认；关闭浏览器上下文重进后偏好仍然存在。另检查深色与 390px 视口。浏览器无脚本错误。

宿主边界：测试只替代 Next router/socket，使用生产侧栏、设置、偏好、apiFetch、Fastify `threadsRoutes`、ThreadStore 和 MessageStore；API 请求经 `app.inject` 处理，无监听端口、Redis 或模型调用。历史来自隔离测试会话。此项证明产品组件/API 旅程，不冒充 Windows 安装验收或用户业务历史验收。

执行目录为本分支工位，测试来源地址 `https://f322-chat-real-page.test`，不是运行中的 3003/3004。

### 可重复检查

```powershell
# 组件行为、身份边界、原确认流程、行操作、设置语言、文案、GET 协调与快照：57/57
pnpm --filter @cat-cafe/web exec vitest run src/components/ThreadSidebar/__tests__/thread-delete-identity.test.tsx src/components/ThreadSidebar/__tests__/thread-quick-delete.test.tsx src/components/ThreadSidebar/__tests__/thread-delete-confirm.test.ts src/components/__tests__/thread-item-actions.test.tsx src/components/settings/__tests__/settings-shell-v2-language.test.tsx src/components/shell/__tests__/shell-copy-namespaces.test.ts src/utils/__tests__/api-client-get-coordination.test.ts src/utils/__tests__/sidebar-thread-snapshot-generation.test.ts --maxWorkers=2

# packages/api 下执行；浏览器完整旅程及认证边界：4/4
node ../web/scripts/run-with-node-env-test.mjs node --import tsx --test --test-concurrency=1 ../web/test/browser/thread-quick-delete.test.mjs

# packages/api 下执行；既有软删除/恢复/运行中保护：19/19
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-name-pattern='DELETE|restore|deleted=true|soft-delet' test/threads-endpoint.test.js
```

前端和 API 类型检查已通过。`thread-sidebar-destination-return.test.tsx` 的六项导航/删除检查通过；两项“项目归档”检查在本分支与恢复原始 `next` 侧栏源码后均因 `no project header menu` 失败，属于既有基线，不修改无关项目归档行为。

连续清理回归曾观察到两个 RED：第二次删除复用第一次删除后的旧列表 GET，导致已删除行残留；展开回收站的旧 GET 也可能遗漏刚删除会话。现在删除/恢复复用现有 canonical invalidation 和 `afterCurrentGet:true`，浏览器延迟响应回归均已 GREEN。

### Windows 打包程序与独立审查

验证源码为 `227eafbab19fa3647168f8aa2fd41fd755b4a3c9`。使用官方构建生成的安装运行归档，经项目自带提取器校验哈希/条目后，在标准 Windows 临时目录启动打包 Electron 35.7.5；API/Web 的构建提交均与源码一致。使用独立的数据目录、空白客户端 HOME、13378/13379/6398 端口，不复用个人认证或原生会话。

已走通：classic 首次确认与勾选取消；成功后记住并返回大厅；真正退出应用、释放端口并重开，v2 普通会话一次点击删除；现有回收站恢复后在生产聊天页面读到原 Redis 历史；真实“你”设置重新开启确认，页面刷新后仍要求确认；Esc 取消保留会话。最后一段设置验收在同源码、同实例数据上续验，前面已通过的阶段保留原始记录；不是把一份失败的整套脚本标成通过。页面脚本错误为零，无模型调用。

作者验收期间确实出现过启动错误窗口：Low 完整性测试目录的渲染异常，以及脚本在初始加载未完成时跳转造成的 `ERR_ABORTED`。改用标准目录，并让脚本等待应用 `startup-state.json` 明确报告 `ready` 后再操作；通过桌面窗口检查和进程核对完成收尾。首次使用的预置演示通过产品“稍后再看”动作关闭。上述失败保留为诊断记录，不计入通过项。

范围边界：未执行安装器首装/升级，未改动真实 runtime。官方构建已生成 EXE；额外便携 ZIP 压缩已停止，未签发发布清单或交付发布包。此处证明同一安装运行归档中的 Windows 程序功能旅程，不声明安装器生命周期或升级兼容验收。

初轮非作者 `review_quick_delete` 审查覆盖同一实现提交，发现的 P2 已修复，当轮未发现其他 P1/P2；独立行为检查 24/24、协调/快照检查 12/12 通过。该实现提交的远端 CI 为 19 项成功、1 项条件跳过。之后维护者在 `5e8d703` 上补充复现身份草稿 P1，因此初轮结论不代表最终批准。

维护者 P1 修复：新增 5 项生产侧栏/删除 hook 回归，先观察到草稿未关闭、旧回调仍发送 DELETE、旧请求保存偏好的 RED，再验证 GREEN。覆盖换用户、身份暂未确定、A→B→A、保留旧确认回调、请求中换用户；相关前端检查合计 55/55。浏览器组合旅程同时通过真实 `refreshApiSession()` 切换认证身份，核对弹窗关闭、未发送删除/未保存偏好、切回原用户后重新勾选才能记住。当前修复尚待维护者复审；没有为此重建或重跑 Windows 安装程序。

### 复审补充（2026-11-03）

上一轮只在 hook 入口和 DELETE 响应后核验，遗漏了认证等待与后续读取两个异步边界。现有共享认证流程已有 AbortSignal 取消支持，本次在操作侧复用它，不新增 API 选项、后端接口或身份状态源。

- 生产浏览器 RED：暂缓新身份 `/api/session` 响应，在身份仍显示旧用户时确认；观察到 1 次新身份 DELETE。401 场景观察到第 2 次 DELETE 被新身份执行；同用户刷新对照保持通过。
- 组件 RED：DELETE 成功后分别暂停列表 / 回收站 GET，换用户再交付当前用户列表，均观察到含旧会话标题的成功提示。
- GREEN：相关组件检查 57/57；生产浏览器 4/4，包含完整清理恢复旅程、认证等待时换用户、同用户刷新、401 重试。换用户后零跨身份 DELETE、无旧偏好写入，原历史恢复仍可读。测试夹具的启动与真实 routes 接线提为共享 fixture，避免增加场景后单文件超过 350 行。
- 边界：仍需维护者对新 HEAD 复审与当前 CI；本轮没有重建 Windows 包、运行安装器、改动 runtime 或连接用户数据。旧包记录保持原提交范围。

早期设计原型有独立的 13 项演示检查，不能替代产品证据。

工位与当前构建目录为开放 PR 保留，2026-11-16 复查；测试进程、窗口和端口均在采证后停止，数据与日志保留。失败目录仅为本次 Windows 启动诊断保留，2026-11-09 复查。未改动 runtime、个人配置或业务历史。
