---
feature_ids: [F171, F155]
topics: [onboarding, bootcamp, retrospective, prototype]
doc_kind: retrospective
created: 2026-10-08
---

# 训练营引导路径复盘与原型决策

## 文档目的

这份文档记录 PR #1519 相关分支到当前 worktree 的提交、修复、验证结果和现场问题，并把后续产品目标收敛成一条可交互原型路径。当前先完成事实整理和原型评审，暂不继续叠加生产代码补丁。

## 当前工作区与版本边界

- Worktree：`G:AIworkclowder-ai/worktrees/feat-onboarding-first-run`
- 分支：`feat/onboarding-first-run`
- HEAD：`7f1911b38 fix(desktop): make PR packaging work on Windows and macOS`
- 基线：`upstream/main` = `3e70e1d68`
- 本地存在大量未提交修改；本次只提交复盘文档和交互原型，不把未审定的业务修复混入 commit。
- `dist` 中先前的正确命名是 `ClowderAI-Setup-0.13.0-pr1519-r3..r12.exe`；后续 `ClowderAI-Setup-0.10.1.exe` 是未传 `CATCAFE_VERSION` 后回退到 `desktop/package.json` 的错误版本构建，不作为 PR 包证据。

## 最初目标

F171 的冷启动目标是“领养第一只猫、配置第一位伙伴并成功发送第一条有效消息”。完整训练营是后续可选的进阶体验，不应该让新用户在没有上下文时承担一整套隐含流程。

对用户可见的成功结果应该是：

1. 用户知道当前阶段要完成什么。
2. 用户知道为什么做、完成后会发生什么。
3. 用户发送消息后，等待真实回复结束再改变阶段。
4. 环境检测在当前阶段内解释，结果可见，且不弹出 CMD。
5. 当前阶段、已完成阶段、下一步和恢复入口始终可见。
6. 用户的任务描述有背景、目标、范围和验收标准，而不是一句模糊的“做个欢迎页”。
7. 阶段只在明确的完成条件成立后推进，异常会停留在当前阶段并给出恢复动作。

## 现阶段设计的状态流

当前生产代码使用：

```text
phase-1-intro
→ phase-2-env-check
→ phase-3-config-help
→ phase-4-task-select
→ phase-5-kickoff
→ phase-6-design
→ phase-7-dev
→ phase-7.5-add-teammate
→ phase-8-collab
→ phase-9-complete
→ phase-10-retro
→ phase-11-farewell
```

后端只允许前进，并允许环境正常时 `phase-2 → phase-4`、毕业路径 `phase-9 → phase-11` 等特殊跳转。问题在于阶段顺序的约束存在，但“阶段完成条件”和“真实回复生命周期”没有形成一条单一可信的状态机。

## 本次现场问题记录

### 1. 提示条遮挡训练营内容

现象：已有训练营页面底部出现黄色浮层，覆盖阶段内容和输入区域附近；用户需要滚动或缩放才能继续阅读。

已做过的尝试：`BootcampGuideOverlay` 在已有消息时改为底部固定提示，Phase 2 隐藏 overlay；`BootcampProgressBanner` 增加阶段历史和行动提示。

为什么仍失败：固定定位只改变了遮挡位置，没有把提示纳入训练营阶段布局；提示仍然拥有独立的高层级和固定底部坐标。它和输入框、聊天滚动区没有共同的布局所有权。

原型决策：阶段行动提示属于当前阶段卡片，不再使用独立浮层；历史放在右侧/可折叠区域，永远不覆盖聊天。

### 2. @opus 后出现大量 CMD 窗口

现象：桌面端发送“你好”后，大量命令窗口弹到前台；此前没有该体验。

代码线索：桌面服务管理器本身为服务进程使用 `windowsHide: true`，但 API 的 Claude 首次检测路径仍使用 `exec()` 系统 shell；真正 Agent 调用链还包含 PTY、CLI carrier 和 provider-specific spawn 路径。仅修复 Electron 服务管理器不能覆盖 Agent 子进程。

当前结论：根因尚未完成 runtime preflight，不能把问题归因到单一 `service-manager.js`。必须记录实际命令、父子进程、spawn 选项和是否使用 `cmd.exe`，再决定统一的 Windows hidden process contract。

原型决策：原型所有检测和回复均为浏览器内模拟，不启动任何 CLI/CMD；生产设计必须把“环境检测”和“Agent 回复”都绑定到可观察的无窗口进程契约。

### 3. 回复未完成，阶段 1 已被认定完成

现象：布偶猫仍显示执行中或尚未完成，阶段列表已经勾选“自我介绍”，并进入后续阶段。

代码线索：`useFirstRealMessageSync` 和 legacy bootcamp reconciliation 会在用户第一条消息后异步 PATCH 阶段；`ChatContainer` 也根据 invocation 结束、active 状态和线程同步触发阶段恢复。当前逻辑有多个完成信号：消息发送、active invocation 变化、线程重新获取、legacy fallback。

当前结论：这不是单纯 UI 文案问题，而是完成事件来源不唯一。必须定义唯一 `message.completed` 事件，并让阶段推进只消费带有 thread、message、invocation 和 final 状态的确认事件。

原型决策：点击发送后显示“等待布偶猫回复…”，只有模拟回复写入并标记完成，才进入环境检测。

### 4. 阶段 4 任务需求不明确

现象：提示只说“告诉布偶猫你想做什么项目，例如帮我做一个欢迎页”，没有给出背景、目标、范围、结果标准。

影响：用户输入的任务不可比较、不可验收，Agent 只能猜测，后续设计和开发也无法判断是否完成。

原型决策：阶段 4 必须提供结构化任务模板：背景、目标、范围、验收标准，并允许用户修改后确认。示例欢迎页明确说明目标用户、页面内容、按钮行为和验收结果。

### 5. 阶段 4 完成后没有继续推进

现象：用户完成欢迎页后，仍停留在第 4 阶段；页面只显示旧的环境检测提示，下一步不清楚。

代码线索：`phase-4-task-select` 当前提示由 `BootcampGuideOverlay` 和 `BootcampProgressBanner` 独立渲染；阶段推进主要依赖 Agent callback，而不是用户确认任务后的显式完成事件。消息发送、模型回复、callback 写状态和前端重新拉取之间没有明确的 handoff。

当前结论：阶段 4 缺少明确的完成契约。至少需要 `task.submitted` → `requirements.confirmed` → `phase-5-kickoff` 三个事件，不能仅依赖“有一条消息”或模型自行调用 callback。

## 已完成的代码、测试和打包工作

### Web 与 API

- 增加首启向导、CLI 检测、认证恢复、多客户端配置和第一条消息恢复逻辑。
- 增加 bootcamp callback 的前进约束、用户归属和环境检测恢复。
- 调整聊天容器、阶段提示、阶段历史和环境结果摘要。
- Web 组件测试：8 个测试文件、30 个测试通过。
- Web 浏览器 E2E：6/6 通过，但使用 mock API，未覆盖真实 CLI、真实模型和完整 12 阶段。
- Web production build 曾成功完成；仓库仍有既有 lint warning。

### Electron 与安装器

- Inno Setup 7 构建兼容。
- 快捷方式显式指向 `desktop/assets/icon.ico`。
- 服务日志不再持续刷启动 CMD。
- Electron archive 包含 `Clowder AI.exe`、`service-manager.js` 和 `assets/icon.ico`。
- 已生成多轮 `0.13.0-pr1519-r*` 包。
- 曾错误生成 `0.10.1` 包，原因是构建时漏传 `CATCAFE_VERSION`。
- 尚未完成安装后真实训练营、CMD 窗口、卸载重装的完整验收。

## 已提交的相关提交

| 提交 | 内容 |
|---|---|
| `361a57ccd` | 完成首启 onboarding journey |
| `ec0e57388` | 增加首启浏览器覆盖 |
| `c49505e25` | 修复 native credential detection/recovery |
| `7bd622b04` | 覆盖空账号目录和已登录 CLI |
| `dd9fe00b8` | 验证 Windows shell CLI probe 参数 |
| `f5cdd7c2d` | 恢复首启设置并检测 native Codex 配置 |
| `dff40e41a` | 保留 native Codex provider 并清理 probe 错误 |
| `935c57008` | 修复首启持久化幂等问题 |
| `e2527aaa1` | 修复 R3/R4/R5/R7 review 问题 |
| `494f35186` | 关闭 onboarding review regressions |
| `3cf8b39eb` | 重试第一条消息 onboarding sync |
| `c554666ca` | 为第一条消息恢复增加 CI 覆盖 |
| `300bc481d` | 解决与上游 main 的 onboarding 冲突 |
| `59dcf8beb` | 保留首启浏览器测试入口 |
| `7f1911b38` | 修复 Windows/macOS PR 打包 |

## 当前未提交修改

当前 worktree 还有 API、Web、桌面、skill 和测试修改，主要涉及：

- bootcamp callback 和环境检测恢复；
- ChatContainer、ChatMessage、ThreadChatSurface；
- BootcampGuideOverlay、BootcampProgressBanner 及测试；
- first-real-message sync/retry；
- Electron service manager、Inno Setup 和 Windows 构建脚本；
- rich block 与交互消息处理；
- 浏览器 E2E fixture。

这些修改混合了生产代码、测试和打包变更，尚未经过本轮新的产品状态机设计审查，因此本次 commit 不会提交它们。

## 原型交付

可交互原型：

[bootcamp-onboarding-prototype.html](./bootcamp-onboarding-prototype.html)

原型模拟完整 12 阶段路径，并验证以下行为：

- 阶段历史始终可见；
- 当前提示在内容区内，不覆盖输入框和聊天；
- 首条消息必须等待回复完成后才推进；
- 环境检测显示具体项目和结果，不弹 CMD；
- 任务输入有背景、目标和验收说明；
- 任务确认后会进入需求确认、设计、开发、协作、完成和毕业；
- 可回到已完成阶段重新查看，不允许跳到未完成阶段；
- 原型状态只存在浏览器内，不写 Redis、SQLite 或项目数据。

## 后续生产实现前必须确认的方案

1. **单一状态机**：定义 `phase`, `completionCondition`, `pendingAction`, `lastEventId`，前端和 callback 都只消费同一状态。
2. **唯一完成事件**：Agent 只有在最终消息写入并确认 invocation 完成后，才能提交阶段完成事件。
3. **布局归属**：阶段提示属于训练营内容面板，不再使用全屏遮罩或 fixed bottom toast。
4. **窗口契约**：所有桌面端 CLI/Agent 子进程必须使用统一的隐藏窗口启动策略，并在 Windows 上有进程树验证。
5. **需求契约**：阶段 4 产出结构化任务对象，而不是自由文本后直接推进。
6. **恢复契约**：刷新、重启、离线和旧数据迁移都从服务端状态恢复；本地状态只做临时展示。
7. **验收路径**：先用原型评审路径，再写真实 Web E2E，最后做桌面安装后的人工验证。

## 当前结论

之前的修复主要解决了局部回归和恢复问题，但没有解决训练营作为“用户可理解、可恢复、由明确完成条件驱动的状态机”的整体设计问题。截图中暴露的五个问题都属于同一类缺陷：提示、模型、callback、前端和桌面运行时之间没有共同的完成契约。

因此下一步应先评审本原型和上述状态机方案，再决定是否重写训练营推进链路。当前不应继续在现有浮层、回调和同步逻辑上追加零散修复。

## Issue #1466 评论与原型 v2 补遗（2026-10-08）

后续重新读取了 Issue #1466 的全部 3 条评论，并发现评论中已链接一套此前存在的交互原型：`feat/onboarding-journey-prototype/site/onboarding-first-run/`。该参考包含 `DEMO-CONTRACT.md`、纯状态机、状态机测试和浏览器测试。因此此前复盘只基于正文、没有审查评论和链接原型，结论不完整；本补遗取代上方将十二阶段串成单条强制路径的原型描述。

评论补充的验收方向包括：

- 演示结果应因第二只猫的审查而改善，不止展示互相 `@`；
- 单 client 时解说猫成为唯一真实伙伴，其他演示猫不能伪装成成员；0 client 停在安装/登录，多个 client 按选择创建成员；
- 点“去登录”只进入 pending，必须得到登录完成信号；刷新后从未完成处恢复；
- 进入真实主界面后再轻提醒成员和密钥入口，不能挡第一句话；
- 需要分别看清单 client 已登录组和需要安装/登录组的首句耗时；
- PR #1519 的交付声明不能代替用户现场验收。

其中 2026-09-15 的长评论开头注明是拟稿、尚未发布，故作为共创设计输入而非已通过的最终决定；2026-09-16 的后续评论确认第 8 幕入口提醒放在真实主界面之后。

新的 v2 原型在 [bootcamp-onboarding-prototype-v2.html](../../design/bootcamp-onboarding-prototype-v2.html)，完整来源审计、八幕/可选训练路径边界、验收清单和重启接续信息见 [handoff-2026-10-08.md](./handoff-2026-10-08.md)。它把 Issue #1466 八幕首启与训练营阶段 8–12 分开。所有模型调用、client 探测、登录和 Agent/文件动作均为浏览器 mock，未接生产服务。视觉角色目前仍是占位头像。浏览器验证完成前不宣称 v2 已验收。
