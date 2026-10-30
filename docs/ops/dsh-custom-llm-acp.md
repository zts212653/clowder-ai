---
feature_ids: [F241]
topics: [acp, dsh, custom-provider, troubleshooting]
doc_kind: user-guide
created: 2026-10-22
tips_exempt: "DSH 成员配置入口直接提供复用步骤与主动验证费用提示，无需额外弹出提示。"
---

# DSH ACP 使用自定义 LLM

适用情形：DSH Desktop/Web 的自定义模型能够使用，但从 Clowder 启动 DSH ACP 时，
却要求 `deepseek-official` 的 API key。先检查 ACP 实际选中的 provider，
不要因此给自定义接口补配官方 DeepSeek key。

本文对应 DSH 源码 `687f282e8625c6b8d11ff58211a90524be2e4317`（包版本 `0.2.1-rc.2`）。
该版本的 ACP bundle 默认选择 `deepseek-official / deepseek-v4-flash`；
Desktop、Web 和 ACP 各自的 profile 配置不会自动相互复制；home 层配置则由这些 profile 共享。
同一 `DSH_HOME` 的凭据引用可被这些 profile 使用，但有凭据并不等于 ACP 已配置并选中对应路由。

## 推荐伙伴直接复用已有连接

内网版重新检测时自动检查已有路由、模型和凭据引用，优先复用可用的原生配置，也会查找
Desktop/Web 的现有接口。官方或自定义路由都以实际配置为准；缺 key 的官方默认路由不被
当作可用连接。检测不会请求模型、生成成员 patch、复制密钥或更改原生配置。
实际首次连接时，原生 DSH 仍可能按自身版本规则迁移旧格式凭据；这与 Host 的只读检测不同。

检测到可复用连接后，DSH 伙伴默认勾选，推荐卡片始终只显示摘要，没有“调整”按钮或内嵌表单。
点击“一键创建”时再核对来源 revision、生成成员专用 patch 并保存；配置变化时要求重新检测，
不无声覆盖。已存在的失效 DSH 成员沿用原 ID 修复，保留身份、MCP、会话和历史。
保存后的连接长期生效，无需每次重新设置。

尚未创建、但此前已手动指定模型或思考强度的旧草稿不会被自动改成检测到的默认连接；
它留在帮助区域并保留原值，通过已有的“手动创建单个伙伴”入口再次确认。这个保护不影响
已存在失效成员的同 ID 修复。

找不到可用路由时，先在 DSH 完成接口和凭据配置后重新检测；需要二次调整时，沿用下面的
原成员编辑器。已检测配置不等于网络、授权或额度已验证，实际请求验证由用户主动触发。

Windows 官方 DSH Desktop 的 `dsh.cmd` 保留 Electron 与 ASAR 入口的启动语义；它不是普通
npm shim，不能把 ASAR 内的 `cli.js` 交给系统 Node。未知自定义 wrapper 仍走手工配置。

## 在原成员设置中二次调整

已在 DSH 配置自定义 `llm-pi-ai` 接口时，可在“设置 → 成员 → 模型与工具”使用
**DSH 自定义 LLM**，无需配置官方供应商或改绑 Host 账号：

1. 成员使用原生工具配置、无单独账号绑定；从已有成员编辑器打开 DSH 自定义 LLM，
   不需要重新创建角色。推荐卡片不展示这个表单。
2. “读取配置来源”默认自动查找已有可用配置，跳过没有凭据的默认路由；例如已配置的
   `desktop` 自定义接口可直接成为确认候选，不必先手工把 `acp` 改为 `desktop`。
   仍可手工选择 profile 并重新读取。页面展示实际来源、ACP 当前选择、可用路由和模型，
   只返回凭据是否配置，不返回密钥；读取不会调用 LLM。
3. 选择目标路由和模型，点击“使用此配置”，再通过成员页面的“保存”应用草稿。
   原来的模型和思考强度覆盖会清除，成员跟随专用 patch 的选择，避免旧强度与新模型不兼容。
4. 可主动点击“发送一次请求验证此配置”。这会产生一次模型 prompt，可能收费并保留
   DSH 测试会话；它不启用 MCP，拒绝向 Host 申请的工具权限。成功只证明收到模型文本，
   保存后的实际聊天、续聊和角色协作仍需各自验证。

新检测到的 DSH 在路由确认前不能直接作为已就绪成员创建；无可读取凭据或没有模型的
路由不能通过“使用此配置”。先在 DSH 原生模型设置中补齐接口和认证，再返回重新读取。
这避免保存后才遇到 `no API key for provider route deepseek-official`；有凭据也不代表
网络、供应商授权和额度已经验证，需要时使用上面的实际请求验证。

旧 DSH 成员如果还使用未确认的默认 ACP 路由，可在原成员编辑器完成同样的确认并
保存配置，沿用原 ID、身份、MCP 设置和历史。其他页面同时改过该成员时会拒绝覆盖，需重新
检测确认。已由 Host 生成并持久保存、路由和凭据仍有效的专用 patch 会继续复用，不要求每次配置。

Clowder 在 Host 持久配置根的 `.cat-cafe/dsh-acp/` 保存专用配置快照，并在原有
`--patch` 之后加载。在明确支持并通过类型校验的范围内，它完整保留所选 provider 的模型元数据和兼容项，以及当前 ACP 的
其他配置和 provider 条目。新路径让已有连接池识别变更，正在运行的回合可正常排空；
旧会话和原生配置不被清空。回退可恢复成员原来的启动参数和模型选择，旧 patch 保留。
源 profile 后续改动不会自动覆盖此快照，需要重新读取、选择和保存。

配置读取在私有临时副本中运行 DSH 的 `--dump-config`，防止诊断重写原生 `cordis.yml`。
Desktop 在部分 CLI 版本中保留给 Electron，因此来源只读解析 profile/home patch 显式保存
的 provider 声明；home 层仍按完整 config 替换。若 ACP profile 尚不存在，读取不会在原生
HOME 初始化它；首次实际连接由 DSH 正常初始化。认证仍从原有 HOME 或继承环境解析，
不迁移凭据文件，不为自定义网关补官方 key，也不会自行猜测或提高模型上下文上限。

自动复制只支持明确的字段及类型，验证通过后完整保留，不静默丢弃不支持的字段：

- `llm-pi-ai` provider：`apiKeyEnv` 凭据引用、`displayName/api/baseURL`、模型及 override、
  已识别的 `compat`、上下文/输出上限、输入类型、思考预算、缓存、transport、timeout/图像预算与重试设置。
  HTTP(S) endpoint 不含 userinfo、query 或 fragment。
- 模型及 override：`id`（仅 models）、`name`、`contextWindow/maxTokens/input/reasoningEfforts/compat`。
  兼容项只允许已识别的布尔开关、协议枚举与数值，自由模板字典不自动复制。
- ACP：`provider/model/sessionListPageSize`；`llm-pi-ai` 插件只复制 `providers`。
  全部保留的 active providers 同样受检，不能因本次未选中而绕过。
- 官方 `llm-deepseek` 使用独立类型约束：凭据引用、无认证参数的 endpoint、思考模式/强度、
  模型元数据、上下文/输出上限、图像与文件预算/时限、重试设置。当前与来源合并后的全部字段都要通过校验。

非空自定义 `headers`、内联 key、未知字段、错误类型、带 query/fragment 的 endpoint
会拒绝整个自动准备，保留原文件并转手动路径；空 `headers: {}` 可以保留。
检查发生在长期 patch 写入之前，错误只返回固定代码，不回传私有字段和值。
自动检测还须确认同一默认原生 local credentials resolver；改过凭据位置、替换/禁用 resolver
或无法验证的文档保持手动接入，不读取未知凭据文件或猜用另一份认证。

复杂补丁、表达式、既无显式模型也无已保存选择的隐式模型、未知启动 wrapper、非绝对 `DSH_HOME`
也不自动迁移，按下文手动配置。仅安装了 Host、尚未在 DSH 配置接口和凭据时，
先完成 DSH 原生配置，再读取复用。此入口只接受直接本机的已登录 owner 操作。

## 1. 确定实际的启动入口和配置根

在启动 Clowder 的同一环境中，检查 `dsh` 实际指向的程序或脚本，以及启动参数中的 `--profile acp`。
Windows 可用 `Get-Command dsh -All` 检查入口。若它是包装脚本，还要确认脚本最终使用的 `DSH_HOME`：
某些本地启动器会重设该变量，仅在外部终端设置它不能证明配置隔离已经生效。

配置按以下顺序加载，后层可覆盖前层：

`bundle → profiles/acp/cordis.patch.yml → $DSH_HOME/cordis.patch.yml → 按参数顺序应用的 --patch 文件`。

找到实际启动参数中的全部 `--patch`，连同共享 home patch 一起检查，再对照 ACP profile 与 Desktop/Web 中可用的 provider。
同一插件后层的完整 `config` 会替换前层配置；因此 profile 已选中目标模型，仍可能被 home 或 overlay 改回旧路由。
共享 home patch 还会影响其他 profile：修正实际生效的覆盖层时，只改必要条目，保留其他 profile 需要的配置，不删除整个共享 patch。
编辑前备份目标 patch；保留已有路由、插件配置、认证和历史。
若使用另一套实验 `DSH_HOME`，通过原生配置方式提供该路由所需凭据，避免复制整份日常认证文件。

## 2. 在 ACP profile 声明路由并选中它

下面展示 patch 中需要的两部分。将 provider、模型、地址和协议替换为**已经在 DSH 验证可用的配置**。
示例是 Chat Completions 网关；使用其他协议时，沿用对应 provider 的 `api` 和兼容选项。

```yaml
- id: llm-pi-ai
  config:
    providers:
      custom-gateway:
        displayName: Custom Gateway
        api: openai-completions
        baseURL: https://gateway.example/v1
        apiKeyEnv: CUSTOM_LLM_API_KEY
        models:
          - id: your-model

- id: acp
  config:
    provider: custom-gateway
    model: your-model
```

将这两部分合并进现有 patch 中对应 `id` 的配置；不要直接覆盖整个文件或追加重复 `id`。
保留该插件原有的其他配置及 `providers` 条目。
从可用 profile 迁入路由时，完整保留它的模型元数据、`compat` 等选项，而不只复制显示名称。
同时检查后续 home/overlay 层是否再次配置 `acp` 或 `llm-pi-ai`，防止选择或 provider 字典被覆盖。

`apiKeyEnv` 是凭据引用名，不是密钥正文。它必须能在**实际 ACP 进程使用的配置根或启动环境**中解析。
例如同一 `DSH_HOME` 已有该引用时，无需另配官方 key；另一配置根中没有它时，仍须通过 DSH 原生方式配置。
不要把密钥写入启动参数、模型 ID 或提交到仓库的 patch。

## 3. 让 Clowder 沿用原生选择

按[ACP 客户端配置指南](acp-client-plugin-user-guide.md)设置 DSH 入口，参数使用 `--profile`、`acp`。
角色使用该 ACP client，模型留空以沿用 DSH 原生默认选择。
若角色已有显式模型覆盖，先移除旧覆盖或从 ACP 广告的模型中选择目标值，避免继续固定到官方模型。
原生客户端管理模型调用认证；无需为此给角色绑定一个无关的 Host 默认模型账号。

配置后使用新 ACP 会话验证，避免旧进程或旧会话的模型选择干扰判断。
`dsh --profile acp` 是 stdio 协议入口；它等待 ACP 请求，不是在终端直接输入自然语言的聊天界面。

## 4. 验证实际路由

先用实际入口及相同的 `--profile`、`--patch` 参数执行 `--dump-config`，核对最终 `acp` 选择和 `llm-pi-ai` 路由声明；
此步骤只组合配置，不调用模型。不要将可能包含私有配置或 `!!js` 表达式的完整输出直接发布或作为脚本执行。
例如 profile 选 `custom-gateway/your-model`、home patch 选官方模型时，最终选择应以 home 层为准；
两个 overlay 都改 `acp` 时，按参数顺序最后应用的 overlay 生效。
再通过 ACP 客户端完成 `initialize → session/new → session/prompt`，并从 Clowder 发起同样的最小请求。
检查以下证据：

1. 新会话的模型选项及当前值指向目标 provider/model。DSH 可能用 JSON 数组字符串表示模型值，
   如 `["custom-gateway","your-model"]`；沿用完整值，不把它当成普通模型名称拆写。
2. 实际请求到达预期网关，使用预期协议路径和模型，并返回正常文本；只看到会话创建成功不足以证明调用成功。
3. 在同一会话中续问，仍使用目标 provider/model，并能读回前一轮内容。

只记录路由、模型、HTTP 状态和必要响应摘要；不要记录认证头、密钥或完整私有会话。
将验证结果连同 DSH/Host 版本、调用入口及尚未覆盖的场景保留在问题报告或 PR 验证说明中。
一次具体网关调用成功，不代表其他模型、协议或重启恢复均已通过验证。

## 5. 根据偏差选择处理位置

| 观察 | 下一步 |
| --- | --- |
| ACP 仍广告或选择官方 provider | 核对真实配置根，以及 bundle、profile、共享 home 和全部 `--patch` 的加载顺序；修正实际生效的覆盖层 |
| profile 中声明的目标路由在最终配置中消失 | 检查 home/overlay 是否用完整 `llm-pi-ai.config` 替换了 profile 的 provider 字典，合并所需条目并保留共享配置 |
| ACP 选择自定义 provider，但缺对应引用 | 在该原生配置根或进程环境中提供目标引用，不用官方 key 替代 |
| 原生 ACP 成功，Clowder 选择不同模型 | 检查角色模型覆盖、client 启动参数和当前会话回执，再定位 Host 的具体偏差 |
| 路由正确，出现协议或接口错误 | 核对 DSH provider 的 `api`、`baseURL`、模型和兼容选项；必要时向 DSH 上游报告 |

Windows 若在启动子进程前报 bootstrap 目录 ACL 不安全，按现有指南配置独立的安全目录；
它属于进程启动隔离检查，不能作为自定义 LLM 鉴权失败的证据。

配置回退只恢复本次实际修改的 profile/home/overlay patch 及角色模型选择；不清空凭据或历史。
若在原生 ACP 与 Clowder 中均成功，配置修复即可闭合该调用问题，无需新增通用凭据状态或派发机制。

上游依据：[DSH ACP 默认配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/acp-app/cordis.patch.yml)、
[自定义 provider 配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-pi-ai/README.md)、
[配置层加载顺序](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile-context.ts#L74-L80)。
