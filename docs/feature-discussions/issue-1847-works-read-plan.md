---
topics: [works, performance, thread-index]
doc_kind: plan
created: 2026-11-05
tips_exempt: "2026-11-05：既有作品入口的读取性能修复，不增加用户操作或新配置。"
---

# Issue #1847 作品读取优化方案

状态：经宪宪两轮独立源码讨论后实施；主仓目标 `next`。标题投影所需的配套插件改动已在独立工位准备，跨仓提交授权待确认。三项按结果分别验收，尚未宣告 issue 完成。

公开需求：[Issue #1847](https://github.com/zts212653/clowder-ai/issues/1847)。不代替 #1813 原安装窗口卡顿验收，不部署，不修改界面设计。

Architecture cell: `collaborative-content-plane`（内容事实与授权）、`thread-chat-surface`（共享展示订阅）、`plugin`（沿既有插件路由读取）。Map delta: none。新增候选索引和浏览器 store 均属于原模块内部实现，不引入第二套版本、权限或 PR 记录权威，不改变归属边界。

## 当前调用链与失败

- `threads.ts` → `WorkCatalogue` → `LivingWorkService.withCatalogueRead` → `catalogue-read.ts`：遍历全 owner manifests，再过滤线程，消费后再次全量遍历校验。
- 带媒体的线程还会经 `GlobalArtifactWorkLineageResolver` → `findSourcePublicationsBatch` 做第三次遍历；因此索引覆盖来源坐标，不能只优化不带媒体的夹具。
- `threads.ts` → `readArtifactPrTitles` → `pluginPrTitleReader`：作品 GET 等待插件 HTTP 路由，后者可能查询 GitHub。
- `HeaderCounts`、`ThreadWorksPanelV2`、`HomeWorksSummary` → 各自 `useThreadArtifacts(threadId, 'works')`：各持状态、刷新订阅与请求。

## A：原 content owner 内维护线程候选索引

- 索引只保存 `(ownerUserId, threadId) → contentRef`，不复制 revision、权限或版本正文；canonical manifest 继续是唯一内容事实源。
- 来源索引保存 `(ownerUserId, sourceRef, artifactRef) → contentRef` 候选，具体 revision 继续匹配原 manifest 的历史记录。两类索引放在 `projects/content-owner-index-v1/`，与 canonical 根目录并列。
- 原提交链在 canonical publication 生效前原子登记候选。每个 contentRef 独立文件，避免并发作品覆盖同一索引文件。登记失败则发布不继续；发布失败留下的候选没有 canonical state，不会成为作品。
- 线程读取只枚举该 bucket，读取对应 canonical manifests；最终重读同一线程候选与版本集合，保留 `publication_changed`。版本读取与最终授权继续沿原 owner。
- 读路径等待一次完整旧数据迁移，成功后才写版本化 ready marker；中断后可重做，失败 promise 不永久缓存。写入只登记自己的候选，不依赖旧目录迁移健康；正常冷启动复用磁盘索引。迁移成本与常态读取分开记录。
- Collective 快照 schema 不含作品或 source publication，沿原路径处理，不增加无效索引挂钩。沿用原 owner 的单写进程与 content 锁，不增加跨进程 writer 协议。
- 并发初次发布、修订、预登记后发布失败、迁移中断、冷恢复、撤权和错误出口均需实证。

## B：标题从既有 PR 事实投影，作品 GET 不访问 GitHub

- 复用 GitHub 插件已有 `SdkCommunityPrStore`；观测与后台查询更新原 PR 记录的 title，不新增宿主标题权威，不覆盖原 review/route 字段。
- 主仓 reader 通过既有插件路由的 `mode=local` 只读本地记录，缺失显示 ref，包括只有 Task 标题的 PR 产物；后台补取失败时继续显示 ref。旧插件严格拒绝新参数时，作品请求不转去查询 GitHub。
- 前端共享数据加载完成后独立补取缺失标题，最多 20 条、4 并发、每次 5 秒；失败保留一分钟的有界负缓存。成功更新共享展示，不额外重读作品列表。
- 配套插件沿原 collector 回写标题；账号凭据与请求授权继续由插件处理。插件 PR 的提交、版本发布和安装分别记录，不把源码存在写成当前实例已更新。

## C：每 owner/session、thread、view 共享作品数据

- 共用一份外部 store 和在途请求；三个消费方仅订阅与派生，复用当前 API session generation 隔离身份切换。
- 共享 material/终态失效入口，同一作品变化合并为一次请求；纯文字片段与无作品的普通工具活动不刷新。
- 复用现有作品/Task 失效通知，保留线程切换、显式重试、草稿和排序语义。取消一个消费方不取消其他消费方需要的读取。

## 验证与交付

1. RED：真实 owner/route 入口，固定目标线程作品量，其他作品扩大十倍，记录 manifest/目录读取和耗时；多消费方同时挂载的请求次数；作品 GET 中插件/GitHub调用次数。
2. GREEN：同一入口复跑；记录线程读取不随其他作品增长、GitHub 调用 0、纯流式请求 0、作品变化三个消费方共 1 次读取。
3. 边界：owner/撤权、准确版本、冷恢复、并发修订、失败出口、线程切换和旧线程后台活动。
4. 宪宪讨论方案并审查最终提交；作者砚砚实施，提交目标 `next` 的 PR。实现与证据完整后才报告三项完成；本任务不含合入或部署授权。

## 讨论记录

- 砚砚：建议用原 owner 的候选索引与 canonical point reads，避免第二套 head/revision 状态机。
- 宪宪第一轮：补齐 lineage 第三遍扫描，确认 owner store 归属、publicationScope 不变与旧数据迁移边界；反对用 recentArtifacts.label 冒充标题事实。
- 宪宪第二轮：读路径迁移失败应拒绝，但新写入不能被旧坏目录拖垮；失败 promise 要能重试；删去无效 Collective 快照挂钩；补提交 rename 窗口及真实 HTTP 带媒体计数验证。以上已采纳并验证。
- 实现审查：移除消息流结束的重复失效，只保留调用终态和真实 material 变化；作品列表不再新增无范围的 review 事件订阅，review 界面沿原更新链。完整文本/工具轮次和双线程 review 事件先复现失败，再由同一用例验证修正。
- 跨仓插件提交属于原 `next` PR 之外的新增交付边界，已单独请求确认；A/C 继续原授权工作。

## 证据与回退边界

- 基线 RED：固定 3 件目标作品，其他作品 10→100 时，canonical manifest 读取 32→212、root 遍历均 2 次；独立来源查找读取 31 份 manifest。
- GREEN：常态目标线程读取 12→12、root 遍历 0；来源查找 1 次；真实带媒体的线程 HTTP 请求 17→17、root 遍历 0、作品总数保持 4。耗时只是同一合成环境的辅助记录，不作安装版性能承诺。
- 前端 RED：三个真实消费方 3 次请求，新增纯文本仍多读一次。共享实现的组件测试及无头 Chrome 流程验证初次 1、作品变化 1、流式文本 0、旧线程失效 0。
- 审查后完整轮次验证：纯文本消息结束 0、无作品变更的 review 事件 0；调用终态由三个消费方共享 1 次读取。Recent 的首次迁移与预热单列 34 次 canonical 读取，随后 12 件/3 件结果的请求分别 66/48 次，不混入常态预算。原故障注入已迁到线程读取入口，仍保留 unavailable 和 `publication_changed` 断言。
- 原 canonical 数据和版本注释不迁移、不删除；回退源码即可恢复旧读取方式。若降级后的旧写者又发布新数据，重新启用索引版前须重建派生索引；旧写者不维护该索引，不能直接沿用旧 ready marker。
