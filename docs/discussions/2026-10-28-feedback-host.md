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
- `/api/plugin-ui` 仅 GET 发现入口，不注册 POST，也不调用 action。侧栏 command 对应唯一的静态 GET webhook：二者 CallbackAction 的 method 与 params 必须相同；页面路径由声明投影，不从插件运行结果取得。HTML 与业务均经 `/api/plugins/:pluginId/*` 通用分发，页面返回标准 HTTP `text/html`，不再使用 `PluginUiPanel` 信封或 `ui.call`。
- 依赖 Host 的面板通过 iframe 的 HTTP 适配桥访问本插件已声明的 `/api/plugins/:pluginId/*`，沿用 webhook 的路径/方法匹配、CallbackAction 参数与 request 信封、owner 上下文、响应和流处理。Host 限制插件路径与当前挂载代次，过滤认证及 UI 生命周期头；停用后旧面板不能借新激活继续调用。复制和关闭保留为浏览器宿主操作。
- 通用 HTTP 的 `text/html` 响应由 Host 添加 `CSP: sandbox allow-scripts`；直接导航或弹窗打开原始资源也没有 Host 同源权限。获取资源字节后，面板仍由既有 opaque iframe/CSP 渲染；页面切换后迟到的 HTML 或错误不能覆盖当前面板。
- 反馈插件 `0.1.0-alpha.2` 声明 GET `panel` 页面与 POST `feedback` 业务 webhook，代替 alpha.1 的 `invoke` 业务通道及专用挂载调用；Host 与插件需要配套采用。共享 HTTP 请求沿用原 UI 的 24 MB 上限，较大的报告和截图使用既有流响应，不放宽普通非流响应上限。
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
