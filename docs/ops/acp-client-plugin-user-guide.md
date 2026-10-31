---
feature_ids: [F241]
topics: [acp, plugins, mcp, members]
doc_kind: user-guide
created: 2026-10-22
tips_exempt: "本地候选阶段，插件详情内已提供安装配置和协作操作说明；未进入公共插件目录。"
---

# 文档一：启动 Host、安装 ACP 插件并配置角色

用户得到的是一个可复用的客户端目录：先配置一次本机启动入口，以后创建角色只需选择该入口。
角色在 Clowder 聊天中回复、调用工具、向其他角色交接；模型调用和认证由本机客户端处理。
本文给出 Windows 源码实验流程；新增 client 的入口发现和逐项验收见[文档二](acp-client-onboarding-and-verification.md)。

## 当前交付边界

需要包含本次客户端目录扩展的 Host，原 PR #1665 基线和旧安装版没有这些入口。
插件仓同时提供目录插件 `@clowder-ai/acp-clients@0.1.0-beta.2` 和独立执行桥
`@clowder-ai/pi-acp@0.1.0-beta.1`。以下从源码打包，不假定这两个候选版本已发布 npm。
目录插件不负责下载客户端、登录账号或安装执行桥。

## 1. 从源码启动隔离 Host

下面的路径是示例，请替换为自己的 feature worktree 和实验目录。
不要在生产安装目录操作；生产端口 `3003/3004/6399` 不参与实验。
已有本机验收环境应复用其原启动配置和台账，不重新初始化或覆盖数据。

### 1.1 依赖与构建

```powershell
$HostRoot = 'C:/src/clowder-ai-acp'
$PluginRoot = 'C:/src/clowder-ai-plugins-acp'
$TaskRoot = 'C:/clowder-labs/acp-client'
node --version
pnpm --version
Get-NetTCPConnection -State Listen -LocalPort 4311,4312,4314,6398 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess
Set-Location $HostRoot
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/finance build
pnpm --filter @cat-cafe/mcp-server build
pnpm --filter @cat-cafe/api build
```

Host 要求 Node **24+**；仓库声明 `pnpm@9.15.4`，本轮定向验收使用 pnpm 11.28.5。
每一步失败先处理错误，再执行后一步。端口被占用时先核对所属实例，不结束不明进程。

### 1.2 仅首次创建实验目录

这一步只适用于全新的 `$TaskRoot`。已有目录应加载原配置，不复制执行初始化。

```powershell
if (Test-Path $TaskRoot) { throw '实验目录已存在；复用原配置或选择新的目录' }
@('project/.cat-cafe','home/.claude','home/.pi/agent','home/.dsh','data/redis','logs','packages','workspaces') |
  ForEach-Object { New-Item -ItemType Directory -Path "$TaskRoot/$_" -Force | Out-Null }
$Template = '{"version":2,"memberInitialization":"owner-managed","breeds":[],"roster":{},"reviewPolicy":{"requireDifferentFamily":true,"preferActiveInThread":true,"preferLead":true,"excludeUnavailable":true}}'
[IO.File]::WriteAllText("$TaskRoot/project/cat-template.json", $Template, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$TaskRoot/project/.cat-cafe/capabilities.json", '{"version":2,"capabilities":[]}', [Text.UTF8Encoding]::new($false))
```

把下面内容保存为 `$TaskRoot/lab-env.ps1`，修改前两行路径。
它仅设置当前终端的进程环境，不写系统环境变量。每个服务终端都先点加载同一份文件。

```powershell
$HostRoot = 'C:/src/clowder-ai-acp'
$TaskRoot = 'C:/clowder-labs/acp-client'
$LabEnv = @{
  HOME = "$TaskRoot/home"; USERPROFILE = "$TaskRoot/home"
  CAT_CAFE_CONFIG_ROOT = "$TaskRoot/project"; CAT_CAFE_GLOBAL_CONFIG_ROOT = "$TaskRoot/project"
  CAT_TEMPLATE_PATH = "$TaskRoot/project/cat-template.json"
  CAT_CAFE_HOME = "$TaskRoot/data"; CAT_CAFE_DATA_DIR = "$TaskRoot/data"
  CAT_CAFE_RUNTIME_ROOT = $HostRoot; CAT_CAFE_WORKSPACE_ROOT = "$TaskRoot/project"
  REDIS_URL = 'redis://127.0.0.1:6398'; REDIS_KEY_PREFIX = 'acp-client-lab:'
  API_SERVER_HOST = '127.0.0.1'; API_SERVER_PORT = '4312'; FRONTEND_PORT = '4311'
  NEXT_PUBLIC_API_URL = 'http://127.0.0.1:4312'; CAT_CAFE_FRONTEND_ORIGIN = 'http://127.0.0.1:4311'
  CAT_CAFE_USER_ID = 'acp-lab-owner'; DEFAULT_OWNER_USER_ID = 'acp-lab-owner'
  CAT_CAFE_SESSION_COOKIE_NAME = 'acp-client-lab-session'; CAT_CAFE_AGENT_SESSION_CONTRACT = 'plugin'
  DSH_HOME = "$TaskRoot/home/.dsh"; CLAUDE_CONFIG_DIR = "$TaskRoot/home/.claude"
  PI_CODING_AGENT_DIR = "$TaskRoot/home/.pi/agent"; PI_ACP_DIR = "$TaskRoot/home/.pi/pi-acp"
  CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1'; CAT_CAFE_DISABLE_WORKTREE_ORPHAN_CLEANUP = '1'
  CAT_CAFE_SKIP_A2A_TIMEOUT_SCAN = '1'; NEXT_TELEMETRY_DISABLED = '1'; NODE_ENV = 'development'
}
foreach ($Name in $LabEnv.Keys) {
  [Environment]::SetEnvironmentVariable($Name, [string]$LabEnv[$Name], 'Process')
}
Remove-Item Env:CAT_CAFE_DEPLOYMENT_ID -ErrorAction SilentlyContinue
Remove-Item Env:CAT_CAFE_AGENT_SESSION_BINDINGS -ErrorAction SilentlyContinue
```

原生客户端可能另有自己的目录规则或启动器强制 HOME。先按文档二核对实际状态根，
在实验 HOME 完成原生登录，不把日常会话目录默认当作已隔离。凭据和实验数据均不提交 Git。

### 1.3 在三个独立终端前台启动

以下入口直接运行当前源码，不经过生产 runtime 同步脚本。
Redis 可使用独立安装的 Windows 版本；替换真实绝对路径，不连接生产 6399。

终端一：

```powershell
. 'C:/clowder-labs/acp-client/lab-env.ps1'
& 'C:/Tools/Redis/redis-server.exe' --port 6398 --bind 127.0.0.1 --dir "$TaskRoot/data/redis" --appendonly yes --save '60 1'
```

终端二：

```powershell
. 'C:/clowder-labs/acp-client/lab-env.ps1'
Set-Location "$HostRoot/packages/api"
node --import tsx src/index.ts
```

终端三：

```powershell
. 'C:/clowder-labs/acp-client/lab-env.ps1'
Set-Location "$HostRoot/packages/web"
node scripts/sync-vendor-assets.mjs
if ($LASTEXITCODE -ne 0) { throw 'Web 静态资源同步失败' }
node node_modules/next/dist/bin/next dev --port 4311 --hostname 127.0.0.1
```

在第四个终端探活：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4312/health'
(Invoke-WebRequest 'http://127.0.0.1:4311' -UseBasicParsing).StatusCode
```

分别应为 `status: ok` 和 HTTP `200`。浏览器打开 `http://127.0.0.1:4311`。
记录源码 HEAD、实际工作目录、数据根、原生 HOME、各服务 PID/端口、开始和停止时间。
失败时先查看对应服务终端；需要日志时保存到 `$TaskRoot/logs`，对外分享前去除凭据。

重启 API：等待任务结束，在终端二 `Ctrl+C`，确认 4312 释放后用同一环境和命令重启。
结束实验：先停止 API 和 Web，再对已核验归属的 6398 执行 `redis-cli -p 6398 SHUTDOWN SAVE`。
回读进程树和端口，记录遗留项；保留实验 HOME、认证、角色、消息和 Redis 文件。
不要按 node/Electron/Redis 通用名称批量终止，也不要使用 flush/reset 清理。

## 2. 打包并安装目录插件

在插件 feature worktree 构建候选包：

```powershell
$PluginRoot = 'C:/src/clowder-ai-plugins-acp'
$TaskRoot = 'C:/clowder-labs/acp-client'
Set-Location $PluginRoot
pnpm install --frozen-lockfile --link-workspace-packages
Set-Location "$PluginRoot/packages/acp-clients"
npm pack --pack-destination "$TaskRoot/packages"
Set-Location "$PluginRoot/packages/pi-acp"
npm run build
npm test
npm pack --pack-destination "$TaskRoot/packages"
Get-ChildItem "$TaskRoot/packages" -Filter '*.tgz' | Get-FileHash -Algorithm SHA256
```

每一步成功后再继续。记录自己生成的包哈希，版本相同不代表包字节相同。
pi 桥构建固定并校验上游源文件；已有候选 tgz 也可直接使用，不必重复构建。

将目录插件解压到一个新的安装来源目录，不覆盖已有包：

```powershell
$PluginExtract = "$TaskRoot/plugin-install/acp-clients-beta.2"
New-Item -ItemType Directory -Path $PluginExtract -ErrorAction Stop
tar -xzf "$TaskRoot/packages/clowder-ai-acp-clients-0.1.0-beta.2.tgz" -C $PluginExtract
if ($LASTEXITCODE -ne 0) { throw '插件解压失败' }
Test-Path "$PluginExtract/package/manifest.json"
```

最后一行应为 `True`。在「设置 → 插件集成 → 从本地目录安装」选择
**`$PluginExtract/package` 的实际绝对路径**，以 `manifest.json` 所在层为准。
页面显示本地来源未经公共目录验证，核对来源、名称、版本后按提示安装。
桥与原生客户端单独安装，不放进这个纯数据目录插件中。

## 3. 配置客户端、绑定角色

1. **准备客户端。** 在同一 Windows 用户下先确认 dsh、Claude Code、pi 能在终端正常使用，模型和认证可用。
   Claude Code 还需要 ACP 桥；pi 使用本轮 Clowder 桥和本机 Pi 1.3+。
2. **安装 pi 桥。** 执行 `npm install -g <实验目录>/packages/clowder-ai-pi-acp-0.1.0-beta.1.tgz`。
   这只安装执行桥，继续使用原来安装的 pi 和它的认证。原 `pi-acp@0.0.34` 不会把 ACP MCP 参数传给 pi。
3. **安装目录插件。** 按第 2 节操作；已安装则直接使用。
4. **添加客户端配置。** 打开「ACP 客户端目录」，点击对应预设，填写名称、固定 ID、启动命令和参数，保存配置并启用插件。
5. **绑定角色。** 在「成员与运行时」添加或编辑成员，在「模型与工具 → 使用工具」选择刚配置的 client。
   填好角色名称、职责和唤醒名。模型留空会跟随客户端；需要固定时填写该客户端支持的模型 ID。
6. **允许协作工具。** 在该成员的「高级接入」确认 MCP 已勾选并保存。
   在「设置 → MCP 管理」确认 Clowder 协作服务启用且允许该成员。已有关闭 MCP 的角色应明确开启。
7. **开始使用。** 在项目聊天中选择这些成员作为伙伴，用 `@角色名` 发消息。

### 插件里具体填什么

| 配置 | 用途 | 填写规则 |
| --- | --- | --- |
| 名称 | 成员工具列表里的显示名称 | 可修改，例如“pi 开发助手” |
| 固定 ID | 角色的长期绑定坐标 | 例如 `pi`；绑定后保持不变 |
| 可执行文件或命令 | 启动 ACP 进程 | 可填 PATH 中命令或绝对路径；路径含空格时不加外层引号 |
| 启动参数 | 分开传给该命令的参数 | 每行一项；没有参数可留空，不把整条命令塞进一个参数 |

常见配置：

| 客户端 | 命令 | 参数（每项独占一行） |
| --- | --- | --- |
| dsh | `dsh` 或对应启动入口绝对路径 | `--profile`，`acp` |
| Claude Code | `claude-agent-acp` 或桥的绝对路径 | 留空 |
| pi | `clowder-pi-acp` 或安装后的 `clowder-pi-acp.cmd` 绝对路径 | 留空 |
| 其他 ACP agent.exe | `C:/Tools/Agent/agent.exe` | 按该客户端 ACP 启动要求填写 |

如果启动入口是 Node 脚本：命令填 `C:/Program Files/nodejs/node.exe`，
参数第一行填桥的 `dist/index.js` 绝对路径，后续各参数再各占一行。
普通 `claude`、`pi` 命令不能直接当作这些桥的 ACP stdio 入口。

通常无需额外环境变量。Clowder 看不到终端 PATH 时，使用绝对路径；
pi 桥找不到原生 pi 时，在启动 Clowder 的环境中设置 `PI_ACP_PI_COMMAND` 为实际 pi 入口（Windows 通常为 `pi.cmd`）。
Claude 桥如找不到原生 Claude，可按桥要求设置 `CLAUDE_CODE_EXECUTABLE`。
这些变量指定程序位置，不放认证密钥；认证仍在原生客户端管理。

### 登录与必要环境变量

在单独的 PowerShell 窗口点加载 `lab-env.ps1`，再按客户端官方方式完成原生登录和一次对话验证。
确认实际认证/会话根处于实验目录。DSH 的某些全局启动器会重设 `DSH_HOME`，应先检查启动器。
需要源码或 Node 脚本入口时，填解释器为命令、脚本绝对路径为首项参数，不依赖当前终端工作目录。

确需 `PI_ACP_PI_COMMAND`、`CLAUDE_CODE_EXECUTABLE` 或其他启动变量时，在本机私有 `lab-env.ps1`
中添加后重启 API。这些变量作用于整个 Host 子进程环境，并非只针对一个 client。
仅在另一个终端设置变量不会改变已启动的 Host。当前表单没有每 client 独立 `env`、`cwd` 或 ACP URL。
模型/API 密钥沿用原生客户端配置或私有启动环境，不能放进 ID、名称或参数，不提交认证文件。

DSH 的自定义 provider 配置属于各自 profile：Desktop/Web 可用不代表 `--profile acp` 已选中该路由。
若 ACP 仍要求官方 DeepSeek key，按[DSH ACP 自定义 LLM 指南](dsh-custom-llm-acp.md)检查路由声明、默认选择和实际配置根。

## 4. 用户日常感知与第一条验证消息

配置完成后，日常只在 Clowder 里操作。例如：

> @规划猫 请读当前需求，整理任务后交给实现猫；实现猫完成后交给检查猫。

规划猫可以用 Clowder MCP 读取聊天，再发送带目标角色的协作消息。
被叫到的角色会收到任务并回复，同一聊天里能看到发送者、工具轨迹、投递和回复状态。
成功投递只代表消息已路由；看到接收方实际回复，才代表对方已执行。
默认只回复指定成员；需要多人并行时，明确指定多个角色或让成员使用相应协作工具。

用户不需要填写回调 token、当前 threadId 或 MCP server 启动路径。
Host 在每次会话调用时注入角色身份、工作目录和当前凭证；pi 在会话内注册这些服务器，不写原生 `mcp.json`。
新建或重启恢复聊天，都继续走同一角色绑定。停止正在执行的任务使用聊天中的停止操作。

第一次先新建实验聊天、选择成员，发送：

> @你的角色 请实际调用 Clowder MCP 的 cat_cafe_get_thread_context 读取当前聊天（limit=3），再用 cat_cafe_post_message 发布一条内容为 ACP_SETUP_OK 的消息；不要唤醒其他角色。最后说明结果。

应同时看到成功的工具结果和该角色发出的 `ACP_SETUP_OK` 持久消息。只看到模型说“已完成”不能判定通过。
跨角色、取消和重启续接的完整验收步骤在文档二。

## 5. 状态与排查

| 看到的状态 | 含义与操作 |
| --- | --- |
| 插件已启用、client 可选择 | 启动配置已激活；首次实际回复才证明登录、模型和网络可用 |
| 首次启动等待 | 客户端和 MCP 需冷启动；查看任务状态和工具轨迹 |
| 找不到程序 / init failure | 修正命令或脚本绝对路径，并确认对应客户端已安装 |
| 客户端能回复，但没有协作工具 | 确认角色 MCP 开关、MCP 管理权限、桥版本和客户端的 MCP 能力 |
| pi 提示需要 Pi 1.3+ | 更新本机 Pi，保留原认证和会话 |
| pi 提示重复 ACP MCP | 移除原生 mcp.json 中同名 Clowder 声明，让 Host 提供当前凭证；其他个人 MCP 配置可保留 |
| 插件停用、删除配置或 ID 改名 | 绑定角色显示不可用，需启用插件、恢复原 ID 或重新选择；不会偷偷切换到其他客户端 |

修改显示名称不影响绑定。修改启动配置会释放旧连接，下一次调用重新连接；
续接是否可用取决于客户端协议能力。停用或卸载插件不删除原生认证、设置和历史。

本轮实测为 Windows 的 dsh、Claude ACP 桥和 Pi 1.3：读取上下文 → 跨角色 MCP 接力 → 持久回执 → API 重启后原会话续接与再次调用 MCP。
真实 Clowder 协作使用 stdio MCP；HTTP 参数映射有协议测试，未把它当作远端 HTTP 服务的实测证明。
PR 中列有本轮验证范围；原始日志保留在作者的隔离验收目录，未随源码发布。
以上历史验收不自动覆盖你后来新增的客户端；应为新 client 保存独立的能力记录。

## Windows：怎样找到安全引导目录

需要包含本轮修复的 Host PR #1677。它是客户端进程启动时的隔离目录，**不是项目工作目录**；真实项目仍通过 ACP 会话传递。
字段留空时 Host 自动尝试用户 Temp、ProgramData 和本地固定 NTFS 数据卷。自定义 client 不会因为被配置到插件就获得 DSH/Pi 的审计特例。

1. 在**运行 Host 的电脑**上，以所有者身份打开 `http://localhost:<Web端口>/settings?s=plugins`。
   现有插件管理仍限制直接本机访问；其他电脑浏览器里的路径指的是 Host 文件系统。
2. 选择「ACP 客户端目录」，在目标 client 下找到「引导目录（可选，留空自动选择）」。先留空，点击「检查引导目录」。
3. 显示「严格检查通过」时会列出 Host 实际找到的完整路径。点击「使用此目录」，再点「保存配置」即可固定使用它；继续留空则保持自动选择。
4. 也可填写候选的绝对路径再检查，例如 `D:\ClowderBootstrap\my-agent`。
   **父目录必须已存在且合格**；最后一级专用目录可以不存在，由 Host 原子创建私有权限。
   不要填写项目目录、已有共享目录、驱动器根目录本身或 exe 路径；路径外不加引号。
5. 保存、启用并给角色发消息。检查成功只证明目录通过安全校验，还未证明客户端可执行、ACP 握手、登录、模型或 MCP 可用。

检查会创建专用私有目录及空检查子目录，不启动 agent、不发送模型请求，也不接管、修补或递归修改任何已有目录的 owner/ACL。
每次实际创建客户端及冷启动仍会重新检查；过去一次检查通过不是永久放行。
手动指定的路径失败时明确报错，不会偷偷换另一个目录。清空字段并保存，可恢复自动选择。

源码环境也可在 Host 仓库根目录执行同一检查器：

```powershell
node --import tsx scripts/check-acp-bootstrap.ts
node --import tsx scripts/check-acp-bootstrap.ts --root 'D:\ClowderBootstrap\my-agent'
```

第一条自动寻找；第二条只检查指定位置。`ok: true` 的 `root` 才是可填写的路径；失败退出码为 1，参数错误为 2。
请使用运行 API 的同一个 Windows 账户检查；管理员账户检查通过不证明标准账户能使用。

如果失败，按路径和原因处理：

| 检查结果 | 下一步 |
| --- | --- |
| `directory does not exist` | 检查父目录是否存在；改选已有安全父目录下的专用新子目录 |
| `untrusted owner` | 该路径的祖先不可信；选择另一条完整合格的祖先链 |
| `unsafe directory replacement` | 祖先向其他主体授予危险权限；仅新建一个子目录或改子目录权限无法解决 |
| 私有目录 owner / DACL 异常 | 保留该目录，不自动修补；核对归属后选择另一新位置 |
| 真实卷身份 / reparse 拒绝 | 不使用 UNC、junction、SUBST 等方式隐藏实际祖先 |

**默认严格模式下，没有安全候选时，客户端目录配置不能绕过校验。** 如果系统盘祖先 owner 不可信，其他数据卷根又向普通用户授予危险权限，
这台机器仍会拒绝启动自定义 client。需要管理员提供一处完整祖先链合格的专用本地 NTFS 存储位置（必要时专用数据卷），或在另一台合格 Host 上运行。
这里不要求也不建议接管 `C:\`、`C:\Users`，不扩大可信 SID。用户明确接受祖先替换风险时，可由 Host 部署者启用[显式可信主机兼容模式](./acp-trusted-host-compatibility.md)；该模式不等于完整信任校验，客户端自身的 EPERM 仍需独立排查。
现有 DSH/Pi 的特定自动回退不代表任意第三方 client 在共享卷根上都已完成安全审计。

新接入推荐使用“一个 Agent 一个静态声明插件”。本指南的可配置客户端目录仅覆盖获得 Host policy 授予 `plugin.config.read` 的官方目录插件；不能据此认定任意第三方动态目录都已支持无 core 修改授权。安装/选择客户端意味着运行 Host 上指定的本机程序，仍沿用 #1665 的进程权限与已知沙箱边界。

启动失败后，修复目录、程序安装或登录等实际条件，直接再次发送消息即可重试。
构建成功的服务仍会复用；失败不会永久缓存，也没有后台自动重复发送消息。
修改目录配置后保存会更新插件注册和连接；无需为了清除失败缓存而重启整个 Host。
