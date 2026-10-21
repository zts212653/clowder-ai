---
feature_ids: [F171, F155]
topics: [onboarding, browser-tests, recovery, screen-recording]
doc_kind: evidence
created: 2026-09-24
---

# 首启当前实现录屏（mock API）

录制基线：`dff40e41a6722cb87d0fdf875a6c5e3a1fb6fe73`。Windows、Node v24.16.0、Playwright Chromium headless、隔离 Next dev 页面 `/dev/first-run-onboarding`，1440×900、VP8。视频仅显示测试 fixture，没有真实用户路径或凭证。

| 文件 | 时长 | SHA256 | 可见行为 |
| --- | --- | --- | --- |
| [主路径](first-run-mock-main-dff40e41a.webm) | 14.40 秒 | `5abddb793faa252894f32472e8eddb09f2e5d9260c11f837e87b6e7f2c79768e` | 手动推进三猫脚本卡片；mock Codex 已认证和连接成功；mock 创建后显示“团队已就绪” |
| [恢复场景](first-run-mock-recovery-dff40e41a.webm) | 15.92 秒 | `ef9487b1c28c494a301f0a5b5013270406400cc9c17c416a0186f58cb8658e0f` | mock Codex 进入等待登录，刷新后保留 pending；mock 状态切换后重新探测为可用；同时显示未安装 Gemini |

所有 `/api/**` 请求均由 Playwright fixture 拦截。主路径没有真实 CLI 探测、真实成员/线程持久写入、F229 前台交接、首句或模型回复；恢复场景没有实际执行原生登录。视频只证明当前 UI 在这些 mock 输入下的可见行为，不能作为完整 #1466 验收证据。
