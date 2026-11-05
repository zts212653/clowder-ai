---
feature_ids: [F171, F161, F320, F322]
topics: [issue-1466, configuration-contract, account-ref, adapter, compatibility]
doc_kind: technical-proposal
created: 2026-10-10
status: approved-configuration-phase
---

# #1466 技术契约与改动清单

> 用户已授权先实施配置优化；PR #1519 为唯一主线，取消 #1453 作为前置依赖。下文涉及 #1453 的能力作为历史参考，按需要在本主线吸收，不等待或合并该 PR。首启引导与一键安装后续依次实施；本轮使用全新独立体验环境。

主方案：[最终意见收敛方案](./issue-1466-final-implementation-plan.md)。以下“拟新增”不是当前 API 已具备的声明。核查基线：公开上游 `3e70e1d6805be24672e8f841861f180d20b184c2`；原生角色 `cbab6e1fc`；首启 `ab29b9d02`；探测 `373256c35`。

## 1. 对象和权威

| 对象 | 生命周期拥有者 | 本次契约 |
|---|---|---|
| 成员与配置意图 | 既有 runtime cat catalog / cats API | 稳定 catId；显式字段 patch；模板不覆盖已有身份和偏好 |
| 账号和登录 attempt | 既有 accounts 后端与 F320 | 唯一 accountRef；后端分配目录；前端不存凭据或第二身份库 |
| 安装描述 | #1453 工具发现/可用性注册表 | PATH/显式路径同源；首启与设置使用投影，不各造探测器 |
| 能力和模型目录 | 所选 adapter + 执行环境 | 按工具版本、账号环境、profile、cwd 缓存；附时间/来源/错误 |
| 编辑草稿 | 设置宿主内草稿 store（拟新增） | 以 user/project/catId 或 newDraftId 隔离，持有基线 revision 和字段差异 |
| 首启旅程 | 既有 first-run 服务与前端编排 | 成员创建、线程建立幂等；真实回复确认后才完成，不只写 localStorage |
| 回合采用快照 | invocation / session adapter | 开始时冻结账号、配置版本、会话；保存设置不改正在执行的回合 |

账号/工具/成员的列表由上述权威投影。UI 不保存另一份账号真相；已保存、预览、采用值是不同时间点的投影，不能互相冒充。

## 2. 配置语义与无损保存

1. `tool/client` 标识使用的工具；`adapter` 标识 Clowder 的接入实现；`program + argv` 或 SDK options 只是该 adapter 的启动配置，不反推协议。
2. 执行身份以现有 `accountRef` 为唯一引用。工具当前身份通过既有默认身份/解析规则表达；显式 OAuth 与 API-key 都进入原账号模型。v2 原型的 `identityRef/executionIdentity` 不进入新的生产身份表。
3. `model` 和 `effort` 在领域层分别表示 `inherit` 或 `override(value)`。存储仍映射既有字段；不为此整体替换 schema。
4. patch 缺字段表示“不改”；显式恢复跟随单独表示 clear 操作，并由服务端映射为删除对应覆盖。空串、null、undefined 的现有字段行为须在兼容转换器中固定测试，不能靠表单全量重建对象。
5. `configurationSource` 缺失时沿用旧行为；原有 `managed_account` 的默认值解释不全局改写。新 native 继承不再等于“丢弃 accountRef”；显式切换来源须先展示差异，取消不写。
6. 用户没改的未知嵌套扩展由服务端保留；不是把所有未知字段无校验地允许客户端写入。更新采用字段白名单/既有校验与版本冲突检测。
7. 模板只带身份、外观、职责和工具建议，不写模型/强度覆盖。探测到的默认值只用于带来源的预览，不持久回填。
8. 解析顺序为：选中执行环境 → 该环境的原生默认 → 成员显式覆盖 → adapter 能力校验。旧 managed 路径保留既有规则，不能顺手改变历史模型解析。
9. 工具目录失败仍可保留继承；只在 adapter 明确支持时允许手填模型。显式模型被拒绝应原位报错，不降级为默认模型。
10. 所选账号失效、被删除或不属当前项目时阻止相关调用并提示恢复；不可偷偷切回工具默认身份。切账号/工具使目录缓存和旧预览失效。

默认身份映射继续使用共享 `builtinAccountIdForClient`（例如 OpenAI → `codex`、Anthropic → `claude`），不为“工具当前身份”生成新 UUID。首启已有 `withNativeProfile` 只是 CLI 身份的视图；本次把该投影收敛到统一账户读取接点，不能让首启和设置各自合成一套权威。没有内置账号映射的自定义/DSH 环境继续按既有 adapter/profile 解析，不伪造 OAuth 条目；旧成员缺 accountRef 的解释保持兼容。

## 3. 三种状态如何显示

| 视图 | 数据来源 | 必须避免 |
|---|---|---|
| 已保存偏好 | cats API 返回的版本与覆盖意图 | 把未保存草稿显示成已保存 |
| 下次调用预览 | 配置解析结果，标账号、环境、时间和来源；未知明确显示 | 把目录推荐值说成原生默认，或把预览说成实际执行 |
| 当前会话实际采用 | 当前 thread/turn 的 adapter 回执 | 保存成功就更新“当前生效”，上一回合回执冒充新回合 |

只读展示可加“草稿预览”，但不能挤入上述已保存/实际区。安装、登录、可调用分别为已知成功、失败或未知，并记录证据来源与时间。仅 executable 存在不能推出登录；登录存在也不能推出请求成功。

实际模型/强度若协议不提供可靠采用证据，则标“未回报/未知”，保留请求参数作为请求意图，不自造成功回执。日志不含 token、授权目录详情或凭据内容。

## 4. 草稿、保存、返回与并发

| 事件 | 拟实现行为 |
|---|---|
| 打开成员 | 从服务端加载基线；同身份/项目/成员已有草稿时恢复并比较 revision |
| 编辑字段 | 计算相对基线的语义差异；底栏显示修改数；改回原值移除 dirty |
| 切成员/去登录 | 先保留草稿及原节/滚动位置；其他成员独立草稿，不复用同一 form 重置 |
| 登录后返回 | 校验返回目标属于本应用设置；刷新唯一账号列表，恢复原草稿，不自动绑定新号 |
| 刷新 | sessionStorage 仅存本会话非凭据草稿；按 user/project 隔离并校验版本；注销清理 |
| 放弃 | 只清当前草稿并还原已保存基线；取消添加不生成成员 |
| 保存成功 | 用服务端响应更新基线，仅清已提交差异；状态仍是“已保存，后续调用采用” |
| 保存失败 | 保留草稿与错误，原位重试；按钮恢复可操作，不显示全部成功 |
| 外部修改/多标签页 | 拟补 expectedRevision 或等价条件写入；过期拒绝并展示冲突字段，不能最后写入覆盖他人 |
| 离开应用/关闭页 | 浏览器允许时提示未保存；不保证关闭后长期恢复，显式保存始终权威 |

账号凭据从来不进入草稿。返回链接用受限的页面状态/草稿 ID，不携带密钥或任意外部 URL。

目前模型配置、session strategy、Codex 专属设置等存在分开保存路径。实施需一个前端保存协调器，明确每部分成功/失败；已成功部分重新读取，失败字段继续 dirty。**不伪称跨多个 API 原子事务。** 如果账号换绑已成功而另一偏好保存失败，明确展示实际已变账号，不暗中换回。

F320 binding 的 previewToken 与成员配置 revision 分别约束自己的写入；上游若不支持跨域同版本校验，需在保存期间串行、重取基线并暴露部分结果。过期 token 重预览且让用户确认变化，不能重放或扩大 `cat` 为 `family`。

## 5. F320：已报告、已核查、待验收分开

依据为 [zts 接口说明](https://github.com/zts212653/clowder-ai/issues/1466#issuecomment-6094825401)，内部实现状态是维护者报告，本机没有内部源码。

| 能力/接口 | 维护者内部报告 | 本机公开基线核查 | 本次接入要求 |
|---|---|---|---|
| `GET /api/accounts` | 已有统一账号链路 | 已有；当前返回 providers/unavailableAccounts 等视图 | 复用真实响应，不按原型虚构 accounts 数组 |
| `POST /api/accounts`，openai/oauth/displayName | 后端分配 ID 与登录目录 | 已有通用创建，但不足以证明具备 F320 隔离生命周期 | 等上游同步后按实际 schema 接入 |
| `.../:profileId/codex/login/start\|cancel\|confirm` | 已有；后两者校验 attemptId | 未找到公开 Codex 登录路由实现 | 原条目重试、取消；冲突使用上游 create-new 流程，不覆盖身份 |
| `GET /api/accounts/codex/members` | 已有 | 未找到对应公开实现 | 从后端列出可换绑成员，不由前端猜可见范围 |
| `.../:profileId/codex/binding/preview\|commit` | 已有；catId、scope、previewToken | 公开缺 `accounts-codex-binding.ts` | 消费上游预览；一次 token 提交；显示影响范围 |
| 普通/压缩会话换号后续聊 | 完整真人旅程仍在验收 | 本轮未验证 | 两类都是真实生产关闭门槛 |

对接前取得可同步的公开 commit/PR，复核路由注册、schema、ownership/project 校验与错误码。接口表不是凭名称重写后端的授权。source 未齐期间仅在测试数据层模拟，并显著标注模拟登录/调用。

公开 `accounts.ts` 当前用 `authType === 'oauth'` 推导 builtin。同步时必须验证命名公司/私人 OAuth 不被误归为不可管理的内置账号；按上游明确身份字段/既有 ID 规则区分，不能靠 authType 猜。

登录 attempt 由后端拥有，前端离页/刷新后按上游查询能力恢复，旧 attempt 的 cancel/confirm 不能影响新 attempt。若同步接口未提供恢复信息，将它列为缺口，不在前端臆造完成状态。

## 6. Adapter 与会话

| 工具/接入 | 当前依据 | 拟实施/验证 |
|---|---|---|
| Codex App Server | `CodexAppServerClient.ts`、`CodexAgentService.ts` 已有 | 模型目录/默认、逐项覆盖与清除、选账号环境、回合快照和真实续聊 |
| Codex exec | 既有兼容路径 | 保留旧接入，不能因 tool=openai 自动迁移；新默认选择 App Server |
| Claude 结构化 CLI | `ClaudeAgentService.ts` 已有 | 原生默认、必要 stream-json 参数、覆盖/恢复与取消；不读默认值时启动完整 agent |
| Claude Agent SDK | `ClaudeSdkAgentService.ts` 与 carrier `agent_sdk` 已有 | 作为独立 adapter；保留已选 SDK，校验 SDK options，不暴露通用 command |
| DSH / 通用 ACP | `acp/AcpClient.ts`、factory、session-configuration 已有 | 保留既有 program/argv/profile；按握手能力设置模型/强度，验证 resume/load、取消、权限和错误 |
| 其他已支持工具 | 原 provider/carrier 注册 | 保留现有路径；未验证的自定义启动能力不因 UI 有输入框就宣称支持 |

程序路径和 argv 数组分别保存，含空格可往返；只向声明兼容的 adapter 开放替代程序，协议错误显式报错，不退到另一程序。SDK 无通用 shell 命令。

每回合冻结 catId、accountRef、adapter、配置版本和 native session 绑定。账号/环境/profile/cwd 等决定进程与目录缓存隔离，不让公司号重用私人号的认证进程。原生配置外部更新后刷新后续解析；不承诺 cc-switch 修改后所有现有进程立即热更新。

换号在当前回合结束后用于下一次调用；按 F320/adapter 已有恢复链路继续同一 Clowder 对话。Codex 普通会话与已压缩会话都要继续合作；不能以“历史列表仍在”验收，更不能要求用户重新开对话。恢复失败保留会话、展示原因和重试，不静默创建空白上下文。

## 7. 兼容字段账

| 字段域 | 页面入口 | 保存/迁移规则 |
|---|---|---|
| catId、别名、职责、个性、擅长与限制 | 身份与职责 | 换工具不重建 ID；模板不覆盖用户自定义文本 |
| 头像、主色、旧 secondary | 身份/外观 | 主色派生效果；旧值保留，不新增重复背景色字段 |
| accountRef、provider、endpoint | 模型与接入、账户与密钥 | 有效旧账号正常显示；不自动改直连或删除共享账号 |
| adapter、ACP command/argv/profile、transport | 高级接入 | 保留原协议；clientId 不用于猜 adapter；显式切换先预览变化 |
| model、effort、speed 等 | 模型与接入 | 按能力显示；各自恢复，不解绑账号，不写工具全局配置 |
| contextWindow、旧 cli.contextWindow | 上下文 | Auto 与手动上限区分；沿已有迁移规则处理旧字段 |
| session chain、handoff/compress/hybrid、阈值 | 上下文与会话 | 意图保留；不支持时明确阻止/提示，不冒称执行成功 |
| voice、语言、速度、参考音频等 | 语音 | 改名字/工具不清空；关联原 voice 管理 |
| MCP、权限/沙箱、进程池/TTL、未知扩展 | 高级或原对象保留 | 未提供编辑入口也不丢字段；受保护身份/权限校验保持 |

## 8. 精确模块改动账

以下路径相对仓库根；“native”表示目前只在原生角色分支，接入时按审计处理。

| 位置 | 改什么、为什么 |
|---|---|
| `packages/web/src/components/settings/SettingsShell.tsx`、`SettingsShellV2.tsx`、`SettingsContent.tsx` | 保持宿主导航；成员列表/添加/详情子状态、返回恢复，替换当前成员编辑 modal 接线 |
| `HubCatEditor.tsx`、`hub-cat-editor.model.ts`、`.payload.ts`、`.sections.tsx`、`.acp.ts`、`NativeRuntimeSection.tsx`（native） | 复用字段解析；去掉 native 清 accountRef；提取分节、每字段 clear、无损 patch；新草稿 store 不靠 open/cat effect 重置 |
| `HubMemberOverviewCard.tsx`、`HubAccountsTab.tsx`、`hub-accounts.*`、既有认证 modal | 成员状态摘要、同工具账号分组、唯一登录入口；F320 返回编辑位置 |
| `packages/shared/src/types/cat.ts`、`cat-breed.ts` | 增量类型、来源与能力投影；保留旧字段兼容，不新增 OAuth 身份库 |
| `packages/api/src/config/cat-account-binding.ts`、`cat-config-loader.ts`、`cat-models.ts`、`runtime-cat-catalog.ts`、`routes/cats.ts` | 显式 accountRef 必须解析；native 继承/旧默认分开；条件写入、未知字段保留、原子 catalog 持久化复用 |
| `domains/cats/services/agents/invocation/invoke-single-cat.ts` | 拆除 native 一刀切跳过账号；构建执行快照、按环境注入和隔离、接续会话与回执 |
| `domains/cats/services/agents/providers/` 中上述 carrier、SDK、ACP 文件 | 根据 adapter 能力应用覆盖、清除和恢复；不由 configurationSource 强制替换已选 adapter |
| #1453 的 `client-descriptor.ts`、`ProviderAvailabilityRegistry*`、`cli-resolve*`、`routes/clients.ts` | 统一安装事实；与首启 `client-auth.ts` 和 native `routes/native-runtimes.ts` 分清投影，避免三套探测权威 |
| `routes/accounts.ts` 与上游 F320 路由 | 按真实上游实现接入；补 OAuth builtin 分类回归，不独立复制账号后端 |
| `FirstRunQuestWizard.tsx`、`first-run-quest/*`、`ChatContainer.tsx`、`routes/first-run-quest.ts` | 一个首启编排器；模板推荐清单、同源登录/创建、幂等恢复、真实回复完成 |
| `components/onboarding/*` | 目前另一套未挂载 OnboardingJourney；有用展示片段迁入唯一编排器，移除重复持久化流程后再清理文件 |
| 既有 F155/F229 接点、`ThreadChatSurface.tsx`、`usePinnedSections.ts` | 同成员身份交接、就地引导；pin 按待决策略实施，保留旧选择 |

拆分时遵守 200 行警告/350 行硬限，不继续把所有状态塞进大型编辑器。新增测试及真实宿主验证范围见[验收矩阵](./issue-1466-acceptance-matrix.md)。
