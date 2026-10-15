---
feature_ids: [F143, F161]
topics: [acp, image-input, regression, evidence]
doc_kind: report
created: 2026-10-14
tips_exempt: {reason: "补齐既有图片附件发送链，没有新增产品操作入口"}
---

# W2 图片附件漏接修复：Issue #1598

[Issue #1598](https://github.com/zts212653/clowder-ai/issues/1598) 纳入 [PR #1596](https://github.com/zts212653/clowder-ai/pull/1596)，与 #1590 的公共能力补齐同路实施。标准 ACP 已有 image content block，本次不需要私有扩展或上游 fork。这里只交付图片输入窄修复，完整 W2/G2、G4 和迁移仍未放行。

## 根因及实现

上传解析、消息存储及路由已把 `ImageContent` 传到 `options.contentBlocks`；断点在 `AcpAgentService` 不读附件、两个客户端把 `session/prompt.prompt` 写死为单个 text block。修复前用实际构建的 service/transport 做 STDIO/HTTP 的 fresh/resume-empty 四个场景，六次 prompt 均只有文本，尽管协商 `image=true`，且没有错误。不是协议表达能力不足。

现在 service 在建立/加载会话前完整读取平台上传图片，构造 text + 标准 `{type:"image", mimeType, data}`。STDIO/HTTP stream 和 STDIO collect 都接受字符串或 content array；旧纯文本调用保持原样。主请求、busy 重试和 resume-empty 的新会话重试复用一次读取的冻结 base64，重试期间上传文件变化不会改变本次输入。

图片能力取自 initialize 的独立冻结快照，getter 返回副本；修改原始 initialize result 或 getter 返回对象不能伪造能力。缺省/false 均拒绝图片，在 prompt admission 之前验证；不静默降为只发文字。附件不可读、空文件、路径/格式错误、数量/大小过限也返回明确的中文错误和错误码，任意一张失败都不会发出部分输入。

只读取 `UPLOAD_DIR` 内的 `/uploads/` 引用，解码后检查路径及 realpath 包含关系，拒绝静态 junction 越界、远程 URL 和任意本地路径。允许 PNG/JPEG/GIF/WebP，沿上传入口上限每次五张、每张 10 MiB，实际读取有界且不截断。既有 multipart、消息 schema、审批 factory、原生服务和 UI 未修改；没有新增配置/存储/owner，沿 F161 现有 ACP client，Architecture Map delta=none。

## 可重复验证

机器回执、实际源码/执行器/原始文件 SHA256、固定桥/native 版本和限制见 [manifest](evidence/w2-images-1598.json)。原始文件保存在忽略的 `.cat-cafe/tmp/`，不提交认证或私有 profile。

| 检查 | 结果 | 证明范围 |
|---|---|---|
| 首轮 RED | 0 pass / 14 fail | 实际构建客户端丢图片、不支持能力仍发送、读取失败未阻止发送 |
| 协商快照 RED | 0 pass / 2 fail | 原始 initialize result 的可变性可以绕过能力检查；修复后保留反例 |
| 图片专项 GREEN | 27 pass / 0 fail | 两 transport 的 fresh/busy/resume-empty、原始字节及顺序、MIME、string/collect、能力副本、不可读/越界/过限 |
| 受影响回归 | 280 pass / 0 fail，37 suites | ACP、权限、pool、factory、multipart 及既有 image CLI helper；排除下述三个已单独复现的 Windows 断言文件 |
| API build | exit 0 | TypeScript 构建及 F299 接口 census |
| 扩大 Windows 检查 | 350 pass / 10 fail | 不能宣称全 ACP/上传检查全部通过 |
| Windows 基线单独复现 | 72 pass / 10 fail | 不加载新图片模块，三个未改文件仍出现同样十项失败 |

十项现有失败分别为 `acp-bootstrap-cwd.test.js` 的两项 POSIX 0700/`/tmp` 断言、`acp-mcp-resolver.test.js` 的七项斜杠 basename 断言、`image-upload.test.js` 的一项默认上传路径斜杠断言。相关实现及这些检查没有本次变更，不删除断言来宣称通过；日志与分母保留。

本地专项命令（先构建 API）：

```sh
pnpm --filter @cat-cafe/api build
node --test packages/api/test/acp/acp-image-input.test.js
```

## 真实模型图片接收

使用新生成的 512×256 合成 PNG，随机码 `PIC-50E1CF` 只画在像素里，没有放入 prompt 文本；同时画蓝圆和红三角。图片 SHA256 为 `15ca6f5fc6061a4136ee348429a8094f3579361d7305eaef7c11fd1c719b221b`。两个实际桥均协商 `image=true`，两次 wire 都只有一次 ACP prompt、一个 image，解码后的 SHA 与原图相同，零工具调用；两个模型均读出正确随机码及形状。

| 固定样本 | 版本 | 耗时 | 回执 |
|---|---|---|---|
| Claude | bridge v0.70.0 / SDK 0.3.285 / native 2.1.299 | 29.276 秒 | `PIC-50E1CF`、Blue circle、Red triangle |
| Codex | bridge 2.1.1 / native 0.161.0，已审 no-title 副本 | 7.484 秒 | `Code: PIC-50E1CF. Shapes: blue circle and red triangle.` |

Codex native 日志另确认一次 `turn/start`、零 title turn，native image 的 data URL 解码后仍为同一 PNG SHA。一次 ACP prompt 不等于一次底层 provider 轮次；轮次及实际费用 unknown。Claude 的测试限制为 1 美元/SDK 最多三轮，Codex 无 USD 硬限；两者最多一个 ACP prompt、90 秒 watchdog、30 秒 idle timeout，禁工具/MCP、hooks 和用户指令。只复用用户已明确授权的认证选择，不把源码或认证值作为模型输入。

实际测试链是生产 `parseMultipart` 函数加合成 parts iterator → **内存 `MessageStore.append` → 测试 JSON 文件落盘/冷读** → 已构建的 `AcpAgentService`/`AcpClient` → 固定实际 STDIO bridge/native/model。pool 和 newSession 使用显式测试 wrapper 注入受限选项。没有真正 HTTP 上传请求、产品 durable MessageStore/TranscriptReader、产品 UI/socket 或 production factory/Approval Hub 验收。私有 runner 的 kind 中“message-store disk cold-read”按此含义解释，原始回执不改写。

CodeAgentCLI/MiniMax 的具体账号、模型和服务版本没有本次真实执行证据。宿主已支持标准 image blocks，但该 binding 还必须真实协商图片能力并正确转换到视觉模型；不声明图片能力时明确拒绝，不以文本路径/Read 或 preempt 等旁路冒充附件支持。PNG 的真实模型样本不外推所有 GIF/WebP/JPEG 或动态图片语义，其他格式本轮验证的是 MIME/字节传递。

## 独立审查及连续性

非作者 `/root/acp_plan_review` 对 exact code HEAD `feeabe1f70442fd2ec4a8eec70b8cc868ab7c09e` 独立复核通过，无 P1/P2；回读了专项 27、回归 280、两个真实 wire 和执行器/client SHA。该窄审查没有批准完整 G2/G4 或迁移；此后仅追加本报告及关联记录。后续证据不得用本次内存/测试 JSON 冷读替代产品持久化或 UI 验收。

原型桥的 fence/Notice/owner 合同未改，W4.P/W5.P 的 Go 沿原 fixed pins 保留；本修复增加宿主图片输入并保持原纯文本/权限/取消路径。现有 native 服务继续保留，生产迁移仍关闭。
