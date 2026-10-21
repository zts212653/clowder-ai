---
feature_ids: [F309, F326]
related_features: [F138, F232, F063, F307]
topics: [living-artifacts, works, versions, production-authority]
doc_kind: contract
created: 2026-10-20
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f309-living-work-entry-contract.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f309-living-work-entry-contract.md"
    toolName: cat_cafe_work
    resourceFamily: collaborative-content
    boundaryKind: resource-entry
    decision: accepted
---

# 作品的共同创建、显式续版和固定引用

产品范围来自 Studio Human `private-source-id`（视频与其他活的作品对齐）及 `private-source-id`（已有片子接入、直接批注与集中查看素材），接受源为 [F326 spec](../features/F326-editing-desk.md) `a44251c1cab09a22b4ac5aeab95970990f7f940f`。共同入口由原 F326 执行责任在 #5799 串行定型；#1621 协同源 `private-source-id` 已确认没有并行 DTO。工具名和此资源边界属于上述已接受范围内的实施选择；本登记不代表独立审查、合入、HTML 写口或 C 验收已完成。

`cat_cafe_work` 接同一 content owner，唯一作品坐标为 `contentRef + ownerRevision`；工具没有影片专用主身份、独立版本库或渲染执行权。共享 DTO 位于 `packages/shared/src/types/living-work.ts`。当前注册 MP4 的 F063 格式入口；HTML/PPT/文本仍须各自真实的载荷与安全准入，不能因为共享名字就绕过原边界。

| 操作 | 输入和真实结果 |
|---|---|
| inspect-source | 已登记 Workspace 根的 locator；F063 返回真实 digest、字节数和同一冻结视频的实际媒体时钟，不接受任意宿主绝对路径 |
| create | 稳定 operationId、标题、改动说明和冻结源；F138 保存第一版并形成唯一回执，不要求先发消息、建 Task 或补脚本 |
| submit | 原 contentRef、expectedOwnerRevision、operationId、真实新源和改动说明；同 ref 显式 CAS，不按同名/改名合并或拆分作品，同字节不推进影片版本 |
| read | 精确固定 `{contentRef,ownerRevision}`；旧版可读，currentOwnerRevision 是另一个明确字段 |
| publish-reference | 当前授权下读取精确 `{contentRef,ownerRevision}` 的原版标题和说明，生成带 `work_reference` 元数据的稳定卡片；MCP 经原富块管道附在当前消息，不重交字节、不自动打开页面。附卡未确认时保留原版本，重试同一引用 |
| list | 从当前 owner manifests 投影可访问作品；分页带 catalogue snapshot，头变化拒绝拼页，未发布到聊天的已保存作品也能找回 |
| set-context / read-context | 对精确作品版保存／读取格式注释；视频上下文使用 Phase A asset schema、原文段落和实际媒体 PTS，独立 metadataRevision CAS 与 operationId。更新索引不产生新影片版本，指定旧 metadataRevision 仍可读 |
| import-context | 同一视频 metadata owner，消费受权 F063 JSON locator＋expectedSourceRevision，完整 UTF-8 视频索引最多 2 MiB。先核作品写权，再核源根、稳定读与 digest；媒体／来源验证后重核源及作品授权。命令体仍为 32 KiB，重放从保留回执恢复，不因源文件已移除而重复写入。这是视频索引格式入口，不是 HTML 正文准入 |

可选来源 binding 在保存、重放和读取时经过原 video-project owner 核权限及精确 revision/digest；若带 screening，必须同属该输入且冻结成片 digest 等于作品版。原 reviewId 通过原项目意见服务及其受众投影核验，不直接读原账、不复制批注，也不把来源绑定当成新读写授权。旧意见在视频工位的呈现仍需消费这条已核关联，不能仅凭注释落盘声明已接通。

### 视频索引的章节与来源时间（C 设计补齐）

Architecture cell: collaborative-content-plane, hub-action-surface

Map delta: none。章节、段落归属与来源时间仍是 F309 原固定版本上下文的可选字段，未新增作品身份、版本或存储。

`chapters[]` 保存原章节的 id、title、可选 label、streamId、startPts/endPts 与可选明确 sourceId；`story[].chapterId` 引用同版的章节，必须同流且落在章内。章节也由原视频媒体时钟校验；未提供章节的旧索引可照常读取，不从标题或相同秒数猜章节关系。两版有同源章节时，各按自己的 PTS 跳到章首；sourceId 缺失、重复或不能对应时，不假装已有映射。逐句意见仍冻结原段落正文、metadataRevision 与精确作品版，章节浏览不改意见坐标。

`production: {createdAt, sourceRef}` 可记录这一版的制作／原交付文件时间及出处。Works 卡片显示这个来源时间；目录的原 import/commit 时间、snapshot 和分页顺序保持原义。未提供来源时间的作品继续显示 owner 的真实提交时间。此字段是受权提交的可追溯说明，不是新的写权限或 owner 提交回执；源文件/交付记录与 digest 应在 provenance 中留证。更新这份注释只推进 metadataRevision，不推进影片 ownerRevision。

素材仍复用 Phase A 原资产版本与 locator。帧序列的浏览分组不会丢掉逐帧原件；封面只登记来源已说明采用的版本，候选和历史记录不能冒充当前采用素材。

服务端身份来自直接认证的本人请求，或 callback 的当前 invocationId/token、真实 cat、ownerUserId 和执行 thread。猫创建作品须仍是严格认证的 active owner invocation，受当前工具策略限制；只读、终态、兼容身份降级与跨线程自报写入被拒绝。续版默认沿原真实生产者；其他猫须复用现有 F309 exact publication Task grant，不能通过提交导演角色、旧 messageId、召回材料或路径自授写权。公开 DTO 不接受 actor/owner/权限字段。F063 根、realpath、descriptor、冻结 digest 和最终权限检查仍在源读取与 owner commit 两端执行。

共同 MCP 与 callback envelope 可传 `contentTaskId`，选择原 F309 修改托付的 Task 上下文；它不在提交语义中，也不是授权令牌。当前 invocation 身份不变，原 owner 逐次重读 Task 的负责猫、线程、状态及 exact content grant，并复核最初 Human 消息的当前 custody。不存在的 Task、别件作品的 Task 或已撤回消息都不能读写；重放也先复核授权。跨 thread 读取仍须在当前执行 thread 拥有这份原精确授权，并复核作品来源 thread；指定固定版本本身不授予访问。普通本人 HTTP 入口不接受此 callback 上下文，猫自己的独立交片仍不要求先建 Task。

作品的 owning-thread scope 与不可变来源说明保存在 F138 原 manifest。F309 原 canonical SQLite 只新增逐 ownerRevision 的标题、说明、源引用等注释，不拥有 head。目录按 owner 发现；源文件日后移动或删除不改写已保留版本，作品 thread 的删除或访问撤回仍阻止读取。保存不发消息；显式 publish-reference 才附卡，`reference_attached` 仅说明已进入当前消息富块管道，不冒充消息已送达。卡片的「看这版」始终重新授权并打开原固定版，「查看最新」是另一个显式读取动作。来源块或卡片自身不能授予权限，原意见回报也不能代 Human 接受意见。

同一 operationId 的 request digest 包括全部提交语义；不同说明也不能借旧回执蒙混。owner 已成功而注释落盘失败时返回 `version_saved`、原 receipt/ref 和 `annotations=pending`；相同请求恢复注释，不重交一版、不重读已消失的原件。MCP 读回采用有界 JSON 文本分段：原 command 不变，复制 snapshot 与 nextCursor，拼齐 json 后解析。HTTP 直接本人入口为 `/api/works/command`，callback 为 `/api/callbacks/work`，二者共用同一服务；callback 入口不接 agent-key 自报制作授权。

验证入口：`living-work-service.test.ts` 与 `living-work-routes.test.ts` 覆盖真实 MP4、Human/猫、权限反例、CAS、幂等、重启旧版、跨存储失败、源删除、206 Range 和分页；MCP 使用 canonical registry/SDK 注册测试及治理证据校验。Works 视频模式、聊天卡、导演反馈和八支实际作品的接入仍在同一 Phase PR 完成，不能用此底座声明 AC-C 已通过。

## 可选的原审片回应

Architecture cell: collaborative-content-plane, hub-action-surface, thread-chat-surface

Map delta: 共同 Work 提交接原 F309 预约、审片／作品注释事务和聊天回执投影；F138 增加同一 content lock 内的回执核对口，原审片页消费直接 Human 恢复动作。没有第二回应账本或版本指针。

Why: owner effect、审片回应与聊天送达可能分别中断；需要补记同一事实，同时阻止已终止旧执行再写入。

`submit.reviewResponse` 只在回应原托付时携带：原 reviewId、sourceRound、当前 expectedReviewRevision/expectedTaskRevision、原 ledger 的 expectedLedgerRevision、已绑定时的 requestId，以及对原 annotation ID 的逐条说明。可选 resultAnchor 必须在 `inspect-source` 返回的新视频时钟内；未提供就保留原位置并表示新版位置未定位。意见 v1、提交基线 v3、结果 v4 各自独立，不借 round 数当 ownerRevision。命令体仍为 32 KiB，超限整条拒绝，不截掉回应；普通 create/submit 仍无需 review、Task 或消息。

F309 原 `pending_versions` 封存完整接受命令、原 actor 和服务端验明的源/时钟；F138 requestDigest 覆盖全部提交语义。预约前和 owner effect 的两次最终校验均守原 Task、负责猫、Human 消息 custody 和精确 grant。已有 native gallery 制作回调继续走原 caller/request/source 协议，Workspace 提交不绕过它。一次 Work settle 后，作品元数据、原 review 回执及预约清除用原 SQLite 事务投影；原意见不复制、不自动接受。

有回执的授权读取只补投影，即使原制作 invocation 已结束或 head 已到 v5，仍补 v4。无回执的 read 保留 unknown，禁止重建旧 principal 发布。原审片页的直接 Human `resolve-review-submission` 在 F138 同一 content lock 内核对：有回执则完成原投影；无回执则原事务记原操作 aborted 和 Human 恢复审计，再清预约。所有旧 Work-response effect 在这把锁内复核同一预约，因此延迟旧执行不能在终止后写入。超时、单次查无回执或普通 read 本身不终止。原页面草稿不清除，网络未确认重试同一恢复 operation。

同一 PR 已接通确切结果的 Human 接受／重开、作品模式原意见与新位置、同 Work 续版回报及真实非实现猫的 MCP 使用。整阶段作者证据见 Phase C 自验 (internal)；它不代替非作者审查、合入后的具名 Alpha、原设计负责人最终实页验收或 You 的 C7 使用。

## HTML 消费端的已知接缝

#1621 在 exact `38646ca2bfa9d213803219dafb5efca339aaa097` 的静态消费反馈确认：首批是工具直接提交的、无外部依赖的单文件 HTML，不要求 Workspace 导入。下述是共同入口后续格式适配必须兑现的边界；视频 C 本轮不假装已经提供 HTML 能力，也不要求 HTML 作者造临时文件绕过输入缺口。

- **输入与来源**：当前 `CommitWork.source`、逐版来源注释和 `WorkSourcePort` 只实现 F063 Workspace MP4。后续在同一入口扩有显式种类的受限正文载荷与真实来源元数据；Workspace locator、`video/mp4` 字面量不作为所有作品格式的永久合同。正文的大小、编码、资源引用和 HTML 沙盒由该格式独立准入；当前 32 KiB locator 命令体不全局抬高。
- **固定版正文**：当前 read 返回版本坐标与说明。HTML 后续须从 F138 精确保留版读取有界正文，分清元数据读取与格式正文读取；不能拿旧消息或 widgetBlockId 的正文当 owner 版本，也不把任意媒体转换为整块内存读取。
- **同一目录**：当前 owner `listRetainedMedia` 只收 PNG/MP4。HTML 注册后还须在原 owner 的格式准入与目录发现处接入，同一 Works 投影消费该 owner；没有独立 HTML registry 或另一张作品列表。
- **会话与授权**：重启恢复不等于跨 thread 读取授权。公共 callback 已可携带原 `contentTaskId` 上下文，但跨 thread 猫读取仍须原 exact publication grant 和当前消息 custody；指定 Task 名字不代替授权。后续正文消费必须沿同一真实授权路径接入，不能用固定 ref、来源块、历史消息或“换会话”授予读写权，也不为 HTML 放宽生产、sharing 或 agent-key 边界。

上述反馈是格式消费核对，不是本实现的 review verdict。HTML PR-A 保持只做已发布内容的展示；共同正文接口与安全适配只有在真实实现、验证后才对消费者声明可调用。
