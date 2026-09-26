---
feature_ids: [F171, F155]
topics: [onboarding, browser-tests, recovery]
doc_kind: bug-report
created: 2026-09-23
---

# 首启浏览器入口与配置恢复回归

## 报告人与现象

Codex 在 issue #1466 实施验证中发现：4 项浏览器测试均等待首启按钮超时；后续恢复测试发现第二客户端配置中刷新会退回选择页，返回后重选会丢配置进度，多成员创建会因共用别名被拒绝。

## 复现与调查证据

- 工作区：`G:\AIwork\clowder-ai\worktrees\feat-onboarding-first-run`。
- 原浏览器运行 `81619`：4 失败，未进入业务断言；失败诊断在初始化之外，未输出 DOM。
- 增加诊断后使用独立测试端口；51212 监听 PID 15840，Next 父进程 PID 12548，启动时间 2026-09-23T07:46:14.504Z，对应本地代码检查点 `dd9fe00b8`。API 被 mock，没有访问生产 API。
- 显式指定尚不存在的隔离 tsconfig 时，Next 生成的文件没有继承项目路径别名，HTTP 500：无法解析 `@/components/FirstRunQuestWizard`。
- 使用已有 `createNextDevTestEnvironment` 后页面 HTTP 200，但全局 `CallbackAuthSnapshotMount` 抛出 `recent24h.byCat` 未定义。测试对未知 API 返回 `{}`，不满足 `/api/debug/callback-auth` 合同，导致整页挂载失败。
- 恢复回归测试修正按钮名称后，两项按预期行为失败：刷新后没有配置页；返回重选回到 Claude，预期是尚未完成的 Codex。
- 别名回归模拟现有 API 的跨成员唯一性检查，第二只 Codex 返回 400，显示“创建 Codex 失败”。

## 根因

1. 测试环境没有使用已有隔离配置生成器，且 AppShell 所需 API fixture 不完整；不是模型调用失败。
2. `stepForJourneyStage(setup)` 固定回 client，选择客户端时无条件清空 `configsRef`；探测结果与选中列表还共用一个持久化字段。
3. 创建多个客户端成员时直接复用模板 nickname，生成相同 mentionPatterns，与真实 API 唯一性规则冲突。

## 修复与取舍

- 使用仓库已有隔离 helper；增加 fetch 超时、HTTP 500 诊断，将页面初始化纳入失败诊断与 finally 清理。清理仅限经绝对路径检查的本次生成目录。
- 补认证快照、线程列表 fixture；仍保留真实 AppShell，不隐藏全局组件来绕过错误。
- 持久化 setup 子步骤，区分 detectedClients 与 selected clients；保留已有配置，恢复到第一个未配置客户端；关闭 localStorage 时读取不抛异常。
- 生成包含客户端标识的昵称和提及，并去重同一成员内部别名。完整角色映射仍待后续实施。
- 拆出演示组件与存储函数，格式化后 Wizard 保持 350 行以内；本次不把静态演示宣称为原分镜完成。

## 验证与剩余边界

- `node --test test/browser/first-run-onboarding.test.mjs`：5 项通过，独立端口 63702，约 51.7 秒；覆盖演示暂停恢复、pending、安装后重测、单客户端配置刷新、多客户端第二步刷新。均 mock API，不是真实 E2E。
- recovery + wizard + journey：15 项通过；Web 类型检查通过。
- API 编译通过；guide loader 16 项通过；首启 API 测试 35 项通过（含其他并行提交的凭证响应回归）。
- 扩大前端验证曾为 39/40 通过：并行加入的“本机默认模型缺失”场景连接按钮禁用。工作区补充允许 OAuth 使用 CLI 默认模型后，本次重新执行同一 9 文件测试，40 项全部通过。真实 CLI 默认模型调用仍未实测。
- 创建响应丢失后的幂等、CLI 登录拉起、真实角色交接、首条消息端到端、生产构建和安装器均未完成。
