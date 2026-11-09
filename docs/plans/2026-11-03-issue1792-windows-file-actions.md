---
topics: [windows, file-actions, chat-references]
doc_kind: plan
created: 2026-11-03
---

# #1792 Windows 文件操作修复方案

问题原文：[zts212653/clowder-ai#1792](https://github.com/zts212653/clowder-ai/issues/1792)。
实现基线：公开 `next` 的 `e2f64f840e4857501aa8c99cb14e1ae6aefa1737`。
目标：用户从聊天文件链接打开菜单后，看到正确文件名与文件信息，能复制原始路径；读取失败可以在菜单内重试。

## 根因与调用链

`ChatFileReferenceView → ChatFileActions → FileActions → useFileActionController → contentFileInfo` 调用后端的共享文件信息接口。

1. `file-action-client.ts` 将本地绝对路径等同于 `/` 开头，拒绝成功响应中的 Windows 盘符与 UNC 路径。
2. `useFileActionController.ts` 读取失败后只给出短暂通用提示；`FileActionMenu.tsx` 把没有信息的状态继续当成加载。
3. 两个聊天组件仅按 `/` 拆分文件名，Windows 反斜杠路径因此完整落入文件名区域。
4. `media-file-actions.ts` 只实现 macOS 的系统操作，却在其他平台返回可打开、可定位。

## 实现

### 路径与文件名

只在接收文件信息的边界校验一次绝对路径，接受 POSIX、Windows `C:\…`、`D:/…` 和 UNC `\\server\share\…`；继续拒绝相对路径、`C:report.md`、单反斜杠根相对路径与非字符串。

聊天链接和菜单标题按两种分隔符截取文件名。卡片目录仍保留原生路径写法；复制路径直接使用后端返回的原始值，不把显示用拆分结果变成文件身份。

### 加载、失败与重试

沿用现有 `info`，增加明确的读取失败状态。开始读取和重试时清除失败状态；失败后在菜单文件信息区域持续显示原因与“重试”，不再显示“正在读取”。成功后恢复路径信息和复制按钮。

保留现有菜单、焦点与可见性生命周期。重试复用已有读取函数，不新建请求框架。

### 平台能力

本次先修正声明：只有已实现的 macOS 系统操作可返回 `canOpen/canReveal: true`，仍受文件类型及 owner 授权限制。Windows/Linux 返回 `false`，同时保留 `local: true` 与真实文件路径。

菜单不显示无法执行的系统操作，并明确提示“本地打开与定位暂不可用，可复制路径或下载文件”。不新增 Windows 系统打开器，不把已有的 Windows 422 描述成支持成功。新增系统打开能力需要另行设计、审查和真实系统操作验收。

现有 macOS 执行分支、local-human 校验、owner 再授权、禁止客户端替换文件路径等边界继续生效。

### 长路径

复用已有信息区域的换行与菜单尺寸约束，先以真实浏览器验证。现有样式已能容纳长路径，因此没有为本次修复修改布局或新增 CSS。

## 验证

- RED：新增前端 17 项中 8 项按原缺陷失败；API 用例复现不支持平台返回 `canOpen: true`；Chromium 复现整条 Windows 路径被显示为文件名。
- 路径与交互：覆盖 Windows 盘符、正反斜杠、UNC、中文、空格、POSIX、非法相对路径、菜单失败与原地重试。
- 共享入口：覆盖聊天 inline/card、上传文档、已有图片与 classic lightbox 操作，保留菜单关闭、焦点恢复与来源不变。
- API：用临时真实文件和隔离 Fastify 验证上传/Workspace 元数据、平台声明、非法文件类型、伪造路径、代理/agent 身份及动作前再授权。
- 浏览器：360px 与 1280px，聊天卡片和上传文档菜单，失败→重试→复制完整原始路径，并检查菜单/页面没有横向溢出。
- 检查：受影响测试、Web/API TypeScript、改动文件 Biome 和 `git diff --check`。首次类型检查缺少本 checkout 的 MCP 生成产物；构建该依赖后重验，不改依赖版本。

验证针对独立 worktree 的生产组件和隔离测试数据；没有更新安装版 runtime，没有执行 Windows 外部应用打开操作，也不把本轮测试称作安装包验收。

## 审查与交付

宪宪已给出方案，砚砚已审查并落实上述收敛范围：保留 API 平台能力修正，暂不新增 Windows opener；保留原始完整路径而不增加 home 缩写；现有 CSS 已通过浏览器验证，不额外添加继承属性；路径处理保留在实际消费点，不新增公共 helper。最终 HEAD 仍须经过宪宪独立审查；本文不代表审查已通过。

从上述 `next` 基线提交窄 PR。GitHub 规则要求另一位受信任维护者用自己的账号正式 Approve，并且必需 CI 通过；同账号下的猫审查不能替代该批准。不绕过保护规则。

回退以 revert 本 PR 的提交完成，不涉及用户数据、持久化格式或运行配置变更。
