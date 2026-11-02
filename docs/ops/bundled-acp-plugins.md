---
feature_ids: []
topics: [plugins, acp, installation, recovery]
doc_kind: guide
created: 2026-11-02
tips_exempt: 修复既有插件安装准入，不新增用户入口；使用与重试步骤在本指南维护。
---

# 安装与恢复发行版预置的 ACP 插件

ACP 插件是启动配置声明；Host 负责校验包、托管生命周期并启动客户端。发行版可以预置 CodeAgent、RelayAgent 等声明包，原生客户端程序和认证仍由使用电脑提供。公共 Host 的支持不代表每个发行版都已预置这些插件。

## 用户操作

1. 在运行 Host 的电脑上安装、配置原生客户端。CodeAgent 通常使用 `codeagent --acp`；RelayAgent 的示例入口是 `python -m relay_acp`，实际以收到的插件声明和企业安装说明为准。
2. 打开设置中的插件入口。发行版已预置时，从内置目录选择安装；另行获得合法 `.tgz` 时，可从本地压缩包上传安装。相同包应获得相同 ACP 能力，来源仍按各自的摘要和身份规则校验。
3. 安装成功后启用插件。在成员配置的使用工具中选择该插件提供的客户端，再设置角色身份。一个客户端可以服务多个独立角色，不要按角色名字复制多个客户端。
4. 默认命令能在 Host 的 PATH 找到且已配置时，通常无需修改连接。特殊路径或参数在插件已有配置字段中保存；该配置属于 Host 机器，远程浏览器电脑的路径不能代替它。

固定客户端的 `connection` 是 JSON 字符串。若当前界面提供普通字符串字段，可填写如下值；名字、客户端 ID、transport 和任意环境变量不是可覆盖项：

```json
{
  "command": "D:/Tools/CodeAgent/codeagent.exe",
  "startupArgs": ["--acp"],
  "permissionPolicy": "deny"
}
```

RelayAgent 选择正确的 Python 环境，例如 command 为该环境的 python.exe，startupArgs 为 `["-m", "relay_acp"]`。不要把账号、密钥和认证文件复制到插件归档或命令参数。

保存一次后，后续使用和重启沿用已保存的配置。连接变更不重建工具 ID；例如 CodeAgent 引用保持 `plugin:official.codeagent/codeagent`。已有本地安装、角色及历史不自动迁移到内置来源。

本次固定客户端接入的 ACP 权限请求默认拒绝。需要 auto_allow 时，由 owner 在已有连接配置中明确保存；插件声明或默认配置不能自行授予该权限。旧多客户端目录未指定 permissionPolicy 时仍沿用原有策略。CodeAgent 原生 bypass 参数是另一个独立设置，本修复不自动开启。

## 失败和重试

- `bundled archive ... builtin runtime`：旧 Host 可能仍把所有内置归档当作 builtin runtime。使用包含本修复的 Host 后，在原入口重试；不需要给声明包补假的 runtime 或清空 inventory。
- 临时下载/读取失败：恢复来源后重试同一个受校验的版本。包字节仍需通过注册表、摘要和解包校验。
- 摘要不匹配、坏归档或隔离提示：先核对发行源和原始归档。这类安全拒绝不能通过普通重试自动解除；不要关闭校验或给同一已发布版本换摘要。
- 配置或原生程序不可用：在原插件配置入口修正路径、参数、环境安装和登录，再启用/重试。不要通过卸载或删除历史来修复启动问题。

安装/更新失败会在 API 日志记录 `Plugin package operation failed`，字段包括 reqId、operation、已知来源/插件标识和公开 code。通过相同 reqId 关联 API 的 incoming request / request completed 日志，再对照客户端收到的状态码和错误；本修复未向 HTTP 响应新增 reqId 字段或响应头。失败诊断不包含归档内容、连接值、认证头、用户路径或原始错误 cause。

Windows 引导目录及审计继续使用当前 Host 部署策略。本修复不修改 .env、intranet-host.json、系统盘或祖先 ACL，也不能修复客户端自身的 EPERM、登录或模型接口错误。

## 发行集成验收

集成者保留原生插件版本和归档，吸收 Host 通用修复，核对实际安装包中的 bundled 索引和归档摘要；不要用同版本重新打包来替换已发布字节。

使用实际归档验证内置 catalog 安装、启用、失败重试和更新；升级已有环境时核对同一实例、连接配置、角色引用和历史。安装源码的协议 fixture 验证不能代替企业 CodeAgent/RelayAgent 的真实模型、MCP、角色协作和重启续接验收。

方案与边界见[Issue #178 实施方案](../plans/2026-11-02-issue178-bundled-acp-admission.md)。
