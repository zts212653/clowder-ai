# next3 — 设计 44f2299 batch 2

引擎 / 组件 / 主题 PDL：保留用户复制的 65 个文件，逐字节差异 0；本轮没有编辑复制层。应用只整理真实数据及动作；无后端、依赖或环境改动，未提交 / 推送，未启停服务。

来源随实际投影进入 needed set 才读；保留 held base，重读按现有 by-id receiver 合并。watcher 对话状态沿用 5 秒，只在投影中且页面可见时轮询；suggestion_updated 按 id 更新。

| 项 | 状态 / 应用落点与接口 |
| --- | --- |
| T03 / T04 | 完成。`members.js`、`member-actions.ts`：preferences 读 runtime-models / agent-providers/models，给原始 catalog、model / effort 的选项、标签与来源；pool 默认直接用 shared 的 defaultAcpPoolMaxProcesses（Google 3，其余 20）。 |
| 探测调整 | 完成。nativeAdjust / nativePreference 写回每行 form；创建带 defaultModel / cliEffort，AGY 以 accounts.projectPath 作为受限工作目录（不启用全信任），填模型后可创建。失败给 failedPartner {name,client}，停止后续成员；结果不明时复用原创建请求。 |
| T07 | 完成。`useHomeBindings.ts` / `workbench-data.js`：active store.waits → live.waits 的 hold_ball 行；cancelHoldWait 复用现有取消 writer。 |
| T08 | 完成。`work-details.js` / `content-data.js`：work.pr.target / changes；workPrChanges、prChangesRead / Close。带 threadId 用 chat-pull-request-changes，否则 pull-request-changes；沿用同一个编码 target，diff 整理为通用 hunks。 |
| T09 | 完成。`chat.js` / `PdlAppHost.tsx`：searchMeta / searchError、selection / contentRevision / answerBinding / answerSelection；cafeSearchSource 先 GET evidence/answer 比对完整原行，再跳转或引用原句。 |
| T10 | 无应用改动。HTML 尾部测量已在本次复制的 library/blocks.js。 |
| T11 | 完成。`chat-models.ts`：delivery 的目标并集来自 queued targets 与消息历史 dispatchRefs / appendFailures；核对回复 lifecycle 的 targetId / inputMessageIds，保留 read / uncertain 回执。 |
| T12 | 完成。`members.js` / `plugin-config.js` / `rules.js`：executionApproval；固定单客户端以 defaultClient + overrides 读写，ID / 名称只读、无增删；compiled.identityResolution.fieldSources；memberCloudRestore 带 configurationRevision PATCH cats/:id。单记录失败不推进保存基线。 |
| T13 | 完成。`chat-models.ts` / `PdlAppHost.tsx`：schedule / task / changes / effect / scheduleError / canApproveSchedule；参数描述读 schedule/templates，批准 / 拒绝复用 ScheduleApprovalController；effect 只认匹配的持久 checkpoint。 |
| T14 | 完成。`watcher.js`：watcherSettings / watcherThread 与 configSet / quietLabel / threadSet / nudge；实际 watcher config / thread / suggestions 接口及 revision。宿主转发现有 suggestion_updated。 |
| T15 | 完成。`matters.js`：memoryMatters、分页 catalog/detail/source、edit / append / correct / retire / forget；source 先核验，写入带 expectedRevision，同 requestId 重试不明结果。 |
| T16 | 完成。`work-details.js`：作品精确版本 cover / candidates / 上传 / 帧 / 恢复；同 operationId 重试，409 重读 cover revision，跟随已有封面 / 作品变更事件刷新。 |
| T17 | 完成。`chat-models.ts`：原样提供 extra.cliDiagnostics、metadata.provider（包含 Pi）、watcher 来源；组件决定展开与格式。 |
| T18 | 部分。`chat.js` / `owner-projections.js` 已透传 rank / relevance；当前 memory/search 返回不含这两个字段，未造排名或标签。详见下文。 |

删除被替代的 form.models / modelUnlisted / modelNeedsProvider / cli / required.model 及 schedule 卡的 operation 显示字段、旧通用批准显示字段。成员 catalog / 插件配置读取移到 sources:needed，VM 不发请求。宿主 API 门面正确传递 PUT / PATCH / DELETE，错误边界保留原始 status / code，供 revision 与不明写入处理。

看得见的变化：成员模型来源与探测调整、执行中的 held-ball 等待、PR 变更、搜索原句 / 转引 / 批注、逐目标队列回执、日程更新对照、守望配置与提醒处置、matter 记忆及作品封面，均由复制的声明绘制。未做真实浏览器验收。

验证保留原意：模型 datalist 断言改为 catalog 的真实 select 标签 / 来源；探测假数据使用完整 form / CatData，并验证 model + effort、失败成员 / 客户端及首错停止；固定单 / 多客户端分别验证原始写入、revision 冲突与草稿。新增行为覆盖 PR 目标、搜索复核、队列回执、日程 checkpoint、Pi、matters / cover 的幂等重试及投影读取。

```text
pnpm -C packages/web exec tsc --noEmit
exit 0 (no output)
pnpm -C packages/web exec vitest run src/pdl/__tests__
 Test Files  68 passed (68)
      Tests  675 passed (675)
pnpm -C packages/web exec next lint --dir src/pdl
exit 0; 0 Error lines / 56 Warning lines
pnpm exec biome check <27 changed application/test source files>
Checked 27 files in 696ms. No fixes applied.
Found 1608 warnings.
Found 174 infos.
exit 0
i18n references = 50; unique = 34; missing keys = 0
copied files = 65; byte diff = 0; extra = 0; missing = 0; mock/proto/local = 0
privacy-grep = 0
git diff --check: exit 0
```

未完成 / API 缺项：T18 的 `/api/memory/search` 在 `packages/api/src/routes/memory-search.ts` 将各类搜索映射成统一结果时未输出 rank / relevance。`routes/evidence.ts:474–475` 的文档证据搜索有这两项，但不能拿另一轮查询的顺序拼入本轮统一结果。本轮不改后端；现有字段仍按原顺序显示，无伪造值。没有组件 / 样式阻塞。T19 / T20 按本轮范围跳过。

语言键检查覆盖 app 静态 tc / t: / {t:…}；privacy-grep 覆盖 public/pdl、public/pdl-app 与非测试 src/pdl。检查配置未改，未增加持久检查规则。
