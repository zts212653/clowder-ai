---
feature_ids: []
topics: [thread-navigation, clipboard, sidebar]
doc_kind: plan
created: 2026-11-06
tips_exempt:
  reason: 复制入口直接位于既有会话更多菜单，操作与结果在同一位置可发现，无需额外提示入口。
---

# Issue #1883：会话菜单复制 Thread ID

Architecture cell: thread-navigation
Map delta: none
Why: 复用既有 ThreadItem 菜单和系统剪贴板，只增加本地复制动作与状态反馈。

## 原始约定与范围

用户要求找回曾写过的左侧会话 ID 复制功能，再以独立 PR 合入 `next`，并将原会话标题更新为 `issue#… PR#… 功能说明`。

旧实现来自本地 `139248c338fd191f323b5ed4fc20dff4f9913f6c`，未进入 #1762 的最终合入。以 `next@43c1c3cb7e4e2ba0285c993d5cc5bd016824a663` 为基线，仅迁移复制入口；不携带旧分支的 MCP、原生客户端配置等修改。

## 用户路径

打开左侧某会话的“更多操作”菜单 → “复制 Thread ID” → 将完整 Clowder Thread ID 放进系统剪贴板并显示“已复制”。当前及非当前会话均适用，操作不切换会话；剪贴板不可用或拒绝时显示“复制失败，重试”，可再次操作。关闭菜单再打开恢复普通标签。

复用现有菜单的方向键、Enter、Escape 和焦点返回；沿用系统视觉 token；新版英文界面显示英文动作及反馈。客户端原生 Session ID 不在本项范围。

## 验证记录

- RED：真实 ThreadItem 的 6 个新增用例均因复制菜单不存在而失败，原有 15 项通过。
- GREEN：22/22 ThreadItem actions 通过，覆盖 classic/v2、当前/非当前、精确完整 ID、不触发选择、剪贴板拒绝与不可用、失败重试及英文反馈。
- shell-copy namespaces：4/4 通过。
- Windows Chromium 浏览器：8/8 通过。真实 ThreadSidebar、产品 CSS 与隔离的内存 ThreadStore/Fastify 路由，使用真实系统剪贴板；覆盖 classic、新版中文/英文、当前及非当前会话、Enter、Escape 焦点返回、窄屏暗色和既有菜单定位回归。未连接在线服务或用户数据库；浏览器与内存路由在测试结束后关闭。截图保存在本地 `artifacts/issue1883-copy-thread-id/`，未声明为公开附件或安装包验收。
- 扩大检查发现 thread-item-state-subscription 与 thread-item-draft-badge 共 10 项失败；通过只在 Vite 内存替换为原始 `43c1c3cb7` ThreadItem 的对照，重复得到同样 10 项失败。两文件仍按 classic 展示断言，当前默认界面为 v2。本 PR 不修改它们；基线日志保留在作者隔离证据目录。
- 浏览器验证与非作者审查以本 PR 的最终 HEAD 回执为准；未合入和未激活前不声明在线环境已更新。
