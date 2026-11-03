---
feature_ids: []
topics: [agent-client, settings, model, reasoning-effort]
doc_kind: plan
created: 2026-11-03
tips_exempt: "修复既有成员设置摘要与能力读取，不新增用户入口或操作。"
---

# #1801：成员模型与思考强度的读取和展示

原托付：`thread_owned_bd6fcd6413989936a25dfd5ba6e5d9b1e4dfc4ba#0001793693409293-000140-8045a988`。
Issue：https://github.com/zts212653/clowder-ai/issues/1801 。
实施者 codex，方案讨论与独立审查 claude-code；PR 目标 `next`。
本工位基线：`upstream/next@6c2021d494b7fe0f7a5423868709d4ae99c097ed`。

## 当前问题与目标

可选目录、工具默认、成员覆盖、客户端上报是不同信息。现有页面将当前配置摘要绑定在目录 live 状态，Claude 漏 env/每模型设置，Kimi 已有能力元数据未投影且执行层旧名称规则漏新模型，ACP 还存在合法空默认及切换模型后强度来源混用。

目标是所有现有入口都显示可信的模型/思考信息或明确原因，并让已有 Kimi 覆盖能力与展示一致。未知字段不猜等级，保留现有原生/ACP/插件接入、用户设置和角色继承语义。

## 已收敛的实现

1. 沿现有 RuntimeModelCatalog 及两条模型目录路由补充缺少的值/显示名/来源信息；原工具默认与选中模型后的强度分别保存，避免替换默认事实。
2. Claude 优先复用锁定 SDK 0.3.285 的 resolveSettings；结果仍是配置快照。按客户端规则读取 env/每模型/顶层值，未取得 native final 值时不标为运行采用。
3. Kimi 在一个 TOML 读取边界校验并投影模型元数据，由发现与实际调用共同使用 support_efforts/default_effort/thinking。保留适用的旧版本行为，不通过扩大模型名称正则代替真实元数据。
4. 前端目录状态与已知配置摘要独立；成员覆盖、工具默认、当前探测上报有明确文字。合法空 ACP 值显示其原生名称，不能作为“没有读到”处理。
5. OpenCode/AGY/Cat Agent/A2A/自定义配置/插件无读取或采用能力时，展示准确状态；既有保存偏好保留，不把它写成已采用。

方案讨论记录：`0001793693886677-000156-ea3ada61`、`0001793693950179-000159-417c3047`、`0001793694220085-000168-97b43dd3`。已接受小型 Kimi 专用读取边界及展示/执行共用；使用已有 smol-toml/zod，不引新依赖。ACP 空串仅保留客户端显示语义，成员空值继续代表继承，不新增持久化契约。不新增能力中心、数据库或会话协议，不改变既有布局和入口。

Claude SDK 的 resolveSettings 合并本地 user/project/local/managed 配置；不运行 policyHelper，也不保证含最新服务端策略。该 alpha 方法读取失败不影响已取得的模型列表，仍受现有 20 秒探测总截止约束。配置优先级：环境覆盖优先，模型级 effort 优于顶层 effort；别名仅用 SDK 声明的 resolvedModel 对应每模型设置，不用人类显示名猜真实 ID；不把目录第一项当默认。

预读反馈 `0001793694389122-000172-8f03168b`：删除 Kimi 未声明默认时选中间档的逻辑；thinking 开关单独返回，不能充当 effort 档位。`defaultEffort` 明确为工具默认（显式 thinking.effort 或模型已声明 default_effort），两者均标本地配置，不声称是用户显式设置或实际调用采用值。无元数据时才走旧版能力兼容表，已知模型无 tiers 时不借相邻表或名称猜能力。

Architecture cell: existing agent-provider / member-settings read path.
Map delta: none.
Why: 仅补全现有目录 DTO 的可选来源/选中值字段和专用 TOML 边界，不新增接入适配器或状态所有者。

## 与 #1800 的已确认边界

跨 thread 归口消息：`0001793693734653-000151-8000ef73`，我方确认 `0001793693810112-000155-8f0aa330`。

#1800 保留 RPC 总预算 45 秒、前端原生 ACP 等待 60 秒、DSH 自动复制边界准确文案、默认模型 provider group+label 与“客户端回报”来源说明。#1801 不重写这些窄变化；后续按 exact SHA/next 合并顺序处理 `runtime-model-catalog.ts`、`useRuntimeCatalog.ts`、`MemberRuntimeFields.tsx` 的交叉。

对应 PR #1804；还须保留“默认未上报”的说明仅用于 live 的限制。刷新失败时清除 ACP 旧默认模型及其强度；仅切换模型时清除选中模型强度，保留原工具默认事实和可用目录。

## 验证与完成标准

- RED：配置目录 status=configured 时，页面仍须显示已知默认模型和 high；当前真实组件测试按缺少模型文字失败，原有账号隔离/加载用例保持通过。
- API：Claude 配置优先级/来源；Kimi 元数据/别名/无 tiers；ACP 原默认、选中值、空值、未上报和失败缓存；两个目录路由都保持账号边界。
- Web：所有入口显式状态，切换模型/账号不显示旧来源；已有覆盖和继承均正确显示，配置摘要不依赖 live。
- 执行：Kimi tier 元数据决定覆盖采用；无 override 的 native_tool 继续由 CLI 决定；关闭 thinking 不被重新打开。
- 检查：定向回归、相关 API/Web 类型与构建、代码格式、非作者 exact-HEAD review，随后关联 PR 合入 next。
- 真实客户端/Windows/macOS 证据分别记录。未运行的场景不计为通过，不用模型自述证明 model/effort，也不在真实原生历史内制造测试会话。

回退维持现有持久化模型/强度原值；新增读取元数据可随单个提交回滚。测试使用隔离临时状态，不写运行版配置、认证、历史或数据存储。

## 作者验证记录

- 初始 RED：API 49 项中 4 项分别复现 Kimi 保存强度被丢弃、目录漏强度、ACP 选中强度缺失及空默认标签丢失；Web 5 项中 1 项复现配置状态隐藏摘要。补充反例复现 Kimi 未声明默认却返回中档、thinking 关闭被混入档位，以及 Claude 显示名误当真实 ID。
- 定向 API：73 项通过，覆盖真实 SDK library + 外部 fixture 程序、ACP 无 prompt 探针、Kimi spawn env/原生路径隔离、目录和缓存；Claude resolvedModel 增量检查另记最终 PR。
- 定向 Web：25 项通过，覆盖成员目录、工具切换、保存契约、原生角色及插件目录；API/Web TypeScript 检查通过。Biome error-level 与 git diff --check 通过；capability-tips 检查通过（既有缺失内部文档警告保留）。本导出仓没有 check:architecture-ownership 命令，所有权由上述 cell/Map delta 人工核对，不声称脚本通过。
- 浏览器：本 checkout `http://127.0.0.1:5131/settings?s=members&cat=codex61-sol&shell=v2&lang=zh`，真实 Next 页面和 apiFetch，封闭 HTTP/Socket fixture，无 API/Redis/模型进程。Kimi 配置模型/high 可见 → 切到另一模型后显示 low → 保存 max 并重进保留 → 503 刷新显示失败 → 重试恢复 → Claude 配置摘要可见 → OpenCode 未知值不借旧客户端值。页面 errors=[]，未知遥测 member-save POST 被隔离边界返回 503；不作为遥测功能验收。
- 浏览器证据：本机临时目录 `clowder-issue1801-browser` 下 result.json、kimi-inherited.png、kimi-saved.png；失败的旧 fixture 依赖缺失与保存条显隐断言不计通过。截图已人工查看，与用户原截图的成员页入口和布局一致，只补全原状态区域。
- 验证边界：Windows 源码/隔离 fixture 证明本次读取与显示契约；没有把 HTTP fixture 保存等同于真实客户端采用，没有运行付费模型请求，也没有 macOS 实机验收。现有安装实例尚未加载此分支。
