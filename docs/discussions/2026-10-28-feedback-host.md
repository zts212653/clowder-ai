---
feature_ids: []
topics: [plugins, ui, runtime-info, project-routing]
doc_kind: implementation
created: 2026-10-29
---

# 通用插件侧栏面板与运行上下文

配套插件在 clowder-ai-plugins #155，通用能力诉求为 Host #1734。本次仅补通用 UI 容器、只读运行信息和项目路由，不内置反馈业务。原候选的诊断服务、日志 collector、AgentService 和 Claude/Codex 启动改动已移除；相应服务源码相对当前 upstream/main 无差异。

## 公开语义与实现

- 既有 `ui` command/slot-item 声明注册到当前安装代际；`activity-bar.bottom` 在 WorldRail/ActivityBar 渲染，图标复用插件元数据与现有 icon 服务。停用/升级后旧入口和面板请求失效。
- 命令返回 SDK `PluginUiPanel`：`{kind:'plugin-panel',version:1,html}`。HTML 来自已校验安装包的模块，运行在 opaque iframe 与先置 CSP 中，不获得 Host DOM 或任意 fetch。桥接仅支持该声明命令、文本/PNG 复制及关闭。调用仍使用现有 owner request/模块调度，未增加反馈 API。
- 可选 `runtimeInfo.get()` 在活跃 owner HTTP 调用内投影当前实例版本/修订、系统、Node、默认项目和 logger 有效目录。只投影固定字段，不返回环境变量、配置、凭据或会话内容。读取日志和生成报告由插件完成。
- 普通 `threads.create` 新增可选 `projectRef`，复用 `resolvePersistentProjectPath`；不能与 parentThreadId 同时提供。有 parent 时仍继承该项目，均省略仍用默认项目。线程投影包含实际 projectRef，不能用 prompt 路径伪造绑定。

不增加 manifest contribution 类型或诊断会话数据库。API 对象的镜像类型在公开 SDK，实际 Host 实现保持其权威边界；不支持该能力的载体可以不提供 runtimeInfo。后续反馈 recipe、表单、图片或外部 Issue 适配改变无需修改 Host。

## 验证和剩余边界

- API 类型检查；4 项 UI/owner/生命周期/runtime-info/projectRef 定向测试；3 项 Web 隔离测试通过。
- 两个普通插件共用同一入口注册机制的测试通过，无反馈插件 ID 条件。
- 实际 packed 插件与真实 Host 面板/HTTP/模块调用/普通线程/私有存储编码器通过 19 项联合浏览器旅程。模型输出、外部平台和 Redis 传输为替身，不冒充真实 Client 或内网验收。
- 真实 Settings 安装全旅程、实际成员调用、平台写入和内网 CLI 仍待目标环境验收。两个 PR 保持 Draft，未部署或合入。

命令：`pnpm --filter @cat-cafe/api test:plugin-feedback`、`pnpm --filter @cat-cafe/web exec vitest run src/components/plugins/__tests__/plugin-ui.test.tsx`。打包旅程设置 `FEEDBACK_ARTIFACT` / `FEEDBACK_NPM_CLI`（可选浏览器模块/执行文件）后运行 `pnpm --filter @cat-cafe/api test:plugin-feedback:installed`。

临时测试服务已停止；台账、包摘要、截图、合成草稿/附件及回执在当前 worktree 的 `artifacts/feedback-installed/`。保留已有数据与工作树供 PR 复查，未绑定用户原生 HOME，未改生产配置、角色、历史、Redis 或 SQLite。
