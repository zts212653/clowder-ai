---
feature_ids: [F325]
topics: [antigravity, acp, setup]
doc_kind: guide
created: 2026-10-20
---

# 使用 AGY 官方 ACP

在成员设置的 Google 接入方式中选择「AGY 官方 ACP」，填写实际模型 ID、隔离 Profile 和执行权限。ACP Command 填安装后的官方程序路径，Startup Args 可以留空；保留解压目录中同包的 `localharness_external`。保存设置不会启动模型或登录。

1. 从 [ACP 官方 registry 固定发行记录](https://github.com/agentclientprotocol/registry/blob/45fddabd1ce00de605559a41ff182e59de85e215/antigravity-acp/agent.json)选对应平台安装包。正式路径要求发行物握手支持原生 `systemPrompt.append`（已核资格版本 1.4.0）；不使用旧版 Gemini CLI 的 `--acp --approval-mode yolo` 参数。
2. 保存成员设置后，在仓库根目录显式登录，例如 `pnpm agy:acp:login --cat gemini-argon`。该命令只启动已保存的官方 ACP 并请求 `oauth-personal`，随后在浏览器完成个人订阅登录；不会创建 Chat 会话或发模型请求。
3. 登录成功后，从正常 Chat 新建会话叫出该成员。后续串行回合由 SessionChain 保存原 ACP id，并在进程重建后加载同一个 id。正文、工具进度/结果、取消和错误沿现有聊天呈现。

ACP 的 HOME 是 `<Profile 根目录>/<Profile ID>/acp`；官方认证与会话保存在该 HOME 的 `.gemini/antigravity-acp/`。CLI 的登录和旧会话继续保留，不能冒充 ACP 登录或 ACP 会话。此路径只使用个人 OAuth；不会复制 CLI token、改用 API key 计费或自动发起登录。不同成员应选择各自的 Profile ID。

权限沿既有执行模式和共享保护边界。未知权限默认拒绝；受限模式拒绝写入和命令，明确选择自动批准后才允许受保护目标之外的普通操作。MCP 凭据继续按宿主 invocation/session 隔离，skills 来自已有挂载。

活动回合期间不并发发送第二个 prompt：新增消息沿现有 Queue/History 接收，精确 steer 仍不支持。恢复失败、空流、取消/拒绝和上游错误不会自动重放正文或偷偷切到 CLI。身份、模型、权限、Profile 或工作区不兼容时需显式新建会话，旧历史保留。JSON-RPC 请求 id 只关联协议响应，不代表供应商活动 turn 保护。

本次确定性测试和隔离假上游证明接线，不替代真实个人订阅下的模型遵从或可观察压缩。认证中断恢复、上下文快满接续与持久后台任务遵守 F325 的日常使用观察安排，不另跑付费验收矩阵。
