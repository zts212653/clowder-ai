# trial3 — 生命周期预览、继承模型、原生登录与系统全页

引擎 / 组件 / 主题：未编辑，保留工作区已有的三份复制层改动。应用：`rules.js`、`members.js`、`notifications.js`、`project.js`、`useSettingsBindings.ts`。未提交 / 推送、未改环境、未启停服务。

3014 的实例核验仍受阻：`curl http://127.0.0.1:3014/api/health` 返回 `curl: (7) Failed to connect to 127.0.0.1 port 3014 after 0 ms: Couldn't connect to server`、HTTP 000。本轮核对的是实际路由 / shared 类型、上游 4020d9c659 的实现，以及合成 API 回执下的真实 VM / 主题渲染；没有做真实浏览器验收。

| 项 | 原因 / 层 | 应用结果与设计仓需改的声明 |
| --- | --- | --- |
| 7 生命周期预览 | `SEG_TEMPLATE` 只认 edit/tpl/hook，而真实 manifest 是 template/observe-only/shell-hook；非模板折叠还漏了 selected。现有 segOpen 已读正确的内容接口，但取了响应里不存在的 name。 | `rules.js` 补真实 viewable / editable、selected，标题取 manifest.name。GET `/api/prompt-injection/segment/:id/content` 仍在打开时读，VM / 折叠不逐段发请求。复制主题的触发与文字映射需按下面修改。 |
| 8 空 defaultModel | 997eccf7ca 允许合法空配置，并没有给 cats.defaultModel 填入虚构默认值；列表一直只读它，漏了已接的 runtime catalog。 | `members.js` 复用 runtimeCatalogState / memberPreferences。列表和详情给实际 model、modelLabel、modelSource，列表另给 modelStatus / configurationSource。POST `/api/cats/runtime-models` 或现有插件 models 读取只在相应 catalog 进入投影时触发；VM 不拉数据、不造 default 名称。 |
| 9 探测账号 / 接入方式 | 上游 useNativeOnboarding → recommendNativePartners → runtimeDefaults 明确 accountRef=''，create 透传 buildNativeCreationPayload；它沿用工具默认登录，没有把探测结果转成账号绑定。接入方式是合法 raw carrier。 | 保留创建语义、请求正文和幂等键，不写推测的账号 ID。form 给原始 configurationSource / accountRef / nativeLogin readiness，供主题区分“沿用工具登录”和“选择独立账号”。app_server 等显示由主题映射。 |
| 10 系统全页 | 真实摘要已在 trial2 接上，但 TTL、日志、超时、安全字段和路径仍未整理到主题位置；部分控件是原型演示值，真实 API 只读或没有能力。 | `notifications.js` 补下表全部可查询字段；`useSettingsBindings.ts` 如实描述完整摘要 paths；删除 `project.js:VM.system.theme`，系统页不再为已移除的主题行读 theme VM。不增加写接口，不把只读配置伪装成可保存。 |

生命周期的上游证据：`StageDetailPanels.tsx:SegmentRow` 对 template 或文件型 hook 打开 `SegmentEditorModal`；后者 GET `/api/prompt-injection/segment/:id/content`。目录 hook / observe-only 只展开来源信息，接口不提供这些运行时注入的静态模板正文。PUT override、DELETE override、POST restore-backup 延续原有 writer。

设计仓精确变更：

- `theme/default/views-settings.js:SEG_TEMPLATE` 改读 `@viewable`；不可预览的行继续 fold，moreWhen 使用已补的 `@selected`。段 sub / 来源类型对真实 `@kind` 做映射：template 按 editable 显示可编辑 / 只读；observe-only、shell-hook、config-driven、rule-generated、hook 映射各自语义，不显示 raw enum。more 的来源 / 触发 / 用途读现有 `@source` / `@trigger` / `@purpose`，不要按 id 推导或固定 cat-config 路径。
- `page.rules` 的 `$.stage.name` 与 `$.stage.groups[].caption` 复用 LIFE_NODE 已有的 lifeStage 映射：session-start/session-init/turn-build/client-invoke/turn-close/session-close/hook-events；不能只映射流程图而让小节标题仍输出 turn-build。
- `page.members` 列表 sub 读 modelLabel（实际 catalog 标签）与 modelSource；来源复用 MEMBER_MODEL_SOURCE 的 member/client_report/tool_config/account_config 文案。原生工具未回报有效模型时按 configurationSource / modelStatus 表达跟随 / 未回报，不能由空值推断“未设置模型”。应用保留 model 的真实 ID，不拼显示字符串。
- `MEMBER_SECTIONS.model`：f-acc 在 configurationSource=native_tool 且 accountRef 为空时表达沿用工具登录，状态读 nativeLogin.status（configured/login_required/unknown/not_installed）；保留主动选账号的能力。不要为了让 select 不空而写入 builtin 账号。f-via 的 @name/@value 补 cli→CLI、sdk→SDK、app_server→App Server、acp→ACP 的主题映射；插件自带名称保持原始数据。
- 同一 carrier 枚举也用于 `page.members:access-filter`：选项 value 应是 cli/sdk/app_server/acp/agy/cloud，label 才是 CLI/SDK/App Server/ACP/AGY Native/云端；当前直接把显示名字当 value，与宿主的 raw carrier 筛选不符。

系统全页逐项核对（入口均由 `page.system` 的默认小节顺序决定）：

| 小节 | 真实 owner / 已给的 VM 字段 | 控件、写入与缺项 |
| --- | --- | --- |
| general 通用 | lang / record 现有本地 store；processTalk `/api/config/process-talk`；send `/api/config/message-disposition` | 原有 change / writer 已接；主题行按 71d2b1a 删除，应用不再输出 system.theme。 |
| notify 通知 | `/api/push/status` + 浏览器订阅 owner → push、pushDiag；VAPID / 订阅 / 测试真实 writer | 浏览器推送已接。notifyTypes 分类开关无对应设置 API / 旧系统页能力，仍空数组，不创建本地假状态。 |
| network 服务器/网络 | curated env-summary → env.apiPort / previewPort / listenAddr / frontendUrl / frontendPort，v.lan / preview；config.variables 含 readonly / restartRequired | frontendUrl 需由常量改为读字段；LAN / preview 是只读配置，主题去掉 toggle s.sysVals.*，按真实元数据展示。 |
| storage 数据 | env.dataDir / redisUrl / keyPrefix / uploadDir / transcriptDir、v.memFallback；完整 env-summary.paths 也原样提供 | transcript 行改读真实字段；内存模式只读。数据目录更改没有运行时写能力。系统目录 reveal 不是现成通用能力：唯一 reveal-project 路由仅接受注册 workspace 内目录；不能把任意日志/数据目录塞进去。完整 logsExport 无 API，原型 features 明记 proto/demo.js，不注册空动作。 |
| ttl 保留时间 | MESSAGE/THREAD/TASK_TTL_SECONDS → v.ttlMsg / ttlThread / ttlTask；完整 config 还含 SUMMARY/BACKLOG_TTL_SECONDS | 原样秒数和 API 缺省元数据，不转换成 30/90 天枚举。主题 select 应改只读值 / 秒单位（0/负数永不清理），这些变量 runtimeEditable=false。 |
| log 运行日志 | LOG_LEVEL → v.logLevel；CLI_TIMEOUT_MS → v.timeout；完整摘要 paths.dataDirs.runtimeLogs → env.logDir | 主题改用真实日志目录、debug/info/warn/error 与毫秒值，去掉模拟 select / sysPick 写入。API 没有 logKeep 天数；logger 的 RETENTION_FILES=14 是文件数，不能当成 14 天。 |
| safety 安全 | env.allowedDirs / allowedDirsAppend / deniedDirs / ownerUserId ← PROJECT_ALLOWED_ROOTS / APPEND / DENIED_ROOTS / DEFAULT_OWNER_USER_ID | 主题的固定“未设置 / 系统默认 / 单用户”改读这些值及 config 的缺省元数据；只读。 |
| env 环境变量 | 完整 `/api/config/env-summary` → envCount / VM.env；`PATCH /api/config/env` | 只对后端 runtimeEditable=true 项开放现有 envOpen / settingsEnvSave，按回执保留 pending，错误留在原编辑对话框。 |
| update 桌面更新 | desktopBridge getUpdateSettings / updatePromptReady / onUpdatePrompt / onUpdateProgress → app / desktopAuto / update | 现有 checkForUpdates、autoCheck、download/install 已接，相关测试通过；浏览器无桥时由现有主题声明隐藏。 |

来源保持 needed-set 读取、held 数据与 by-id 合并；本轮没有新增挂载读取、轮询、注册层或后端修改。新增/扩展测试验证继承模型及来源、重复 VM 不重读 catalog、原生账号仍为空而幂等创建不变、真实 segment 内容响应（不含 name）、只在打开时读取、非预览段展开、系统所有可查询字段与真实日志路径。API 缺项是上表的具体行，不是整个小节。

上轮更正已同步到 trial2.md：logsExport 并非已接的真实动作。

```text
pnpm -C packages/web exec tsc --noEmit --incremental false
exit 0 (no output)
pnpm -C packages/web exec vitest run src/pdl
 Test Files  68 passed (68)
      Tests  678 passed (678)
   Duration  81.63s (transform 4.93s, setup 626ms, import 19.61s, tests 110.82s, environment 14.16s)
pnpm -C packages/web exec next lint --dir src/pdl
exit 0
next lint: 0 errors, 56 warnings
pnpm exec biome check <9 changed application/test files>
Checked 9 files in 690ms. No fixes applied.
Found 925 warnings.
Found 96 infos.
exit 0
privacy-grep = 0
git diff --check: exit 0 (no output)
```

privacy-grep 范围与前轮相同：public/pdl、public/pdl-app、非测试 src/pdl；未添加持久检查规则。
