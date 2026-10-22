---
feature_ids: [F241]
topics: [acp, plugins, mcp, client-onboarding, verification]
doc_kind: user-guide
created: 2026-10-22
tips_exempt: "本地候选实验手册，通过 Host 安装指南和插件说明发现；尚未公开发布。"
---

# 文档二：为新的 agent client 找到配置并验证 ACP 能力

先按[文档一](acp-client-plugin-user-guide.md)启动本机隔离 Host。本文帮助你回答：
“这个新客户端该填什么，哪些能力实际能在 Clowder 里使用？”

## 1. 先确定接入的是哪一端

本文沿用用户习惯叫“agent client”；从协议角色看，**Clowder 是 ACP Client，新程序必须提供 ACP Agent 入口**。
一个软件只是能连接别人的 ACP Agent，或者只是 MCP client/server，不代表它能被本插件启动。

当前候选 Host 的适用范围来自本地 `AcpClient.ts` 和 `plugin-agent-provider.ts`：

| 项目 | 当前要求 / 边界 |
| --- | --- |
| Host 到新程序 | 启动本地子进程，通过 stdin/stdout 交换换行分隔的 JSON-RPC |
| 协议版本 | Host 发 `initialize`、`protocolVersion: 1`，使用 v1 字段；新程序须兼容这一交互 |
| 最少对话能力 | `session/new`、`session/prompt`、`session/update`；正常完成与错误能被 Host 识别 |
| 团队协作 | 新程序实际连接 Host 在会话参数中传入的 `mcpServers`，模型能调用其中工具 |
| 跨进程续接 | 声明并实现 `loadSession` 或当前 Host 识别的 `sessionCapabilities.resume` |
| 额外能力 | 图片、模式/模型选择、HTTP/SSE MCP 等要分别声明、分别验证 |

目前目录表单不能直接填一个 ACP HTTP/WS URL，也没有每 client 的 `env`、`cwd`、超时或能力开关字段。
如果新程序只有远程 ACP 服务、私有 RPC、普通 TUI，需已有兼容桥，或另做适配；改 ID/命令不会转换协议。
新版 ACP 文档可能默认展示 v2，其初始化字段和会话语义与这里不同，不能直接套用。
参考 [ACP v1 初始化](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/initialization.mdx)
和 [v2 迁移说明](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx)。

## 2. 到哪里找需要填写的信息

按以下顺序查新客户端自己的官方文档和实际安装：

1. 找官方 “ACP / IDE integration / headless / stdio” 章节，确认它提供的是 Agent 入口。
2. 查准确安装包、版本、命令和 ACP 子命令/参数；有时要另外安装桥。
3. 查登录、模型配置、HOME/状态目录、必要环境变量；确认能在非交互进程中启动。
4. 在本机核对命令解析到哪个文件，再看对应版本的 `--help` 和发布说明。
5. 把实际命令拆成“可执行程序 + argv 数组”，填入插件，最后做第 4～6 节验证。

PowerShell 发现入口示例（把 `newagent` 换成实际命令）：

```powershell
Get-Command newagent -All | Select-Object CommandType,Name,Source,Definition
where.exe newagent
newagent --version
newagent --help
npm root -g
```

`--version` / `--help` 只是常见约定，实际以该客户端文档为准。
如果有多个结果，记录你选择的绝对路径；不要以为另一个终端能运行，就说明 Host 的 PATH 一样。
遇到 `.cmd` / `.ps1` 启动器，可用 `Get-Content -LiteralPath '<实际路径>'` 查看它是否重设 HOME、固定 profile 或额外注入参数。
不要公开包含密钥的启动器内容。npm 包的 `package.json` 中 `bin` 字段可帮助定位真实脚本。

每个新客户端先填这张“入口卡”：

| 信息 | 你的记录 |
| --- | --- |
| 官方文档 / 发布版本 | URL、客户端版本、桥版本 |
| Agent 入口 | 原生提供 / 另装桥；准确启动方法 |
| 命令绝对路径 | exe、cmd，或解释器路径 |
| 参数数组 | 保留各项边界，例如 `["acp","--stdio"]` |
| 登录与模型 | 原生登录命令、模型默认值来源；不记录密钥值 |
| 实际状态根 | HOME、客户端专用目录；会话 / SQLite 是否与日常客户端共用 |
| ACP 版本 | 是否能与当前 Host 的 v1 交互 |
| MCP / 续接说明 | 支持传入服务器、load/resume 的官方依据，未找到写“待验证” |

## 3. 把启动命令转换成插件配置

例如官方要求运行 `newagent acp --stdio`：

| 插件字段 | 填写示例 |
| --- | --- |
| 名称 | 新客户端实验 |
| 固定 ID | `newagent-lab` |
| 可执行文件或命令 | `C:/Tools/NewAgent/newagent.exe` |
| 启动参数 | 第一行 `acp`，第二行 `--stdio` |

如果官方入口是 `node C:/Tools/NewAgent/adapter.mjs --stdio`：命令填 Node 的绝对路径，
参数第一行填 `C:/Tools/NewAgent/adapter.mjs`，第二行填 `--stdio`。
命令字段不填整条命令；参数区不额外添加外层引号。路径中的空格由 Host 按参数边界处理。
未知的 `--acp`、`--stdio` 不能猜着加；有的程序不需要参数，有的使用 `acp` 子命令。

固定 ID 使用小写字母/数字起始，后续可包含点、短横线、下划线，总长最多 64；ID 不重复，最多 32 个 client。
角色绑定后可修改显示名称，保留 ID。程序和桥位于目录插件之外；不把待执行脚本放进目录插件包。
用户配置只改插件表单，无需修改 `agent-provider.json`、环境绑定变量或 Host 代码。

插件内部等价数据如下，仅用于核对，不需要在正常表单中手写：

```json
{
  "id": "newagent-lab",
  "name": "新客户端实验",
  "command": "C:/Tools/NewAgent/newagent.exe",
  "startupArgs": ["acp", "--stdio"]
}
```

必要环境变量不塞进上述 JSON。先用原生登录配置；确需启动变量时，在本机私有
`lab-env.ps1` 中添加变量并重启 API。
它们进入本实验 Host 的子进程环境，并非只对这一个 client 生效；保留已有隔离目录设置，不提交认证配置。
更改客户端状态根前先确认会话、索引、SQLite 的实际归属。优先在实验 HOME 登录，不把日常历史默认当作隔离历史。

## 4. 可选：先做一次不发送对话的握手检查

使用 Host 自己的 ACP Client，而不是把一行 JSON 管道输入后立即关 stdin。
下面只发送 `initialize`，不发 `session/new` / `session/prompt`，也不接入 MCP。
它只验证入口与握手；不能证明模型、工具或团队协作可用。
若需要实验 HOME，先在独立 PowerShell 窗口按文档一加载实验环境，再执行：

```powershell
$env:ACP_PROBE_COMMAND = 'C:/Tools/NewAgent/newagent.exe'
$env:ACP_PROBE_ARGS = ConvertTo-Json -InputObject @('acp','--stdio') -Compress
$env:ACP_PROBE_CWD = 'C:/clowder-labs/acp-client/workspaces'
$env:ACP_PROBE_HOST_ROOT = 'C:/src/clowder-ai-acp'
$ProbeSource = @'
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const entry = resolve(process.env.ACP_PROBE_HOST_ROOT, 'packages/api/dist/domains/cats/services/agents/providers/acp/AcpClient.js');
const { AcpClient } = await import(pathToFileURL(entry).href);
const client = new AcpClient({
  command: process.env.ACP_PROBE_COMMAND,
  args: JSON.parse(process.env.ACP_PROBE_ARGS),
  cwd: process.env.ACP_PROBE_CWD,
  env: { ...process.env },
});
try {
  const initialized = await client.initialize();
  console.log(JSON.stringify(initialized, null, 2));
  if (initialized.protocolVersion !== 1) {
    throw new Error('该程序未协商 ACP v1，不能据此判定兼容当前 Host');
  }
} finally {
  await client.close();
}
'@
$ProbeSource | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw '握手未通过，请检查程序入口和协议版本' }
```

运行前替换前四行，空参数使用 `ConvertTo-Json -InputObject @() -Compress`。
若缺少 `dist/AcpClient.js`，先按文档一构建 API。这个探测会启动、关闭你指定的程序，不停止其他程序。
输出包含 Host 日志和格式化初始化结果；下面的 stdout 协议要求指被启动的 Agent 进程。
连接超时、TUI/banner 而无初始化响应、返回 v2，均不能算通过；stdout 应承载协议，诊断应写 stderr。

读取 v1 响应时重点看：

| 字段 | 能说明什么 / 不能说明什么 |
| --- | --- |
| `protocolVersion: 1` | 版本对上；仍需实际会话验证 |
| `agentInfo` | 返回的名称和版本；核对是否启动了预期的桥 |
| `authMethods` | 声明认证方式；不等于已登录或模型可用 |
| `agentCapabilities.loadSession` | 声明可 load；跨进程恢复要实测 |
| `agentCapabilities.sessionCapabilities.resume` | 当前 Host 可选择的另一条续接路径；不要求它与 load 同时存在 |
| `agentCapabilities.promptCapabilities` | 图片、音频等声明；不自动证明 Host、模型和桥三方都能使用 |
| `agentCapabilities.mcpCapabilities.http/sse` | Agent 连接 MCP 的可选传输；不是 Host 连接这个程序的传输 |

在本 Host 的 **v1** 路径中，stdio MCP 不靠 `mcpCapabilities.stdio` 开关表示，`mcpCapabilities: {}` 也不能直接判为无 MCP。
但声明符合规范仍不能证明真的透传：原 pi-acp 0.0.34 就接收了 MCP 参数却未接到原生 Pi。
必须继续做真实工具调用。[v1 会话与 MCP 参数说明](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)。

## 5. 先在 Clowder 完成基础与 MCP 验证

创建一个新实验目录，避免把已有文件内容当成本次工具结果：

```powershell
$TaskRoot = 'C:/clowder-labs/acp-client'
$CaseRoot = Join-Path "$TaskRoot/workspaces" ('newclient-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $CaseRoot -ErrorAction Stop
[IO.File]::WriteAllText((Join-Path $CaseRoot 'probe.txt'),
  ('ACP_NEWCLIENT_' + [guid]::NewGuid().ToString('N')), [Text.UTF8Encoding]::new($false))
$CaseRoot
```

在插件点击“添加 自定义”，保存第 3 节配置并启用。创建实验角色，例如唤醒名 `@新客户端实验`，
选择该 client，模型先跟随客户端，开启 MCP。确认 MCP 管理中的协作服务允许这个角色。
创建项目聊天并选择打印出的 `$CaseRoot` 作为项目目录，指定该角色；**以下提示中的路径替换成实际值**。

| 检查 | 可发送的任务 | 通过依据 |
| --- | --- | --- |
| 基础回复 | `@新客户端实验 回复 BASIC_OK，记住口令 GREEN_42。` | 真实完成回复，不是仅入队 |
| 文件工具成功 | `@新客户端实验 实际用工具读取 <CaseRoot>/probe.txt，原样回复内容。` | 工具轨迹成功，内容与本地文件一致 |
| 工具失败 | `@新客户端实验 实际读取 <CaseRoot>/missing-<随机值>.txt。不存在时如实说明。` | 工具结果显示失败，不能把不存在包装为成功 |
| 同会话第二轮 | `@新客户端实验 上一轮口令是什么？` | 正确回复，并检查仍是同一原生 session |
| MCP 读取 | `@新客户端实验 实际调用 cat_cafe_get_thread_context 读取当前聊天（limit=3），说明读到哪条任务。` | MCP 工具结果成功，返回当前聊天的内容 |
| MCP 写入 | `@新客户端实验 用 cat_cafe_post_message 发布 NEWCLIENT_MCP_OK，不填 targetCats、不 @其他角色。` | 工具返回成功，并出现该角色发出的持久消息 |

只会聊天或读本机文件，不代表支持 Clowder MCP。工具名可能带不同的 `mcp__…` 前缀，核对实际工具和结果。
如发生授权请求，按正常权限流程处理；被拒绝的操作应如实停止，不能靠关闭安全控制制造“通过”。

## 6. 验证团队协作、取消、重启与恢复

### 6.1 一次单向协作

在同一聊天准备一个已经验证可用的角色，记录其**真实成员 ID**，例如成员配置中选中的 DSH/Claude/pi 实验角色。
向新角色发：

> @新客户端实验 请先实际调用 cat_cafe_get_thread_context，然后用 cat_cafe_post_message 给目标角色发送单向验收任务。targetCats 使用它的真实成员 ID；内容为“请实际读取当前聊天，再发布不带 targetCats、不含 @ 的 NEWCLIENT_PEER_OK 消息，完成后停止”。你发送成功后只回复 SENT，不再 @任何角色。

实际发送时，把“目标角色 / 真实成员 ID”替换为你从成员设置核对的值，不复制本轮旧 ID 到别的环境。
若不方便取得 ID，可让新角色先查询当前成员，再选择目标；或使用工具支持的行首唤醒名路由。
通过依据是：新角色 MCP 返回 `routed` 目标正确、对方被唤醒且实际调用工具、对方回执持久化、链路停止。
`routed` / “已投递”只证明发出，不能代替接收方实际执行。不要在 MCP 发出后又在最终文本重复 @，避免重复派活。

### 6.2 取消一次正在执行的工具

让新角色在实验目录用终端运行 `node -e "setTimeout(()=>console.log('CANCEL_TOO_LATE'),30000)"`。
看到工具开始后点停止；确认任务为已取消、没有继续发布成功完成结果，并能正常接收下一条任务。
客户端没有终端工具时，用它支持的可中断测试工具替代，记录替代场景；未做不能标为通过。

### 6.3 API 重启后恢复同一个原生会话

先等所有任务完成，记下聊天 ID、角色 ID、原生 session ID。原生 ID 可在回复轨迹/会话详情或 API 日志中核对，不能拿聊天 ID 替代。
按文档一只重启 API，重新探活，回到**原聊天、原角色**发送：

> @新客户端实验 请说出 GREEN_42，再实际调用 cat_cafe_get_thread_context，最后用 cat_cafe_post_message 发布 NEWCLIENT_RESUMED_OK，不叫其他角色。

应同时满足：原生 session ID 未变、上下文延续、两次 MCP 调用成功、新回执持久化。
仅复述口令不够，Host 也可能注入历史。没有 load/resume 声明或实际恢复失败时，只能标为基础会话可用，不能承诺跨进程续接。
不在角色/插件表单里复制旧回调 token，恢复后的当前凭证由 Host 提供。

### 6.4 插件停启

任务全部结束后停用目录插件，再给绑定角色发一句测试消息，应明确显示 client 不可用；不能偷偷回落到其他客户端。
重新启用后再验证一次回复。此插件包含的其他 client 也会受停用影响，不在其他角色工作中操作。
不通过删除原生历史、重置 Redis 或卸载全部客户端来排错。

## 7. 怎样给出最终结论

| 结果 | 可以声明的范围 |
| --- | --- |
| 仅表单保存成功 | 配置已保存，连接待验证 |
| 握手成功 | ACP v1 入口可连接，模型/工具未验证 |
| 回复与文件工具成功 | 基础角色可用，团队协作待验证 |
| MCP 读写及真实接力成功 | 当前版本、当前场景支持 Clowder 角色协作 |
| 重启后同原生 ID + MCP 成功 | 该版本的跨进程续接也通过 |
| 某项未测 / 声明缺失 / 失败 | 写明未测或限制，不能推导成全部 ACP 能力已支持 |

为每个新 client 保存一份记录，建议放在本机实验 artifacts 下，不记录密钥或回调 token：

```text
日期 / 操作人：
Host 分支 + HEAD + 本地改动标识：
目录插件版本 / 包 SHA-256：
客户端、桥版本 / 官方入口依据：
实际 command / startupArgs：
配置 ID / 角色 ID / threadId：
工作目录 / 实际原生状态根：
initialize protocolVersion / agentCapabilities：
基础 / 成功工具 / 失败工具 / 第二轮：PASS / FAIL / 未测
MCP 读 / MCP 写 / 对方真实执行：PASS / FAIL / 未测
取消 / API 重启同原生 ID / 重启后 MCP / 插件停启：PASS / FAIL / 未测
重启前后原生 session ID：
消息、工具回执、截图、日志位置：
已知限制 / 失败原因 / 下一步：
停止情况 / 数据保留位置：
```

## 8. 失败时优先查哪一层

| 现象 | 优先核对 |
| --- | --- |
| ENOENT / 找不到程序 | 绝对路径、解释器、PATH、桥是否安装 |
| 普通终端能用、Host 登录失败 | 实际 Windows 用户、实验 HOME、专用状态根、启动变量 |
| stdout 是 TUI/横幅、握手超时 | 是否用了正确 ACP Agent 入口、stdout 是否污染协议 |
| 返回 v2 或私有 RPC 字段 | 协议版本/桥兼容性，不能用配置伪装支持 |
| 能回复，没有 Clowder 工具 | 成员 MCP 开关、协作服务授权、桥是否消费并转发会话 `mcpServers` |
| 工具执行失败却显示成功 | 客户端/桥的错误和状态映射；保留原始结果作为适配证据 |
| MCP 401 / 重启后失效 | 当前会话凭证是否刷新、是否被静态 MCP 配置覆盖；不手填旧 token |
| 投递成功但对方没有执行 | 目标 ID、投递/唤醒状态、接收方实际运行与回复，分层判断 |
| 重启后新建了不同原生会话 | 恢复能力、状态根、工作目录、load/resume 行为 |

本轮已有 dsh、Claude、pi 的 Windows stdio 实证，范围见对应 PR 的验证说明。
原始日志保留在作者本机，未随源码发布。
它们通过不代表任意新客户端自动通过；新客户端的能力记录才是最终依据。

## 9. Windows 新客户端的目录与恢复验收

先按[文档一的目录操作](acp-client-plugin-user-guide.md#windows怎样找到安全引导目录)执行「检查引导目录」，再验证 ACP。
自定义客户端 JSON 可以包含可选 `bootstrapRoot` 绝对路径；省略表示自动寻找，不能附带 `allowVolumeRootDelete`、trusted SID 或跳过校验字段。
CodeAgent 示例：`command: "codeagent"`，`startupArgs: ["--acp"]`；bypass 参数仍使用客户端实际支持的 argv，不影响 Host 的目录安全校验。
普通 stdin/stdout NDJSON 也不保证版本、认证、恢复和 MCP 全部兼容，继续执行本文各项检查。

- 记录实际通过的 root、运行 API 的账户、客户端启动 cwd 和会话项目 cwd；不要把目录检查成功写成 ACP 握手成功。
- 在独立测试项目制造可恢复失败（例如专用父目录尚未创建），确认消息显示失败且客户端未启动；补齐合格条件后，同一配置再次发送应成功。
- 验证并发首调不重复创建客户端、失败后可重试、正常服务可复用；重启后再次核对原生 session ID 和 MCP 凭证。
- 保留危险祖先、已有私有目录被破坏、junction/SUBST 和不支持 ACL 的拒绝证据；不要改系统盘 ACL 来让测试变绿。
- 所有候选均拒绝时记录为「无安全存储位置」，请管理员提供合格位置；这与 ACP 协议不兼容是两类结论。

上述“危险祖先拒绝”指默认 strict。已认可祖先替换风险的内网部署可一次持久设置[分离的 B/C 策略](./acp-trusted-host-compatibility.md)，无需每次启动 export；trusted-host 接受祖先风险，但自身私有权限和链接拒绝仍须验证。审计例外只限已有 client 的真实引导目录变化，不覆盖新 client 的首次添加或命令变更。
