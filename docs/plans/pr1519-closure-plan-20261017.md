---
feature_ids: [issue-1466, pr-1519]
topics: [onboarding, native-clients, a2a, desktop, windows, acceptance]
doc_kind: implementation-plan
created: 2026-10-17
---

# PR #1519 收口实施与验收计划

来源：PR #1519 当前 HEAD `340aaaa271f8905133185f1a552e558f07b18679`、当前 PR 复盘评论、zts/mind 最新限定复核，以及 issue #1466 已接受的引导合同。

## 目标

在不改变已有角色、账号绑定、草稿、会话、消息、SQLite/Redis 和客户端登录配置的前提下，完成一条可复核的首启闭环：检测本机 client → 用户选择 0/1/N → 一键创建或手动创建 → 首条真实消息 → 刷新/重启历史回读；同时修复 A2A 判题误放行、Windows 启动/单实例恢复，并使当前 HEAD 的构建、安装和数据保护证据可绑定到同一 Setup。

## 当前状态锚点

- PR HEAD：`340aaaa271f8905133185f1a552e558f07b18679`。
- 当前 CI：19 SUCCESS / 1 SKIPPED；正式 approving review 仍缺失；PR 仍 BLOCKED。
- A2A：`native-team-a2a.test.mjs` 放宽次数约束后，重复 handoff 和无关角色 invocation 会被误判为通过；这是当前明确 P1。
- Windows：原生异常曾在旧包/旧诊断环境观测到 `0x80000003`，但必须绑定当前包 SHA、Electron/Chromium 版本、Windows 完整 build/UBR、PID/父子关系和原始 dump 后才能决定是否升级 Electron。`--no-sandbox`、提权和清空数据不作为默认修复。
- 单实例：当前源码此前只在 `mainWindow` 存在时处理 second-instance 聚焦；启动中、窗口销毁、失败和安装器停机需要单独覆盖。现已在 `window-recovery.js` 中收敛，且 main.js 保持 350 行硬门禁以内。

本轮已落地的收敛改动（仍需随当前 HEAD 做完整构建验收）：

- A2A 判题新增 `validateA2AInvocations`：额外调用必须能从持久化输入消息、角色、终态和时间顺序归类；合法结果后的确认允许，重复 handoff、再次输出任务标记、无关角色和无关输入拒绝。
- Windows 壳新增纯决策模块 `desktop/window-recovery.js`：启动中聚焦 splash，ready 聚焦已有窗口，窗口被销毁后只重建一个窗口，退出中忽略二次启动；安装器的 owner 身份校验未改变。
- 当前已通过确定性 A2A 正/负 fixture 和窗口恢复单测；真实 Windows Setup、干净首装、重启回读和真实 A2A 仍是收口门禁，不能用这些单测替代。

## 工作单元

### 1. A2A 判题 P1

改动位置：`packages/web/test/browser/native-team-a2a-proof.mjs`、`native-team-a2a-proof.test.mjs`、`native-team-a2a.test.mjs`。

契约：保留真实 lead→peer→lead 因果链；额外 invocation 必须逐项分类：

- 结果完成后的短确认：允许，但必须不消费原 handoff、不产生新任务结果、不触发新派发；
- 重复消费原 handoff、重复计算/交接、无关角色执行：拒绝；
- 缺少可验证输入消息、生产者、时间顺序或状态：保持未通过。

验证：先用四组确定性 fixture 形成 RED/GREEN（合法确认、重复 handoff、无关角色、未完成/失败），再运行现有 proof tests；真实模型不因该确定性修复重复调用。

### 2. Windows 壳与单实例恢复

改动位置：`desktop/main.js`、`desktop/installation-lifecycle.js`、`desktop/startup-state.js`、必要的 Electron 构建配置和定向测试。

契约：

- owner 身份先确定，再建立单实例锁；外来安装身份不能接管或停止当前 owner；安装器 `--quit-owned-installation` 的身份校验保留。
- second-instance 在 starting 时恢复/显示 splash 并记录 focus intent；ready 时显示现有窗口；窗口缺失/销毁时只重建一个窗口；failed/quitting 时显示真实失败并禁止重新拉起服务。
- 原生进程在应用 JS 之前退出时，应用事件不能冒充诊断证据；保留外部启动退出码、原始 stderr/dump 和包身份记录。
- Electron 升级仅作为候选方案，必须以同一用户/token/数据边界的旧包/新包对照验证后才落地；不默认关闭 renderer sandbox、contextIsolation 或 nodeIntegration。

验证：确定性覆盖连点、最小化/隐藏、窗口销毁、失败、退出竞态、外来安装身份；Windows 当前声明 build 上用当前 Setup 做干净首装、首次可见、连续启动只保留一个 owner/一套后端、同版修复和数据回读。

### 3. 首启成员与真实首句

改动位置：现有 first-run/成员检测与创建路由、`packages/web` onboarding UI、native client discovery/creation tests。

验收矩阵：

| 场景 | 必须观察 |
|---|---|
| 0 client | 明确空状态、手动创建入口、无阻塞报错 |
| 1 client | 仅勾选 1 个可创建，不能强制多选 |
| N client | 逐项显示 client、模型、carrier、认证状态；可部分提交 |
| 未安装/未登录/检测失败 | 状态可区分，重试不重复创建 |
| 重复点击/刷新/丢响应 | 幂等，不重复角色；成功项保留 |
| 已有角色/历史 | 不展示首次空状态，不覆盖既有角色和消息 |
| 首条真实消息 | 至少一个当前可用 client 返回真实回复；刷新/重启可回读 |

检测到 Kimi/Pi 只表示发现与配置可用；真实调用仍需单独证据，不能用检测结果冒充成功。

### 4. main 合流兼容

验证 classic/v2、主题切换、shell 偏好、默认钉选、错误头像、unified message delivery lifecycle、thread/session/target/message identity、取消/重试/刷新/重启和 private/public 边界。只覆盖本 PR 实际改动和已接受合同，不把 #1590 新协议讨论扩成新增范围。

### 5. 构建、安装与数据保护

同一次源码构建生成 API、Web、桌面壳、Electron 归档和 Setup；记录 source SHA、包 SHA-256、依赖/归档身份和日志目录。用全新程序目录、instance root、HOME、Redis 和端口做干净首装；另用带测试角色/消息的专属升级基线验证同版覆盖/失败修复后的配置与历史回读。

性能只报告阶段日志和分布，不以单次 <120s 代替产品目标。安装失败、启动失败必须保留原始日志，不清库、不杀无关 owner、不用暖启动或升级替代首装。

## 不纳入本轮

- Claude 外部 llmapi 限制、OpenCode 地区模型限制等已知外部服务问题，除非新改动造成回归。
- #1590 尚未接受的新 ACP 能力讨论。
- 删除用户/生产 HOME、原生 Codex/Claude/Kimi/Pi 会话或历史。
- 用管理员权限、`--no-sandbox`、关闭安全隔离或复制生产凭据规避失败。

## 收口门禁

只有以下全部具备才请求正式 review/合入：

1. A2A 判题 P1 的正负 fixture 全部通过，且真实客户端提前终局仍单独记录为 No-Go；
2. 当前 HEAD 的全量必需 CI 无 pending，冲突已核对；
3. 干净首装、首次可见、检测/创建/首句/历史回读和同版修复证据绑定同一 Setup；
4. classic/v2、main 合流、Kimi 回归和数据保护验证完成；
5. Windows 壳异常有包身份、完整版本、PID/父子、退出码和原始日志/dump；
6. 至少一个非作者正式 approving review，逐条回应 zts/mind；
7. PR 评论更新为当前 HEAD，明确完成项、No-Go 项和未采纳项。

Architecture cell: Electron shell → startup/instance lifecycle → API/Web/Redis → onboarding/member creation → native client carrier → persisted messages/history。
Map delta: 本轮只收敛 A2A 判题、启动/单实例恢复、真实首启验收和证据门禁；不改变 provider/carrier 的既有所有权边界。
Why: 将 PR #1519 从“多轮实验结果集合”收敛成当前 HEAD 可验证、可回退、可审查的产品交付闭环。
