---
feature_ids: [F171, F155]
topics: [issue-1466, onboarding, native-runtime, validation]
doc_kind: validation
created: 2026-10-12
---

# #1466 本机伙伴引导：真实项目验证记录

## 交付边界

对应 [实施方案](./issue-1466-native-onboarding-2026-10-12.md)，本轮实现提交为 `d44ffc092`、`7ea44ea1c`，分支 `feat/onboarding-first-run`（PR #1519 主线）。本次本地实施与隔离体验不等于整个 PR / issue 验收或合入；一键安装仍不在本轮范围。

用户入口是项目真实首页的“配置我的伙伴”。推荐、模型设置、成员持久化、对话创建、输入框和客户端调用都走实际项目链路，没有独立 HTML 或模拟回答。

## 真实环境操作

作者通过浏览器操作验证：

1. 空成员首页进入向导；本机 Codex、Claude Code、DSH 同时被发现并默认勾选。
2. 展开“调整”复用成员设置。当前机器读取到 Codex 7 个、Claude 5 个、DSH 3 个模型选项；这只是本机本次结果，不是产品写死的列表或支持上限。
3. 选择三位伙伴和小目标，确认后创建真实成员及普通对话，目标进入输入框。创建前无成员写入；没有旧训练营示范消息。
4. 显式发送后，三种客户端都已在实际聊天返回回答：

| 客户端 | 路径 | 成功 invocation / 页面证据 |
|---|---|---|
| Codex | App Server | `6852dfc2-caa0-4d8d-8c7f-00c8d0db2c5a`；待办清单三步计划 |
| Claude Code | 原生控制通道 | `386c7661-c4e7-4104-a086-4abdcdfa780e`；阅读笔记建议 |
| DSH | ACP profile | `d24e6d27-7901-4310-ad4e-117730ea1274`；页面最终消息轨迹为 `9c652a5c-f77b-49f5-9425-dc1b45550c77`，返回阅读笔记三步建议 |

5. 在 390 × 844 窄屏操作伙伴页 → 小目标页 → 返回；底部按钮可达、正文独立滚动。恢复默认桌面尺寸。
6. 修复了异步线程刷新时欢迎提示重新覆盖向导的现象。开启向导即记住提示已处理，向导打开时不再显示欢迎提示；并未标记目标已完成。

截图存放在本机 artifacts，不包含认证值：

供远端 review 直接查看的实页截图已纳入版本控制：[桌面伙伴选择](../design/assets/issue1466-native-onboarding/partners-desktop.jpg)、[窄屏小目标](../design/assets/issue1466-native-onboarding/goal-mobile.jpg)。它们来自实际项目页面，不是 HTML fixture。

- `artifacts/issue1466-onboarding-user-20261012/partners-desktop.jpg`
- `artifacts/issue1466-onboarding-user-20261012/partners-mobile.jpg`
- `artifacts/issue1466-onboarding-user-20261012/goal-mobile.jpg`
- `artifacts/issue1466-native-onboarding-20261012/dsh-real-reply.jpg`

## 实测中发现并修复

| 问题 | 根因与修复 | 证据 |
|---|---|---|
| Codex 模型目录正常，真正调用 `spawn EINVAL` | Direct carrier 在 Windows 直接 spawn npm CMD；改用项目现有 Windows 启动计划，保留 `boolean \| string` shell | 真实调用失败 → 回归测试 RED → 两种 shim/fallback 测试 GREEN → 真实回复 |
| Claude 跟随默认时请求记录校验失败 | 无覆盖的 effort 是空串，却传入要求非空的可选字段；print/bg/pty 省略空 effort，SDK 同样省略空 model | 原生启动测试新增请求 schema 断言 RED → GREEN，SDK 测试 GREEN，真实回复 |
| 已有 `@Codex` 或多个 DSH 导致保存失败 | 前端别名判重与后端大小写无关规则不一致，且没有预留本轮其他推荐别名 | 统一小写 reserved set；已有与新增伙伴冲突测试 RED → GREEN |
| 安装后重新检测仍全部未选 | 恢复草稿误把“未安装所以未选”当成主动取消 | 新安装推荐自动选中，保留明确取消；测试 RED → GREEN |
| 隔离实例 DSH `session/new` 失败 | 隔离项目没有本项目 MCP 代码入口，日志明确显示 `Cannot find module .../packages/mcp-server/dist/collab.js` | 补齐该实例的只读代码 junction；原有 DSH 配置不变；真实回复 |

以上没有新增绕过认证的 fallback；Windows 复用既有统一启动器。空参数用“缺省”表达继承，不为不同 carrier 编造默认强度。

## 自动化检查

在 feature worktree 中执行：

- Web：`vitest run src/components/first-run-quest/__tests__`，33/33。
- 共享成员设置：`member-runtime-catalog`、`member-runtime-switch`、`member-quick-config`、`member-runtime-contract`，15/15。最终合并执行 13 个文件、48/48。
- API：`node --import tsx --test` 执行 `native-discovery-safety`、`native-runtime-routes`、`cats-routes-runtime-catalog`、`runtime-catalog-rpc`、`codex-app-server-transport`、`native-provider-launch`、`direct-carrier-windows-shim`、`native-dsh-discovery`、`native-onboarding-thread`、`native-claude-sdk-defaults`，52/52。
- API TypeScript 编译通过。Web 应用源码（包括 src 下测试）的独立 TypeScript 检查通过，配置为 `artifacts/issue1466-native-onboarding-20261012/tsconfig-app.json`。
- 改动文件 Biome 检查无 error，存在复杂度/语义元素等 warning；`git diff --check` 通过。
- 旧 standalone 浏览器测试已改为三伙伴真实流程的接口契约 fixture，`node --check` 通过。此处没有运行外部 Playwright 浏览器套件，实际页面操作使用 CUA，不能把语法通过当浏览器测试通过。

没有隐去的验证限制：

- Web 全量 `tsc -p packages/web/tsconfig.json --noEmit --incremental false` 仍被未改动的 `vitest.config.ts:14` 阻挡：根目录和 web 两份 Vitest 的 Reporter 私有类型不兼容。
- 扩展 `issue1371-direct-carrier-exit.test.js` 为 3/4，Windows 延迟 stderr 用例失败。使用修改前 `007631612` 的 carrier 源码运行同一用例也失败（`artifacts/issue1466-native-onboarding-20261012/check-baseline.mjs`），不是本轮引入；本轮不改输出排空机制。
- 扩展 `f318-claude-sdk-launch.test.ts` 为 5/6；现有路径断言期待 `/tmp/images`，本机实际规范化为 `G:\tmp\images`。本轮没有修改目录解析。

## 用户验收实例与隔离

用户入口：`http://localhost:5138/?shell=v2`。

| 用途 | Web / API / Redis | 数据目录 |
|---|---|---|
| 作者真实调用验证 | 5126 / 3126 / 6376 | `artifacts/issue1466-native-onboarding-20261012/instance` |
| 用户从头体验 | 5138 / 3138 / 6374 | `artifacts/issue1466-onboarding-user-20261012/instance` |

用户实例保留空成员、空对话；仅打开向导，没有点击最终保存。与作者验证历史分开，未清空任何数据库。两个实例独立 HOME、CLI 配置副本、catalog、SQLite、transcript、Redis 进程和数据目录；cookie 名亦独立。后台使用项目 preview-process 管理器，默认 8 小时进程租约，状态与启动命令可由其记录恢复。

生产保持 `runtime/issue1466-member-names-20261012@bc76776942d5508d74fde5a03c44362f43e55ba0`，未重启 3003/3004/6399。`protected-before.json` 中的五个原配置/认证/生产 catalog 文件在实测后 SHA-256 均一致。生产目录中已有未跟踪脚本和事故文档未触碰。

## 独立审查

非作者审查在 `d44ffc092` 提出 Windows CMD fallback 和别名冲突两项 P2，均按上述 RED → GREEN 修复，送审实现 HEAD 为 `7ea44ea1cb5f02230f7745ab936b27874813a1fa`。

复核结论 `approved`，无剩余 P1/P2；独立重跑前端推荐/恢复 8 项、Windows 启动及原生参数边界 6 项通过。该结论限定于本轮源码/修复和隔离验收交付。

审查代理的 CUA 返回空浏览器列表，无法独立操作页面；作者的真实页面操作与截图不能冒充独立浏览器审查。本轮交付用户验收，不据此宣称整个 PR 已满足合入门禁。

2026-10-12 用户反馈：“我初步体验这个隔离环境认为是没问题的”，并授权推送 #1519、在 #1466 更新实际流程与未完成项，邀请 zts、mind 继续 review。这是本轮初步体验认可，不扩展为完整 issue / 安装 / F320 / 历史合入阻塞验收。
