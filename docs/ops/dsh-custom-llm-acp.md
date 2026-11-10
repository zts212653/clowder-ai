---
feature_ids: [F241]
topics: [acp, dsh, custom-provider, troubleshooting]
doc_kind: user-guide
created: 2026-10-22
tips_exempt: "DSH 成员配置入口直接提供复用步骤与主动验证费用提示，无需额外弹出提示。"
---

# DSH Desktop 接入与模型验证

一键检测和添加 DSH 成员使用 **DSH Desktop** 的配置。无需区分 desktop、web 或 acp，
也不需要另装 npm CLI、修改 PATH 或修复一份没有使用的原生 ACP profile。
当前已实测 Windows Desktop 0.2.2-rc.1；自定义源码 wrapper 不作为自动发现入口。
已有手工成员保持原配置，不会被发现操作自动迁移。

## 一键添加或成员设置

1. 一键添加页打开 DSH 的“配置与验证”，或在成员设置中选择 DSH Desktop。
2. 点击“读取 Desktop 配置”。读取不调用模型，也不会登录、迁移或改写原凭据文件。
3. 确认供应商路线和模型，点击“验证并使用此模型”。这会发送一次请求，可能产生费用，
   并在专用运行目录保留测试会话。请求成功后才把配置加入成员草稿。
4. 勾选伙伴并创建，或保存成员。未验证的 DSH 无法从一键添加页提交。

确认新的 Desktop 连接会替换该成员的启动参数、模型与运行环境绑定，使保存后使用的配置与
探针一致。未选择并保存新连接的现有成员保持原样；原生 Desktop 配置和认证不会被替换。

默认选择依据 DSH 的原生认证解析结果：官方认证已配置时默认官方；确实缺少官方认证时，
使用该 Desktop 已有的自定义配置。原生凭据库中存在官方 key 时，即使终端没有对应环境变量，
也不会误判缺失。多条路线需要选择时，页面展示实际供应商及模型；已有显式模型偏好保留。
显式指定的凭据引用缺失会提示补齐，不会借另一家的 key，更不会把自定义 key 填给官方供应商。
认证已配置只证明有认证材料；收到真实模型回复才表示本次验证通过。

验证绑定启动命令、参数、运行 HOME、模型和思考强度。修改这些内容后需要重新验证。
扫描工具、读取模型清单不会隐式发送 prompt。验证结果不承诺网络、额度或服务持续可用。
安装了多套 Desktop 时，优先匹配正在运行的官方 Host；无法唯一确定时，在工具列表确认安装位置。

## 配置、认证与历史保留

Clowder 读取 Desktop 的实际 HOME 和环境来源，为成员创建稳定的专用 ACP 运行 HOME，
位于 Host 持久配置根的 .cat-cafe/dsh-desktop/。该运行目录与所选 Desktop 的原生 HOME 分开，
不会加载原生 ACP 的坏 patch，也不会改写原 Desktop、认证或历史。
原生 ACP patch 只有注释、解析为 null 时，不需要用户先为自动接入修复它。

专用配置只保存所选路线、模型元数据及来源路径，不复制密钥正文。
只读凭据插件复用 Desktop 随包解析器读取原生引用和认证记录；旧 flat 凭据格式仅在内存解析，
不会迁移原文件。认证按原生的 stored → process → project .env → HOME .env 顺序解析，
保留空值的遮蔽规则。每次启动重新载入原环境来源，运行中的引用及记录从原凭据文件读取。
需要登录或刷新 OAuth 时，请回到 Desktop 更新认证，再验证；Clowder 不执行刷新回调后丢弃令牌，
也不因认证失败静默切换供应商。

源模型配置后续变化不会自动覆盖已准备的路线快照，需要重新读取、验证和保存。
改变路线会生成新的运行目录；旧目录和会话保留。相同配置保存后的重启继续使用同一 HOME。
回退时可恢复成员原来的启动参数、模型和运行目录绑定，保留现有目录以便恢复。

自动复用支持已识别的 provider/model 字段、凭据引用和兼容选项。
表达式、内联密钥、非空自定义 headers 或无法保真复制的字段会明确拒绝，原配置保持原样。
凭据文件无法解析或无读取权限会作为读取失败报告，不会当作“缺 key”继续猜测供应商。
此入口只接受直接本机的已登录 owner 操作。

## 已有手工 ACP 接入的排查

以下步骤面向既有手工 CLI/profile 配置，依据 DSH 源码 687f282e（0.2.1-rc.2）。
自动 Desktop 接入不需要执行这些步骤。该版本 ACP bundle 的默认模型是
deepseek-official / deepseek-v4-flash；Desktop、Web 与 ACP 的 profile 不会自动互相复制。

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
| ACP 选择自定义 provider，但缺对应引用 | 报 `credential_missing`；按第 6 节定位实际配置根并补齐引用，不用官方 key 替代 |
| 原生 ACP 成功，Clowder 选择不同模型 | 检查角色模型覆盖、client 启动参数和当前会话回执，再定位 Host 的具体偏差 |
| 路由正确，出现协议或接口错误 | 核对 DSH provider 的 `api`、`baseURL`、模型和兼容选项；必要时向 DSH 上游报告 |

Windows 若在启动子进程前报 bootstrap 目录 ACL 不安全，按现有指南配置独立的安全目录；
它属于进程启动隔离检查，不能作为自定义 LLM 鉴权失败的证据。

## 6. 读到 `credential_missing` 时怎么处理

Clowder 在 ACP 返回的明确缺凭据错误上会给出 `credential_missing`，而不是通用的 `prompt_failure`。
它的含义是：**路由已经解析成功，但该路由声明的凭据引用，在原生凭据服务与启动环境中都未能解析到值。**

报文形态（脱敏）：

```text
credential_missing: DSH 未能解析当前路由所需的凭据引用。
⚠️ ACP agent 当前选定路由「custom-acp-route」缺少凭据：原生配置声明的引用名称「CUSTOM_ACP_API_KEY」，在原生凭据服务与启动环境中都未能解析到值。
```

注意区分两点：

- `「CUSTOM_ACP_API_KEY」` 是**引用名称**，不是密钥正文。DSH 按名称精确查找，
  不会因为两个名字都含 `CUSTOM` 就共用同一把密钥。
- 这只是**本地解析失败**：请求尚未发到网关，所以网关侧通常看不到任何记录。

恢复顺序：

1. 确认**实际生效的入口**：自定义 wrapper 可能自己设置 `DSH_HOME`，
  不要假定 Host 默认的 `~/.dsh` 就是真实配置根。
2. 在该配置根下核对 profile 与全部 `--patch` overlay，找到最终生效的 provider 及其 `apiKeyEnv`。
3. 二选一：在 DSH 原生配置中登记这个引用名对应的密钥；或**在确认账户归属后**，
   显式把路由的引用改指向你已经保存的另一个名称。后者是用户决定，不是系统行为。
4. 改动后用第 4 节的 `--dump-config` 与一次最小真实请求复验。

系统不会自动改用其他密钥、不会按相似名称猜测关联、也不会替你修改原生配置或凭据文件。
用 `credential_missing` 作为线索检索时，它同时也是结构化的 `errorCode`，便于在日志与测试中稳定匹配。

配置回退只恢复本次实际修改的 profile/home/overlay patch 及角色模型选择；不清空凭据或历史。
若在原生 ACP 与 Clowder 中均成功，配置修复即可闭合该调用问题，无需新增通用凭据状态或派发机制。

上游依据：[DSH ACP 默认配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/acp-app/cordis.patch.yml)、
[自定义 provider 配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-pi-ai/README.md)、
[配置层加载顺序](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile-context.ts#L74-L80)。
