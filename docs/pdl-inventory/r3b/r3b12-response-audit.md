# r3b12：宿主响应类型核对

范围：`packages/web/src/pdl/` 中手写的成功响应 DTO、内联 `request<T>`／`write<T>`／`canonCommand<T>`、直接 `response.json()`，以及它们复用的 owner DTO。只列实际消费的字段；纯 UI 状态、组件 VM 和 React hook 快照不是新的后端响应。逐个对照本 worktree 的 API 路由和 shared 类型；没有以演示数据补字段。

## 核对与处理

| 宿主响应／入口 | 真实 owner 证据（仓内路径与行号） | 可空、缺省、错误处理／结论 |
| --- | --- | --- |
| `owner-api.request<T>`／`write<T>` | `src/pdl/owner-api.ts`；API 各路由的非 2xx `{ error: string }`／`{ error: { code, message? } }` | 成功与错误在 HTTP 边界分开；204 无 JSON；错误 body 可以为 null。本轮统一提取 string／message／code 后拒绝，不把 envelope 交给 VM。成功记录内的 `error`（如额度诊断）不被误判为整条请求失败。新增真实错误形状回归。 |
| `GitData.status`／`GitFile` | `packages/api/src/routes/workspace-git.ts:256`；`packages/web/src/hooks/useGitPanel.ts` | 改为复用 `GitStatusResult`；三个文件数组由后端返回，不可空。非 Git 工作区的 HTTP 错误进 load:error。 |
| `GitData.log`／show | `packages/api/src/routes/workspace-git.ts:226`、`:286` | 线上的 log 只有 `GitCommit[]`，show 是 `CommitDetail`；本轮复用原 hook 类型；客户端聚合完 show 后才拥有 `files`，不再把客户端补全字段写进线上的 log 类型。 |
| `GitData.health`／`RuntimeDrift` | `packages/api/src/routes/workspace-git.ts:190`、`:317`；`packages/web/src/hooks/useGitHealth.ts` | **保留 lang 已修的 null**：没有 runtime 路径返回 null；配置但读失败是 available:false。改为复用 `GitHealthResult`，VM 在一处整理漂移文字和 behind；null 不制造一条未知漂移。新增与真实 null 回包一致的回归。 |
| `WorkspacePatch` | `packages/api/src/routes/workspace.ts:543`、`workspace-diff.ts:6` | changedFiles／diff 为成功响应的数组／字符串，文件 path/status 都由解析器给出。失败不作为空 diff。 |
| `FileData`／file-info | `packages/api/src/routes/workspace.ts`、`workspace-file-actions.ts`；原 `useWorkspaceFile`／file-action owner | 复用既有 FileData 与权限读取；截断、mime、sha256、动作允许项沿原契约。非文本仍未完整绑定；不以不存在的正文伪造预览。 |
| edit-session `{ token, expiresIn }` | `packages/api/src/routes/workspace-edit.ts:42` | 成功两项都存在；4xx／5xx 在 request 边界拒绝，writer 不从错误 body 建租约。 |
| tasks `{ tasks }`／`TaskItem` | `packages/api/src/routes/tasks.ts`；shared TaskItem | 数组不为 null；ownerCatId／subjectKey 本来可空，沿 shared 类型。CAS 错误不更新本地 ownerRevision。 |
| native reviews `{ reviews, nativeTargets }` | `packages/api/src/routes/native-thread-review-routes.ts` | 两数组始终存在，nativeTargets 确实是 `{catId}[]`，并非 review target 的判别联合；保留正确的读 DTO，写 target 继续用 shared review 契约。 |
| `JobRead` | `packages/api/src/routes/callback-hold-ball-cancel-routes.ts:182`、`:410`；`domains/managed-job/ManagedJobService.ts:236`；`domains/ball-custody/managed-command-wake-task-projection.ts:36` | job 在非 full／非 managed command 时缺省；读边界先核 task/cat/createdAt/full access。command 由 definition?.command 得到，本轮标可省略；result 可省略，但存在时 durationMs 必有、exitCode 为 number|null；本轮类型如实对应，null 不展示退出码、0 正常显示。宿主明确请求 tailBytes，才将 transitions 视为该成功请求的必有数组。 |
| `{ sessions: SessionSummary[] }` | `packages/api/src/routes/session-chain.ts:333`；shared SessionRecord／既有 SessionSummary | 不新写第二份会话 DTO；compressionCount 可空、usage／contextHealth 可省略，沿 owner 类型及当前 projection。 |
| invocation list／`InvocationDetailResponse` | `packages/api/src/routes/session-transcript.ts:311`；shared InvocationTrajectorySummary／InvocationDetailResponse | summary 可省略，身份核对在存入 detail 前拒绝缺少或错配的 summary；events 为数组。没有从 absent summary 读字段。 |
| external sessions list／detail | `packages/api/src/routes/external-runtime-sessions.ts:233`；既有 external-runtime-session-types | 真实绑定始终由 record 或 inferBinding 给出；model、title、runtimeConversationId 可省略；compressionCount、hybridProgress 可空。复用原 owner DTO；不以虚构 optional binding 掩盖不完整的 fixture。 |
| external chat page（exec） | `packages/api/src/routes/session-transcript.ts:205` | messages 始终数组；超大消息缺 content，现有 exec 投影先识别 oversized；nextCursor 只在有下一页时出现，不是 null。 |
| `RuntimePage`（ops chat） | `packages/api/src/routes/session-transcript.ts:214` | 本轮改为普通消息／超大引用联合。超大引用只有 role/eventNo/contentLength/drillDown，没有 content/timestamp；在 VM 一处整理文字，不产生 Invalid Date。 |
| `RuntimePage`（ops handoff） | `packages/api/src/routes/session-transcript-response.ts:66` | **本轮修真实崩溃**：超大引用省略 toolCalls/keyMessages/durationMs/errors。以前 models() 按完整摘要展开数组会抛错；现在按判别联合整理，不伪造完整摘要。超大来源的进一步钻取尚未接。 |
| `RuntimePage`（ops raw） | `packages/api/src/routes/session-transcript-response.ts:6` | 正常原始事件与 oversized 引用联合；raw 页保留真实 JSON；游标保持真实 eventNo。 |
| `Totals`／`Usage` | `packages/api/src/routes/usage.ts:37`；`domains/cats/services/usage-aggregator.ts:9` | 宿主是实际 report 的字段子集；grandTotal 和 daily、每日 cats 及数值均必有，0 是合法值。无 scanAll 返回 501 error，已在 request 拒绝。 |
| `Tools` | `packages/api/src/routes/tool-usage.ts:36`；`domains/cats/services/tool-usage/ToolUsageCounter.ts:23` | summary/topTools/daily/byCat 都必有；缺省过滤参数在服务端处理。宿主未使用 mcpServer／period，无须编造这些字段。 |
| `QuotaResponse` | `packages/api/src/routes/quota.ts`；既有 quota-data／quota refresh helpers | activeBlock、burnRate、projection、lastChecked 的 null 原类型已覆盖；各 provider 的可选 error 是数据事实，保留在现有额度 projection。 |
| `AccountsResponse`／`ProfileItem` | `packages/api/src/routes/accounts.ts:107`；accounts-view／shared AccountQuotaObservation、CodexManagedAccount | providers 必有；nativeDefaultsError／unavailableAccounts 可省略；quota、modelOverride 等沿复用 DTO 的 optional／null。错误 HTTP 状态先拒绝。 |
| `HealthData`（特殊 503） | `packages/api/src/routes/telemetry.ts:191` | degraded 的合法健康响应也返回 503，不能一律丢弃；traceStore/metricsSnapshotStore/errorRate 的 null 原 DTO 已有。本轮显式区分 `{error}` 和 HealthData，前者转 load:error，后者保留。新增回归，并保留现有合法 503 检查。 |
| `{ variables: EnvVar[] }`／metrics snapshots | `routes/config.ts:330`、`routes/telemetry.ts`；既有 observability-helpers | currentValue 可空、allowedValues/runtimeEditable 可省略，沿原 DTO；snapshots、variables 成功总是数组。VM 不从 null 构造下拉选项。 |
| `CallbackAuthSnapshot` | `routes/callback-auth-debug.ts:103`；既有 `useCallbackAuthSnapshot` | 复用 owner DTO：基础计数和集合必有；legacyFallbackHits／lastViewedAt／unviewedFailures24h 可省略，沿原投影。 |
| agent sessions／governance／brake／rescue | `routes/terminal.ts:309`、`capabilities.ts:968`、`brake.ts`、`claude-rescue.ts`；shared 及既有无 JSX DTO | 快照数组、GovernanceHealthSummary、BrakeSettings、ClaudeRescueSessionItem／RunResult 沿真实 owner。可选 detail/cwd/时间不当必填；现有操作先验 checksum／409 回读及逐项结果保留。 |
| preview status／target-health | `packages/api/src/routes/preview.ts:149`、`:304` | available/gatewayPort 和 reachable 在成功响应必有；拒绝目标返回 reachable:false＋reason，非 null。HTTP error 不进入 src。 |
| preview open `{ allowed, reason? }` | `packages/api/src/routes/preview.ts:174` | allowed:false 是正常业务结果，保持现有分支；不是 HTTP error。reason 可省略。截图／admission／frame message 继续沿既有 owner 校验，不改可信 origin。 |
| terminal status／session／DELETE／agent panes | `packages/api/src/routes/terminal.ts:53`、`:88`、`:206`、`:231` | 成功 status 必有 available；session 必有 sessionId/paneId/reconnected；DELETE 有 ok。agent panes 为数组，501 表示没有该能力，现有读取处一次整理为 []；其他错误先拒绝。TerminalRead／TerminalOutput 是客户端通道状态，不冒充线上的 DTO。 |
| `BoardThread` | `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts:216`；threads route | title 真实为 string|null。本轮用现有 Thread 的 Pick，去掉错误的 title?:string 手写副本；VM 原来已有空标题整理。 |
| Backlog／FeatureDocDetail／WorkflowSop | `routes/backlog.ts`、`feature-doc-detail.ts:31`；shared | 复用 shared；不存在 doc 的 404 在读取处一次排除，不是缺字段的 detail；SOP 的 404 一次整理为 null。 |
| `EvaluationRead.cats` | `packages/api/src/routes/eval-hub.ts:113` | catId/handle/family 是 roster 投影必有字符串；不新增兼容缺省值。 |
| eval summary／duty／paw inbox | eval-hub、paw-feel 路由；shared PawFeelDutyConfig／PawFeelInboxPage | duty.config 明确可空，沿现有读取；PATCH 成功必有 config。summary 沿既有 EvalHubSummary，可选 metricGlossary 已由投影处理；paw 的 degraded/不可用在原 isPawFeelInboxPage 边界拒绝。eval 自动调度开关没有 writer，本轮 r116 原样删除声明及 ENT.dom，不再待定。 |
| memory `Page`／`Entry` | person-memory-owner-read、profile-memory-owner、entity-memory-owner；既有 owner-memory-read、people-types、taste-types | Entry/Page 是五种 owner 的最小聚合，不是完整 wire DTO；列表先沿 isPeoplePage/isMemoryEventPage/isProfileBrowse/isEntityBrowse/isTasteBrowse 拒绝 unavailable/readStatus 错误分支。revision 不是人物列表必有字段，本轮标可省略。 |
| 人物 detail／source | `person-memory-owner-read.ts:151`；people-types | 人物返回 personRevision，没有 revision；本轮在详情读取边界一次投影为统一 revision。message 来源 title 可为 null，在 VM 一处用真实 threadId 标识无标题来源；source unavailable 仍有空 sources，不制造一条来源。 |
| 画像／实体／事件 source | shared `types/memory-owner-lifecycle.ts:211`；profile/entity/event-memory-source | occurredAt 可为 null；本轮 source 类型复用真实 DTO，时间只在非 null 时格式化，0 仍合法。label/message 坐标沿实际判别形状，不把没有坐标的来源变成可点。 |
| `ProfileUsageSummary` | shared `types/profile-usage.ts:5`；`profile-memory-owner.ts:103` | recent.threadId 和 earliestRecordedAt 可空；本轮复用 shared DTO。不可见 thread 不提供动作，usage 读取 503 不被当作零计数。新增 nullable 时间／私密 thread 回归。 |
| taste detail／source | `routes/taste-browse.ts:37`、`:83`；既有 taste-types／canOpenTasteSource | takeaway、recall、candidate 及 recall.search/namedDelivery 可空，status 可省略；本轮聚合字段取原类型。来源 title 可空，canOpen 必须同时有真实 thread/message，现有 owner guard 成功才整理成来源行。 |
| memory action receipt | profile/entity/person/event/taste owner lifecycle actions；shared MemoryOwnerActionReceipt；person-memory-owner-action-contract.ts:56 | action/outcome 必有；一般记忆的 memoryId 必有，人物回执没有 memoryId，统一最小投影不消费它；revision 可省略；hard forget 不要求后续详情，其他变更按真实回执版本回读，不以 applied 代替持久效果。 |
| review `Context` | shared `types/artifact-review.ts:298`；`routes/artifact-review-routes.ts:18` | 本轮用 PreparedMediaReviewContext 取代手写带任意索引的 Context，真实 title 必有，源身份字段随共享判别联合；没有为主题补假 source。 |
| review history | `artifact-review/service.ts:288`；shared ArtifactReviewAuditEntry | entries 必有；每项 receipt.createdAt 必有；nextCursor 明确 number|null。原最小读类型准确，不改。 |
| ArtifactReviewView／modification choices/detail/submit | artifact-review-routes、content-modification-routes；shared | 复用原 schema／owner controller；selected round、reference、source、requestId 先由 owner 验证；写回读的 JSON 错误不当成 detail。submit 的 record.requestId 是成功结果必有。 |
| document selection／WorkspaceContentReviewView | `content-modification-routes.ts:69`；shared 与既有 useWorkspaceContentReview | selection 仅 attached 成功结果有；歧义／不可绑定为 409，先拒绝，类型不假装这时也有 selection。正文和 media source 的 null 沿 owner hook。 |
| canon `History`／CanonPage／AssetCanonItem／WorkContextRecord | `asset-canon/service.ts:31`、`:48`；shared 与既有 asset-canon-client | 底层 store history 的 record 可以缺省，但该读取服务已过滤 `!event.record`，所以宿主此处 record 必有是准确的；reason/recordedAt/nextAfter 仍可省略。已授权文件不可用沿原 item.fileState，不伪造 source。 |
| film ProjectSnapshot／ScreeningDescriptor／review view | 既有 video-project/api、project-review-read；shared VideoProjectScreening | 非手写新 wire：原 schema 校验＋contentRef/ownerRevision/blobDigest/URL 身份核对，nullable review／unchanged 分支沿原 reader。FilmUi/Preview 是 VM。 |
| signals note `{content}`／discuss `{threadId}` | `routes/signal-study-routes.ts:72`、`:146`；`utils/signals-api`／shared StudyMeta | 成功 note.content／讨论 threadId 必有；不存在／未就绪走非 2xx。其余 source/article/stats/timeline/collections/podcast 沿既有 client DTO，可选 note/podcast 在并行取数处处理。 |
| team routing／evolution／schedule／replay | 原 routing-context client、evolution-program-resource、schedule controller、story-player reader | 本轮没有第二份响应 DTO；原 reader 的 schema、CAS、身份核对、缺省／不可用分支保留。TeamUi/EvolutionUi/聊天数据不是后端响应。 |
| runtime questions／thread/handoff proposals／rich | shared RuntimeInteractionRecord、ThreadProposal、SessionHandoffProposal、RichBlock；既有 producer readers | 使用原解码／schema 和 owner/session/thread/message 核对；pending record、publication、terminal、block state 的 optional 沿原类型；不以批准状态当真实效果。 |
| services `{services:HomeServiceState[]}` | `packages/api/src/routes/services.ts:49`；既有 service-ui-adapter | endpoint/error 可空、prerequisites/model/port 可省略，沿原 DTO；未安装／不可用是 status，不重复 toast 或高频 audio 重试。 |
| `MeetingShare`／`ShareIntent` | `domains/concierge/meeting/f317-meeting-share-service.ts:19`、`:94`；f317-meeting-admission | 成功是 unavailable 或 available 判别联合；后者才有 intent/catId/inputLabel/sharing，intent 字段完整必有。宿主类型一致，来源撤销后不保留旧分享。 |
| `Call`／transcript／screen receipt | `domains/concierge/live/live-call-status.ts:9`；concierge-live 路由 | status 的 callId/threadId/catId/state 必有；answer 仅 start 回包提供；transcript.messages 总是数组；screen accepted/stopped 是成功布尔回执。复用已有呼叫状态枚举的值，无 null call 伪记录；客户端 call 本身可空。 |
| audio status／sources／lines／`StopSummary` | `packages/api/src/routes/audio-proxy.ts:33`、`:115`；`audio-controller-lease.ts:86`；既有 audio-transcript-contract | **仓内边界限制**：后端对外部音频服务成功 JSON 使用 unknown／透传，没有成功 DTO，不能据此证明所有上游字段必有或可空。宿主沿项目已有 audio-transcript-contract；StopSummary 只用可选保存路径，summary 缺省不展示保存结果。没有推测新的 null 含义或到处补 ?.。后续建议由音频 owner 提供成功 schema／DTO；本轮没有真实音频服务验收；这是仓内类型核验的边界，不因此新增接口或停其它绑定。 |
| PdlAppHost facade 与不消费 body 的写动作 | threads/messages/queue/export 路由；request 及 downloadPayload | 不新写 VM 响应；接口错误不产生成功状态，真实写后读原 owner。二进制导出仍由 downloadPayload；导出失败只在动作回执中报告，不进入 models。 |

上表中 `src/pdl` 的简写均指 `packages/web/src/pdl`；其余省略 `packages/api/src` 前缀的 route/domain 路径按同一根目录查找。完整调用清单由本轮临时 TypeScript AST 盘点后逐条对照，不新增 lint 规则、登记层或响应兼容层。

## models() 故障传播：现状与建议（没有实施隔离）

`ProjectDataBinding.tsx` 的 models() 直接调用并合并所有工具的 models；`PdlAppHost.tsx` 的 port.models 在引擎更新时调用它。任一工具投影抛错都会中断整个聚合，React 的更新链可以进入 Next 的整页 Application error。当前即使没有打开那个工具，它的 models 也参与聚合。

本轮只修真实类型／边界错误，并加对应 owner 回包回归；**未加全局 try/catch、error boundary、统一空 VM 或旧 JSX 兜底**。建议先保持准确 DTO 和单处整理；若要将程序错误限制在某个视图／工具，需要 lang 先决定错误由哪一层、哪个现有组件表达，再回原型定义作用域与声明，复制后接。不能由宿主吞掉异常后继续给出貌似成功的数据。
