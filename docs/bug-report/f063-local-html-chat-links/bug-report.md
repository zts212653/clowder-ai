---
feature_ids: [F063]
topics: [workspace, chat-links, desktop, electron, local-html]
doc_kind: bug-report
created: 2026-09-20
updated: 2026-09-20
tips_exempt:
  reason: Correctness repair for existing chat file-link navigation; no new top-level capability.
---

# 猫咖本地 HTML 链接被打开为 localhost 404

## 报告人

co-creator 于 2026-09-20 在 thread `thread_mu9483ur6gjziqqa` 点击猫猫消息中的报告入口时发现。原消息 ID 为 `0001789877978954-000535-aa95c594`。

## Bug 诊断胶囊

| 栏位 | 内容 |
| --- | --- |
| **1. 现象** | 点击猫猫消息中的本地 HTML 链接后打开了无效页面；期望在默认浏览器中打开真实离线报告，并保留报告内的相对链接与资源。 |
| **2. 证据** | 现场链接为 `[打开试用入口](</Users/josephnatsu/代码/AC Claw/抓包分析/hybrid-report-dogfood/index.html>)`。目标文件存在且大小为 112397 bytes；其内含 `ap6-busy-downlink.html` 等相对链接。安装态为 Clowder AI 0.13.0，正在运行的 API 为 `127.0.0.1:3004`。修复前的组件红测确认 `.html` 被渲染为 `target=_blank` 的普通 `<a>`。 |
| **3. 根因** | `ChatWorkspaceLink` 和服务端 document resolver 只分类 `.md/.mdx`。HTML 绝对路径因此落入普通网页链接分支，ReactMarkdown 把它投影成应用 origin 下的 `http://localhost:3003/Users/.../index.html`；Electron 随后按允许的 app origin 交给外部浏览器，最终访问了不存在的 HTTP 路由，而不是本地文件。 |
| **4. 诊断策略** | 沿“原消息 href → ReactMarkdown URL transform → `ChatWorkspaceLink` 分类 → Electron popup policy”逐段对照，同时核对目标文件和安装态实例，排除文件丢失、旧 runtime 与通用 HTTPS 策略失效。 |
| **5. 超时策略** | 若实际报告不在已登记 Workspace 内，不放宽本地文件边界；回到 project/worktree 注册链排查。若系统没有 HTML 默认打开程序，保留明确失败提示，不回退到未校验的 `file://`。 |
| **6. 预警策略** | 任何实现若让 renderer 传递绝对路径/URL、允许非 HTML 文件、接受子 frame，或向 browser-origin request 返回主机绝对路径，就必须停止并重查安全模型。 |
| **7. 用户可见交互修正** | 已登记 Workspace 内的 `.html/.htm` 消息链接会作为本地操作按钮，点击后由系统默认浏览器打开真实文件。失败时原位显示“无法打开本地 HTML”。普通 HTTPS 和现有 Markdown Workspace 语义不变。 |
| **8. 验收** | RED 确认 HTML 被当作普通 anchor，API 拒绝 HTML，preload 无 typed call。GREEN 覆盖 URL transform、真实空格/中文路径、当前 worktree 解析、可信主 frame IPC、loopback-only API、traversal/denylist/symlink 越界、非 HTML，以及 OS opener 失败脱敏。 |

## 修复方案

Web 只把本地 `.html/.htm` 提升为 `{ worktreeId, path }` typed target。Electron preload 暴露精确的 `openWorkspaceHtml` 请求，不接收 URL 或绝对路径。主进程验证当前 main frame，再通过仅 loopback、非 browser-origin 的 API 路由在已登记 worktree/linked root 内解析 canonical path，最后调用 `shell.openPath`。

这样由默认浏览器以真实文件位置为 base URL，报告的相对 CSS、图片与子页链接保持可用；不需要在 Workspace `srcDoc` 中伪造基准路径，也没有放宽 Electron 的通用链接策略。

## 验证方式

- Web：本地 HTML 分类、Windows 路径保留、真实消息链接点击与现有 HTTPS/Markdown 回归。
- API：绝对 HTML 解析、canonical openable path，以及 remote/browser-origin、traversal、denylist、missing file 和 symlink escape 拒绝。
- Desktop：preload exact-shape validation、trusted sender、resolver response validation、`shell.openPath` 成功/失败与日志脱敏。
- 现场报告：用原始 `index.html` 路径跑完同一 API 解析链，并确认 `ap6-busy-downlink.html` 等相对目标存在。
