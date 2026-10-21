---
feature_ids: []
topics: [codex, native-tool, onboarding, issue-1654]
doc_kind: plan
created: 2026-10-21
---

# Issue #1654：原生 Codex 从检测到续聊的配置归属

来源：zts212653/clowder-ai#1654，以及用户授权的系统修复与完整流程验收。

目标：本机 Codex CLI 已能正常使用时，一键检测、添加的成员沿用同一原生配置，
首次对话、续聊、重启后续聊均可用，无需重新填写应用账号。

## 关键契约

- `configurationSource=native_tool` 且无显式 `accountRef`：CLI 拥有认证、provider、
  服务地址以及留空的模型/强度；应用账号目录中的默认账号不能接管。
- 显式绑定账号保留现有 OAuth/API Key、托管账号身份与持久化边界。
- 聊天、能力目录、本地会话读取共同消费上述归属判定；入口的工具权限仍各自保留。
- `auto` 是启动认证模式，不扩展持久化账号的 `authType`。
- 已发现安装、本机配置就绪和真实调用成功分别记录；失败必须投递给当前对话。
- 续聊使用持久化的原生 session ID；服务重启不能悄悄创建新会话冒充恢复。

## 工作单元与验证

1. 回归保护：调用真实账号解析与 provider 启动入口，覆盖空账号、syntheticNative、
   已存在其他默认账号、显式绑定；先取得行为 RED，再实施。
2. 统一原生配置归属与辅助入口启动，保留显式账号验证；排查真实聊天失败的独立机制。
3. 补齐检测/创建/调用间的必要接线与错误反馈，复用已有功能，不新增平行状态系统。
4. 定向测试与编译：API/shared 类型与 build、相关 API 回归、相关 Web 测试；
   本次文件执行 `pnpm exec biome check <files>`，全仓 `pnpm check` 记录独立基线问题。
5. 单套隔离环境验收：真实 UI 检测并添加、首次回复、同 session 续聊、受控重启后
   历史回读及同 session 再次回复；订阅、自定义 provider 与显式账号分别保留证据层级。
6. 独立非作者审查，处理发现后复验；保留分支/worktree 与验收资料供交付审阅。

## 状态、实例与收尾

- 原生会话由 Codex 持久化，应用 thread/session binding 由 Clowder 持久化。
- 使用本任务独立 HOME/项目/数据/Redis，端口启动前核对；不接管用户生产实例。
- 原生配置读取只输出字段名和脱敏状态，不输出 token。优先让测试原生 HOME 独立，
  不把共享登录等同于共享历史隔离；实际测试 session 逐个登记。
- 仅停止本任务已核验归属的进程；配置、认证、Redis、SQLite、会话与证据永久保留。
- 回退是停止本任务实例并回到本任务 base 构建；不修改用户正在使用的环境。
- No-Go：触碰生产数据、无法证明会话归属、以 mock 成功冒充真实模型/UI 验收。

Architecture cell：existing provider account / invocation / onboarding boundaries。
Map delta：共享配置归属判定，不新增持久化对象。
Why：修复不同入口对同一成员采用不同账号权威的问题。
