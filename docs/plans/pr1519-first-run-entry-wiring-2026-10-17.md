---
feature_ids: [F155, F320]
topics: [onboarding, guide, persistence]
doc_kind: implementation-plan
created: 2026-10-17
---

# 新版首配到 F155 入口提醒的接线

来源：#1466 第8步要求真实主界面提醒成员/密钥、复用F155、不挡第一句话；用户要求完成完整旅程。上一轮已证实新版members创建路径不产生旧bootcamp状态，不能依赖旧触发器。

## 契约

- 沿用`UserPreferences.onboardingGuides`的严格reader/原子updater及session身份。为`first-run-entry-v1`增加pending回执，和collaboration-v1演示回执分键；不是第二个存储owner或引导引擎。
- 新的零角色草稿记录首次名单为空；已有草稿无法证明时不推断。非空名单、旧用户、零选择不登记提醒。部分创建/刷新仍保留原旅程身份。
- 首次创建前幂等登记pending。完成/关闭为终态，重复pending不能重新打开；演示完成记录、其他用户和未知配置原字保留。偏好损坏时503，不覆写成新用户。
- 主界面且已有角色、无演示/其他引导时才消费pending。复用F155 flow、overlay、完成/退出语义；离开页面或引擎异常不冒充用户已完成。非阻塞提醒不改变焦点、输入、发送或shell。
- flow只说明设置入口中的成员与密钥，用classic/v2共有的hub.trigger定位。不依赖用户保留pin，不新增侧栏入口，不改变pin默认策略或用户历史pin。
- 完成须原个人偏好接口ACK，并交回F155的完成确认状态；不向共享default线程登记或完成个人提醒。主动退出记录dismissed。个人回执保存失败显示非阻塞重试，刷新后允许重新提示，不静默吞掉写失败。

## 改动与验收

1. config-onboarding原owner增加entry读写路径，session-only，状态单调；RED为当前404，再验证用户隔离、损坏偏好字节不变及原演示接口兼容。
2. useNativeOnboarding补首次名单标记与登记；验证0/1/N、旧名单、旧草稿、部分失败、重试不重复创建，提醒不依赖模型调用。
3. 新的FirstRunEntryReminder组件消费回执并调用现有guideStore；ChatContainer仅接组件。单测覆盖在设置/演示中不触发、未登记不触发、其他引导不被顶掉、刷新恢复、完成ACK/退出/失败重试。
4. 调整已有first-run-entry YAML并校验registry/tag；已有非阻塞overlay测试继续保护键盘和点击。
5. 真实生产页面故障矩阵与新首配→返回主界面旅程；安装版另核实际F155定位与发送不被拦。新源码与旧0927安装包分开报告，未重新构建不得移植旧包验收结论。

## 本轮增量与证据边界

- fac实际新首装已暴露原方案的owner接线错误：共享default无offer，start409被best-effort忽略，complete400导致个人回执永远无法确认。此失败保留，不通过放宽共享offer/访问守卫修复。
- 后继源码让FirstRunEntryReminder直接以原session-owned个人接口ACK确认F155完成；useGuideEngine仅对已知first-run-entry避免线程级start/complete，其他flow保持原合同。写失败清除本次未确认的内存完成标记、保留重试；迟到ACK按sessionId不能确认新引导，退出不会降级完成记录。写入10秒超时，不影响聊天输入。
- 新的真实API路由集成检查先在旧组件观察到4个正确RED，修复后7项通过：共享offer仍409、个人完成/重开回读、其他用户隔离、损坏偏好503且字节保留/修复重试、foreign共享状态不变、导航非退出、迟到ACK及退出竞态。HTTP传输与认证身份是测试夹具，原子偏好文件及路由/状态机是真实实现，不声称Redis/安装版认证验收。
- 此集成入口独立为test:first-run-entry:api，Build lane在显式API构建后执行，不让轻量Web单测依赖预先生成的dist。生产浏览器四场景也改走真实个人/引导路由并接入同一Build lane；其他页面HTTP与session身份仍是夹具。两套页面的新构建和安装包均需独立验，不能沿用旧纯HTTP回执夹具的四条绿灯。
- 当前首启/成员48文件245项、原有线程引导33项及Web TypeScript通过。初始fixture的Vite URL改写错误与隔离配置include合并误触发的中止记录保留，不计入产品RED或通过数；既有act/故障注入日志警告也不冒称零警告。
- 137完整构建及本机四条生产页面检查通过后，继续核对请求回执发现退出仍经GuideOverlay发送线程cancel。集成探针改为实际Overlay及提醒组件，foreign用户同名共享guide的退出403正确RED；补普通退出/保存失败后的关闭两个入口后，8条真实组件/API集成和26条既有Overlay检查通过。浏览器在完成和退出两类终态均禁止任何线程guide-actions请求；137原实物/源码证据不冒称已包含后继退出修复。
- 137的CI Build新增浏览器步骤暴露WS夹具缺失：连到未监听随机端口，被严格console错误检查拒绝；API集成及实际Web构建在该job均成功。按主线F322相同Socket.IO线协议补显式WS夹具，连通后同时补齐HomeActionHost的窗口lease读写夹具，不屏蔽错误日志、不改变产品网络行为。CI保留截图/回执及fixture偏好文件7天；这些夹具不冒充安装版真实Socket或session认证验收。

- 首次手动创建也通过同一个`prepareFirstRunEntry`登记回执，先写回执再创建伙伴；回执失败保留表单且不产生部分角色。已有/未知名单不推断首次用户。相关24项及最终完整首启成员套件241项通过。
- 引导定义503、空流程、网络失败及10秒超时有非阻塞重试。新增反例证明较旧请求的成功/失败都能覆盖较新引导，现以请求归属保护；相关36项通过，RED/GREEN日志分别保留。
- 手动创建的`onboarding.entry`阶段同时加入前端类型及服务端诊断白名单。原类型检查及API 400反例保留；修复后API完整构建、Web类型检查及22项引导/诊断接口测试通过。
- 新增`pnpm --filter @cat-cafe/web test:first-run-entry:production`，拒绝与当前HEAD不符的生产构建；在真实classic/v2页面覆盖取消全部pin、输入、完成/退出及刷新。HTTP夹具证据与真实服务端偏好/安装版持久化证据分开。测试自行释放浏览器和Next子进程，不接生产API/Redis或模型；输出目录可用`CAT_CAFE_ENTRY_EVIDENCE_DIR`指定。
- 6fa生产页面的初始探测已证明共有锚点、文案及输入可用；完整后继源码生产测试尚待执行。早先夹具缺少callback-auth结构的失败保留，没有为错误夹具修改产品容错。

保留No-Go：本项的生产实页/安装包、适用平台实物验收及维护者正式review不因源码和单测完成而关闭。2026-10-17用户已将原Claude连接案例接受为外部LLM API兼容限制，不再继续追查或作为Clowder代码修复阻塞。此计划不授权修改用户CLI认证或清空任何历史。
