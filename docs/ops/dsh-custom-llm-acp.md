---
feature_ids: [F241]
topics: [acp, dsh, custom-provider, troubleshooting]
doc_kind: user-guide
created: 2026-10-22
---

# DSH ACP 使用自定义 LLM

适用情形：DSH Desktop/Web 的自定义模型能够使用，但从 Clowder 启动 DSH ACP 时，
却要求 `deepseek-official` 的 API key。先检查 ACP 实际选中的 provider，
不要因此给自定义接口补配官方 DeepSeek key。

本文对应 DSH 源码 `687f282e8625c6b8d11ff58211a90524be2e4317`（包版本 `0.2.1-rc.2`）。
该版本的 ACP bundle 默认选择 `deepseek-official / deepseek-v4-flash`；
Desktop、Web 和 ACP 各自的 profile 配置不会自动相互复制；home 层配置则由这些 profile 共享。
同一 `DSH_HOME` 的凭据引用可被这些 profile 使用，但有凭据并不等于 ACP 已配置并选中对应路由。

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
