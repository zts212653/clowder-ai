# trial2 — 输入图片、执行时间、依赖、能力中心与系统配置

应用层已修可接的真实数据；引擎 / 组件 / 主题未编辑。工作区已有的 `public/pdl/library/css/core.css`、`theme/default/layout.js`、`theme/default/views-settings.js` 改动保留原样。未提交、推送、改环境或启停服务。

3014 在本沙箱不可达：`127.0.0.1` 和 `localhost` 均为 curl exit 7、HTTP 000。因此以下是当前真实路由 / shared 类型、上游旧 UI 与契约的核对，配合合成 API 回执测试；没有宣称已读取 lang 的实例数据或做浏览器验收。

| 项 | 原因 / 证据 | 层 | 本轮结果 |
| --- | --- | --- | --- |
| 1 输入图片 | `chat-models.ts` 的 `input.draft.att` 和设计 `app/cafe.js:cafeDraftVM` 都只有附件元数据，没有图片源 / 预览目标。`views-chat.js:chat.composer` 把它画成文件图标 chip，只有移除动作；`library/ui.js:chipHtml` 没有缩略图参数。 | 契约 / 组件 / 主题 | 待设计仓补，项目没有另画。具体所需变更见下。 |
| 2 回复胶囊 NaN | `views-chat.js:chat.composer.runners` 的 clock 读取 `seconds` / `ticking`；应用只给了身份 / kind / exec。真实 `ActiveExecutionProjection` 必有毫秒 `startedAt`，可选原始 `activity`。 | 应用 | `chat-models.ts` 由 startedAt 提供已运行秒数，给 ticking=true 和 what=activity；继续用组件自身时钟，没有 React 定时器。 |
| 3 用户图片嵌套 | 真实 `ImageContent` 从 `contentBlocks` 聚成 `content-images` media_gallery；`richBlockView` 遗漏了 count。外层 bubble → CHAT_RICH 的 card / 标题 → chat.rich.cards 的 cards 是复制主题的声明，同样存在于设计契约。 | 应用 + 主题 | `rich-models.ts` 补 count=items.length，1 张 / 2 张均验证；多层盒子需主题改。 |
| 4 Skill 依赖 | 真实 requiresMcp 是 `{id,status:ready\|missing\|unresolved}[]`。应用把每个非 ready 依赖当一个 issue；主题读的是一个 issue 的 deps / n / missing。 | 应用 + 语言包 | `capabilities.js` 按原型给单条聚合 issue：`{code:'dep',n,deps:[{id,st}],missing}`，保留真实 unresolved；语言包尚缺该枚举，见下。 |
| 5 能力中心 | `/api/marketplace/search` 的四个 source 通常是 availability=live；应用全放进了主题只画警告的 sources。详情又漏了 sel.eco / availability，groups 缺 kind；where 没有真实目标却无条件生成。 | 应用；另有演示动作 | `plugins.js` 对齐原型：sources 只含异常且符合生态筛选；补 eco / availability / groups.kind；去掉不存在的 plan.target 和没有目标的 where。manual_ui 的文字正确；其 mkOpenUi 只有 proto 演示桩，不能冒充可执行按钮。 |
| 6 系统缺段 | `project.js` 固定 order=general/update，`notifications.js` 又只补 notify，截掉主题默认其余小节；且一直没读系统摘要。上游 4020d9c659 的 HubSystemSettingsTab 读 `/api/config/env-summary?surface=system`，SystemSettingsView 对这些配置只读显示。 | 应用 + 主题 | 撤应用 order；`useSettingsBindings.ts` 按投影读现有系统摘要，保留完整原始 `{groups,variables}` 到 system.config。notifications.js 给 env 端口 / 地址 / 目录 / Redis、真实布尔状态；环境变量计数读完整 env-summary，不拿系统摘要子集冒充总数。只在来源进入 needed set 时读，不在挂载 / VM 读取时请求。 |

设计仓需要的确切变更（项目未改这些文件）：

1. `library/ui.js:chipHtml`、`library/blocks.js:chip`：给通用 chip 增加可选图片缩略图属性，保留名字点击和独立移除按钮。`theme/default/views-chat.js:chat.composer` 的 `input.draft.att` 绑定图片源及媒体预览动作；`app/cafe.js:cafeDraftVM` / features 同步声明 image 的 source 和草稿预览目标。当前 media opener 的 mid / block / i 指持久消息，不能拿草稿序号假扮消息坐标。
2. `theme/default/views-chat.js:CHAT_RICH`：media_gallery 不再套额外 `box variant:card` / 默认“图片 · N 张”标题和 cards 标题；按 `rich.cards.items[].src/alt` 用现有 media 图像组件表达，保持其它富块不变。应用没有把附件伪装成 card，也未另拼图片 HTML。
3. `theme/default/i18n/zh/settings.json:capabilities.dep.state` 及英文 pack：补 `unresolved` 分支，保留 id 插值。建议含义为“{0}（状态待确认）”。现有分支只有 missing / off，真实 API 不返回 off；missing 的名字已能完整显示，unresolved 仍需此映射。
4. `theme/default/views.js:page.market` 的 manual_ui 主按钮：当前 act=mkOpenUi 只在 `prototype/proto/demo.js` 有空实现。真实 InstallPlan 只有 manualSteps / metadata，没有设置地址；上游 install-plan-detail 的 manual_ui 也不可执行。应去掉可点击触发，保留步骤，或声明已存在的真实目标后再绑定。未注册无效果 handler。
5. `theme/default/views-settings.js:SYSTEM_SECTIONS`：
   - network.frontendUrl 从常量“自动检测”改读 `$.env.frontendUrl`；storage 的 transcript 行从常量路径改读 `$.env.transcriptDir`。
   - LAN / preview / memory 的 `toggle s.sysVals.*` 改只读状态，或按真实 runtimeEditable 的环境编辑动作声明；这些开关在 API 中均 runtimeEditable=false，不能只改本地当成服务端已保存。
   - ttl 的三个 select 改读 system.config.variables 内 MESSAGE_TTL_SECONDS / THREAD_TTL_SECONDS / TASK_TTL_SECONDS 的 currentValue / defaultValue、readonly / restartRequired；真实单位是秒，默认 604800，不是只有 forever / 90 / 30 天可选。
   - log 的 LOG_LEVEL（info/debug/warn/error）、CLI_TIMEOUT_MS（毫秒）同样按真实元数据只读；不用 normal/verbose/errors 和分钟枚举冒充。curated API 没有 logKeep 或日志目录字段，移除其模拟控件 / 固定日志路径，不能虚构值。
   - safety 从同一份 config.variables 读取 PROJECT_ALLOWED_ROOTS / PROJECT_ALLOWED_ROOTS_APPEND / PROJECT_DENIED_ROOTS / DEFAULT_OWNER_USER_ID；保留后端缺省元数据，去掉固定“未设置 / 单用户”内容。
   - 数据目录的“更改”还是 noop，reveal 缺真实目标参数；应移除不支持的操作，并给可执行的 reveal 绑定具体目录。更正（trial3 全页核对）：logsExport 仍是 proto/demo.js 的演示桩，当前 API 没有完整日志导出接口；本轮原先将它判断为真实动作有误，未补假 handler。

检查覆盖：执行胶囊给出有限秒数且不再 NaN；用户 ImageContent 的 gallery 数量 / 媒体源；三项依赖合并且保留真实状态；四个健康 market source 不进警告、CLI / manual_ui 的生态和分组、真实 degraded 回执；系统页真实端口 / 目录 / 布尔值、完整环境计数、按需仅一次读取；同一系统变量重读只变更其 id，其余对象引用保留。环境设置原测试由“调用 read action”改成断言实际 endpoint 被请求，原始数值 / 脱敏 / 拒绝保留草稿的断言不变。

最终检查：

```text
pnpm -C packages/web exec tsc --noEmit --incremental false
exit 0 (no output)
pnpm -C packages/web exec vitest run src/pdl
 Test Files  68 passed (68)
      Tests  677 passed (677)
   Duration  81.02s (transform 4.78s, setup 624ms, import 19.04s, tests 108.90s, environment 13.92s)
pnpm -C packages/web exec next lint --dir src/pdl
exit 0
next lint: 0 errors, 56 warnings
pnpm exec biome check <13 changed application/test files>
Checked 13 files in 698ms. No fixes applied.
Found 981 warnings.
Found 130 infos.
exit 0
privacy-grep = 0
git diff --check: exit 0 (no output)
```

隐私核对范围：`public/pdl`、`public/pdl-app`、非测试 `src/pdl`，沿用前轮的本机标识 / 实例标识模式。没有添加检查规则、依赖、后端接口或前端兜底。
