---
tips_exempt: "2026-10-10: Phase A provides versioned timeline/data contracts, not an editing interface or renderer; its architecture and acceptance record adds no user-invokable action. Later editing journeys need their own implemented entry before discovery tips advertise them."
feature_ids: [F326]
related_features: [F138, F202, F205, F309, F322, F307]
topics: [video, editing-desk, review, animation, promo-video, remotion-plugin, workbench, check-pages]
doc_kind: spec
created: 2026-10-07
description: "人和猫一起做片子的剪辑台：审片只提异议、镜头表改剪辑输入、设定与检查页、导出；渲染引擎只在插件里，动画和宣传片共用一条时间线。"
description_source: human
description_author: opus55
description_updated_at: 2026-10-08T02:10:00Z
---

# F326: Editing Desk｜剪辑台

> **Status**: in-progress | **Owner**: Ragdoll (@opus55, design owner) · 架构 小星星 (@codex-astra) · 执行 小太阳 (@codex61-sol) | **Priority**: P1

Architecture cell: `collaborative-content-plane`, `plugin`

Map delta: Phase A 在 F138 content/revision/CAS owner 内增加通用 video-project 合同与不可变访问 scope；审片经过复用 F309 canonical ledgers，素材复用索引边界；Remotion 数据互转留在插件侧。

Why: 让剪辑输入、检查页与待决定共用一份可恢复的项目真相，保留审片经过，避免另建项目或审片 Store。

## Why

> 「… 剪辑台 … 素材的收纳 … 以这一个处处喵的这个片子为一个打样 … 这个是我觉得现在我们已经可以开工的那条线了。」
> — You，2026-10-06 22:03 PDT（`[thread-id]#private-source-id`）

> 「我现在都是quicktime看的，因为家里的chat里的富文本vedio的渲染 不能让我拉动进度条 … 那个能看片的对人而言挺重要的」「我应该反馈的只有哪张不同意，不应该反馈同意！要反过来」
> — You，2026-10-07（`[thread-id]#private-source-id`）

醋醋喵 EP0 是在聊天里、文件夹里和 Remotion 代码里拼出来的：You 看片要切到 QuickTime，提意见只能在聊天里说一句，猫要自己去找是哪一张；100 个镜头、几百张画稿、配音和检查图散在三个地方，谁审过什么只有聊天记录知道。剪辑台要让 You 在家里直接看片、只标不同意的地方，让猫在同一处改镜头、对设定、出检查图、导出，而且下一部片子（宣传片、别的动画）也能用同一套。

## Current State / 现状基线

- **没有剪辑台**：`packages/web` 里没有时间线、镜头表、审片或导出界面（Studio 北极星 §1.6 的核对，2026-10-02；本次未重新普查）。
- **看片**：聊天里的视频用 `/api/workspace/file/raw` 发出，这个路由不处理 Range、超过约 10MB 拒绝（`packages/api/src/routes/workspace.ts` 563 行一带），EP0 只能切成 5 段发、1080p 成片在 Finder 里交付。修复已在 F322 C 线（Sol6.1，subject `workspace:raw-media-range`），是否就是 You 拖不动的全部原因仍待真页复现。
- **相邻的现有 Feature**：F138 Video Studio 是视频制作管线（项目、素材、revision、渲染、发布的 owner 语义），Phase 0 明写「不做自定义 timeline/editor（Remotion Studio 已够用）」；F205 是视频生成 / 分析的 provider 插件。剪辑台是人和猫一起用的工作台，覆盖 F138 没覆盖的动画线，也需要 F138 当时排除的编辑界面。两者数据怎么分工见 OQ-1。

## What

五块界面：**审片**（You 的第一屏）、**镜头**（猫改剪辑输入）、**设定**（角色、场景、道具、声音、待决定）、**画稿**（按场看画稿 + 检查页）、**导出**。

### Phase A: 架构与数据合同（已完成：小星星架构、小太阳实现）

合入后的隔离 Alpha `f326-phase-a`，HEAD `716575552d675facf243a3ee0f16dfcf8a940137`（包含上述 merge），两片 JSON 的保存与新 owner 实例恢复、CAS/权限、决定含义、检查结果与审片定位历史检查 38/38 通过；日志 `/tmp/f326-alpha-data-contract.log`。本阶段交付数据基础，尚无剪辑台界面、影片解码或渲染；验收时 live runtime 尚未加载本次 merge，后续真实产品旅程仍按 Phase B–D 推进。

把剪辑台要用的数据落到正确的 owner 上，不另起一套账：
- 一部片子 = 一条通用时间线：一段段（镜头 / 节拍），从哪开始、多长、用了哪些素材；一个镜头可以有几张画稿。剪辑台改的是剪辑输入，不碰生成出来的产物（logic.md 第二版）。
- 素材按种类认（图、视频、录屏、配音、配乐、音效、字幕、文字稿、重画的界面），每件记着被哪部片子的哪一段用了；先给现有文件建索引，不搬家（复盘「还没定的」第一条，待架构确认）。
- 审片意见：锚在这一刻 / 这个镜头 / 全片，可带画面区域；经过可追（谁提、谁定位、谁改、结果）。
- 检查页：人和猫都能新建；名称、看什么、对照哪几张参考图、用在哪些场次、谁来做、由来。每场按检查页出图。
- 版本：人改的是草稿，存了才是新版本；猫的修改是基于某一版的候选；导出单独执行（Studio 北极星 10-02 那几条）。
- 渲染引擎只在插件里：主仓不依赖 Remotion；Remotion 插件负责合成 ↔ 时间线互转和渲染（F202 插件框架）。

### Phase B: 审片（第一刀，在真实产品壳里）

You 从 Workspace 打开一部片子：看片（可拖、可跳）、只标不同意的地方、看猫的修改、对比版本。用 EP0 的真数据。

**Phase B 审片一屏已完成：实现与设计返修已合入，隔离 Alpha 工程复验和Ragdoll真页设计复验均已通过，AC-B1–B5 已验收。** 架构 [#5341](https://github.com/zts212653/clowder-ai/pull/5341) 与实现 [#5357](https://github.com/zts212653/clowder-ai/pull/5357) 已合入，后者 merge 为 `b5c05e6201372bac4fcf5154c3c1c4df16b6ad39`。非作者完整批准覆盖 Host `798f43d329b27a40451a56e69a3025d29d63afe7`、本 spec 接受修订 `5e909cb13ddc17247ea98d100325c5aed277f5db`，无开放 P1/P2（`[thread-id]#private-source-id`）。

#### Phase B 验收闭环（2026-10-11 UTC）

| AC | 实际结果与凭据 |
|----|----------------|
| B1 | 真实 Workspace 默认入口进入审片，62,662,471 字节原片可鼠标拖动、逐帧与到 450 秒片尾；HTTP Range 206。见作者/Alpha实物与设计 r2。 |
| B2 | moment/range/shot/project/region 冻结位置进原 composer；原 Human 实际发送后通知负责猫并导入同一 canonical ledger，猫显式接管、真实 F138 CAS 修改与 F309 历史可恢复；原一次发送未重放。 |
| B3 | 自审与待决定数来自受授权的实际记录；本片诚实显示尚无自审、零待决定，不由 100 镜头或检查页推断，没有逐张同意按钮。 |
| B4 | 原画稿/实际改稿并排、同步缩放；原片出现时间由映射算出并实际定位 1429/30=47.633333 秒。未生成新成片时保留明确提示，仅回冻结原片；有可核验新成片才给新版目的地，沿接受来源641。 |
| B5 | 旧版在左、当前新版固定在右并同步播放，意见冻结在右侧所看的精确版本；右版切换清理不合法比较，解码等待/取消和混来源拒绝已回归。 |

### 阶段衔接核账（2026-10-20）

operator 在 `[thread-id]#private-source-id`
追问 F326 是否掉球。核实结果：**A/B 的交付已完成，B→C 的接续漏了；整项没有完成。**

- B 回报登记 `development-return-0a9ae25c4fc41cd7bcea869fb8e408b4` 当前为 `delivered`；
  Studio 回流消息 `private-source-id` 已送达，原设计负责人在同线程
  `private-source-id` 明确核验并关闭 B。不是终报丢失或 B 未验收。
- 原 Human `private-source-id` 接受北极星；`private-source-id`
  为整个 F326 分配设计、架构和执行角色，没有设“只做到 B”的限制。A/B/C/D 是实施拆分。
  原设计负责人于本执行线程 `private-source-id` 确认：设计线按 F326/剪辑台
  回查 Human 发言未找到暂停、待排期或限到 B 的决定；10-11 的“之后按需求文档另开”是猫的
  表述，之后没有登记接续。全局消息检索本轮超时，结论不冒充穷尽其他线程的全部历史。
- C 已由Ragdoll在原 Studio 登记：Task `private-source-id`，
  scope `feature-phase:F326:C`，接受 spec `1f412eea7a9cd4ef4d5c740be7c9e16003159528`；
  执行接回来源 `[thread-id]#private-source-id`。
  回报登记 `development-return-bd9e1b9c3da850c8f085bd80414ea199` 已独立回读为 `waiting`。
  小星星正在定数据合同，小太阳已完成渲染接缝只读调查，沿已有 C 北极星推进；
  尚未安装或渲染，不把此回执当 C 验收。不复用 A/B 回报，不在执行线程复制父 Task。
  D 在 C 收口时继续接回，先补 OQ-3/4 的
  插件归属与宣传片节拍来源，不把这些准备工作解释成整项需要重新开工授权。
- **同日后续：C 实现暂缓，等待范围对齐。** You 在 Studio
  `private-source-id` 要求先看近期知识、宣传等不同场景的视频，再判断
  F326 的实际需要。设计负责人在执行线程 `private-source-id` 明确要求
  先不要实现，待他与 You 对齐后回传新范围。原 Task/return 保留；旧 C AC 暂不改写，
  架构 [#5799](https://github.com/zts212653/clowder-ai/pull/5799) 保留为待对齐的候选稿，
  暂不合入或交接实现。这是新收到的范围调整信号，不倒改此前接续漏登记的事实。
- BACKLOG 原“spec／架构、实现未开始”是漏同步，已按 A/B 验收事实纠正。历史 Alpha 的临时
  展示租约不等于今天仍在线或正式环境已逐项验证；本次核账不新增运行态验收结论。

### 阶段重排（2026-10-20，You 认可）

You 让设计负责人先看这几天做的片子（`[thread-id]#private-source-id`）。看下来：知识片（Anthropic 就业报告）、B 站记忆篇、RSI 愿景片、猫猫星球概念片、「AI-native builder 的一天」**没有一支走剪辑台**；看片在 QuickTime / Finder，意见写在聊天里带时间点；反复出现的意见分四层：故事层（「像 PPT」「外人看不懂」）、看片层（全屏、拖动、标时间点、比版本）、素材层（用了失败样本、头像不是最新）、包装层（封面、片尾、标题、平台版本、渲染占满硬盘）。原 C/D 以 EP0 动画为样板，不是现在最缺的。

You 认可重排（`[thread-id]#private-source-id`）：「我觉得可以……猫猫们最好也能感知这个特性，然后不要把pr拆的太碎一个pahse 一个pr」。

### Phase C: 真实片子进剪辑台（脚本与故事线 · 看片 · 时间点意见 · 版本 · 猫能用）

任何一支家里的片子都能登记进来；先看脚本和故事线，再看成片；全屏、拖动、在时间点上标意见，意见到导演猫；v1、v2 放在一处对比；猫做片子时通过工具登记版本、读意见、回报改动。验收目标：下一支片子从脚本到定稿，You 不再用 QuickTime / Finder 看、不在聊天里写时间点。

**C 收尾的两个小尾巴（不挡收口，一个小 PR，Sol6.1）**：① 视频工具条和图片一样居中（北极星 wmv-mark-1440），现在靠左；② 输入框上的意见标签带这一帧的缩略图（框出的那一处），时间码退到次要——You：「如果能带上这一帧的截图，会不会更好，不然 comments 多了之后都不知道哪个是哪个了……这 xx s 什么的其实对我根本没用」（…000196）；DESIGN「一组图」那条本来就写了标签带缩略图，现在是空白灰块。

**收尾增量承接（2026-10-23）**：原 owner 已为这两项建立独立 Task `private-source-id`，owner 为 `codex61-sol`；执行线程已读回原件并核对 Human196、设计219及承接246（`[thread-id]#private-source-id`）。在隔离工位 `cat-cafe-f326-c-media-preview-sol61` 实现同片逐选区缩略图、原版本定位与工具条居中；已推同一个 [Draft PR #6039](https://github.com/zts212653/clowder-ai/pull/6039)，实现 `f4e3159f20`、正向消费者登记 `770965b70b`。已观察到三处仅有一个未定位预览及异流预览的 RED，5 项原帧/来源/悬停测试和原有定向检查转绿，types 与 API build 通过；同片浏览器仍等待规范资源准入，未以排队状态宣称实页通过，尚未申请独立审查、合入或加载。跨线程 Task 状态更新被普通工具拒绝，未搬动 Task 或代改原 C 终态；C 保持已关闭，不进入 D。旧 C 交付报告已留在 `[thread-id]#private-source-id`；原 development return 的正常 report 及独立 read 均返回 `retired`，未宣称 delivered、未重新登记，由原 owner 消费这份原交付记录。新收尾不挂在旧 return 上。

**F309 慢打开共享文件接缝（2026-10-23）**：原 Studio 执行线程 `[thread-id]` 沿 Human434/原委托查首帧慢打开；本线已交精确cut及来源 `[thread-id]#private-source-id`。`useGalleryAttachmentOpen.ts` 与 `ContentBlocks.tsx` 的本次实现写入结束，释放编辑占用，Task245审查/合入责任保持不变。6039不含首帧提前呈现、不改Studio拟查的Lightbox链；其增量仅原处打开与意见卡分组。建议6039先合、性能PR按真实base串行合流，顺序变更只报精确hunk，不整文件覆盖；可见预览不代替原owner版本/权限及标注准入。无新实现委派、无要求Studio等待本线调查。

**原 Task245 已结算（2026-10-26 UTC）**：原 owner `codex61-sol` 已在任务所属设计线程通过正常接口将 `private-source-id` 从 `todo` 置为 `done`，并独立回读确认。结算依据为上述三个已合 PR、正式 boot55 对稿及交 You 的原结论（`[thread-id]#private-source-id`）；原设计负责人在 `[thread-id]#private-source-id` 明确要求关闭。前文“Task245 留待设计线程收口”为当时状态，本次仅补齐这项已交付收尾的任务账；原 C 父任务、旧 return 与上文观察边界保持，Phase D 沿下节原责任另行推进。

### Phase D: 素材正典库

每件素材标正典 / 实验 / 失败样本；家里猫的最新形象从这里取；猫做片默认只拿正典。

**D 登记（2026-10-23，C 收口同回合）**：下一步先答 OQ-3（Remotion 插件放哪个仓、谁维护）和 OQ-4（宣传片节拍表找宣传片那条线的导演确认），再开工；分工照原：Ragdoll设计、小星星架构、小太阳 6.1 执行。毛线球见设计线 F326 Phase D。

**D 启动（2026-10-26）**：10-23 登记后Ragdoll没有启动，10-25 C 收尾对稿通过后也没接回 D，停了 3 天，You 在 Feature 盘点线追问（经Siamese转来，`[thread-id]#private-source-id`），掉球在Ragdoll。OQ-3 挪到 F、OQ-4 已定（见 Open Questions），D 不再被挡。Task `private-source-id` 改为进行中。分工照 KD-5：小星星先出正典标记的数据合同（素材索引上加 正典 / 实验 / 失败样本、谁标的、为什么、标记时间；被取代关系；猫按「只要正典」取素材的工具；家里猫形象的正典和引用旧版的提示），Ragdoll同时画作品模式素材面板里标正典的稿，You 看过后交小太阳 6.1 实现，一个 PR（KD-7）。

**D 实现与工程验测（2026-10-27）**：[同一实现 PR #6183](https://github.com/zts212653/clowder-ai/pull/6183) 已合入 `531e6f1d2e1b9a7121310b36129215d1bf3482a1`，包含 D.4.1“这版不换”和第四帧成员头像。非作者 Sonnet 对最终作者 HEAD `7063905ee65de958ff3533cde73e49c92ac857f7` 给出 typed approved，P1/P2=0；作者最终 API 检查 165/165（其中 canon 44/44），最后一版 Web cut 的核心浏览器 smoke 37/37。第五轮 cloud 停滞后已封板，由 Sonnet 的完整独立终审承接最终判断。

#### Phase D 数据合同（2026-10-26，小星星）

本节覆盖 AC-D1 / D2；依据 KD-5–10、OQ-2 和启动原件 `[thread-id]#private-source-id`。合同已由 #6183 实现，D 的设计验收待原责任线结算；界面沿Ragdoll已交付的四帧稿与本轮接受约定落地，同一 Phase 一个 PR。角色定稿沿用已有明确选择，不能因本合同重新要求逐张确认。

Architecture cell: `collaborative-content-plane`（正典标记、取代经过与使用关系投影），`identity-session` 的 `identity-agent`（成员身份与既有成员设置）；文件读取仍归 F063，作品字节与版本仍归 F138。

Map delta: extend existing cells — 在 F309 原数据库中增加素材索引的正典协作元数据；成员资料与制作入口消费同一份选择。实现 PR 更新这两个 cell 的实际代码锚点，不另建素材内容库、作品版本库或角色身份库。

Why: 同一个原件被多支片子使用时，标记只记一次；新制作能选到正确样本，旧片仍能追到当时实际使用的文件。

##### D.1 文件版本、标记与取代分开

| 对象 | 固定字段与归属 |
|------|----------------|
| 素材版本引用 `indexedVersionRef` | 服务端由已规范化的 `{ownerUserId, locator.kind, rootId, path, sha256}` 得到稳定引用；保留 A 的 `VideoProjectAssetVersion` 中 byteLength、mediaType、origin。C 的 assetId/versionId 是各清单内坐标，不能直接当全库 ID；同一受权 locator + digest 在多片中解析到同一引用。同名、同 digest 不同路径不自动合并。 |
| 正典记录 | 按 `indexedVersionRef` 保存 `revision`、`status: canonical / experimental / failed`、`actor`、非空 `reason`、`recordedAt`、`operationId`、`requestDigest` 与可回查的 `evidenceRefs`。actor/时间/owner 来自服务端。尚未标记是“未标记”，不伪造实验、失败或默认通过。 |
| 取代事件 | `fromVersionRef → toVersionRef`、双方预期 revision、理由、操作者、时间、operationId；指向确切文件版本，不指路径的 latest。双方状态与取代边在原事务内更新；`supersededBy` 是事件投影，不是第四个质量标签。旧版可以仍是历史正典，同时显示“已由 … 取代”。 |
| 形象用途绑定 | `{subjectRef, representation, styleKey, role, actionKey?} → indexedVersionRef`，带独立 bindingRevision 与完整选择经过。role 至少覆盖 avatar / portrait / action / reference；动作再指明 walk、run 等。subjectRef 为已存在的成员 catId 或稳定的系列角色引用，不能用昵称、model、品种自动归并。成员实际显示的头像另用唯一固定槽位 `{catId, role: member-avatar}`，一个成员只选一个确切版本；系列各自的 avatar 候选可以并存，不自动决定成员头像。 |

记录放在现有 `ArtifactReviewStore` 使用的 F309 SQLite 中，TTL=0，追加历史并保留可重建的当前投影；不把当前正典标记写回每份历史 `WorkVideoContext`，也不因此增加影片 ownerRevision。源文件仍在原仓；目录探测、可用性检查和稳定读取复用 `VideoProjectAssetIndex` / F063。文件原地覆盖就是新 digest，旧记录显示 changed；丢失、无权读取、未验证与质量标签是不同状态。

写入使用 `expectedRevision`（首标为 0）及稳定 operationId。相同操作完整重放只返回原回执，换理由、状态、目标或 actor 必须冲突；并发标记只有一个 CAS 获胜。纠错追加更正事件，不删除旧经过。失败样本允许后来有证据改判；不把“失败”实现成删除文件。

取代必须显式指定，不能由 mtime、文件名中的 v2/final、分辨率、导入顺序推导。目标必须是当前 canonical，或在同命令中带明确判断与理由将其升为 canonical。拒绝自环、当前有效关系中的环、跨 owner、未索引目标，以及不相容的角色/形态/用途。原节点仅有一个当前直接后继；多套同样可用的风格、角色的猫形/人形、头像/走路动作可并存，不互相取代。A→B→C 时可算出当前终点，仍保留 A→B 的原事件。撤销或改判追加事件并校验受影响绑定，不让已选用途悬挂在失效“当前正典”上；已撤销的边仍在历史中，但不参与当前环检测和选材。

**用途绑定不能被全局取代暗改。** 若同一原件绑定多个用途，取代命令列出要推进的绑定及各自 CAS；全部受影响的当前绑定必须有明确处置（推进到相容新件或解除并说明），在同一事务完成。不同用途只想升级其中一个时，改该用途绑定，不宣布原件被全局取代。标为实验/失败时也须同事务解除或换掉它的当前正典绑定；不静默选另一张。

##### D.2 两种读取：选素材与看已用素材

继续扩展共同 `cat_cafe_work`，新增动作进入独立的 asset command schema/service，复用原 callback 身份和分页封套，不把影片提交 service 堆成素材大类；不另开视频专用 MCP。合同动作名：

| 动作 | 输入及结果 |
|------|------------|
| `index-asset` | 已授权 root 下的 A 素材 locator + expected digest；核真实文件，登记原版本引用及来源。用于尚未入片的母图/动作样本，不强造空 Work 或 Task；不扫整个目录即宣称已用，也不自动标正典。 |
| `list-assets` | `purpose: select / used`。省略时为 select：默认仅当前 canonical、未被取代且经当前文件验证可用的素材；按种类/成员或角色/形态/用途筛选。实验/失败/历史正典仅显式筛选才返回可选列表；无正典时返回空集及原因，不回退实验品。结果带文件引用、标记 revision、适用绑定及核验状态。先按元数据筛选有界页，再核该页候选原件；不为一次列表全库 hash 或整片 Buffer，未核完要返回 continuation/未核状态，不能当成无正典。 |
| `read-asset` / `read-asset-history` | 读取确切索引版本、出处、标记及取代经过；打开字节仍走原 F063 稳定读取与权限。历史 metadata 不等于历史文件仍可读。 |
| `set-asset-status` / `supersede-asset` | 分别提交质量判断/确切取代；按 D.1 做 CAS、幂等和绑定一致性校验。supersede-asset 的 `mode: replace / revoke`：replace 指定两端；revoke 指定仍生效的原取代事件和当前双方 revision，追加撤销事件，不制造 B→A 反向边。撤销不自动倒退后来选好的绑定，必须列出保留/重绑/解除的确切处置及 CAS。返回持久回执，不发送聊天或改影片。 |
| `bind-character-asset` | `mode: set / clear`；set 将确切当前正典绑定到用途，带 expectedBindingRevision、原件 revision 与选择来源；clear 带同一槽位及 CAS，追加解除理由/经过。同一用途仅一个当前选择，多风格用不同 styleKey；member-avatar 固定槽位不按风格再分叉。 |
| `check-asset-updates` | 输入固定 WorkReference 和可选 metadataRevision，返回 D.4 的当前提示、匹配的保留决定/决定 revision 及证据坐标。 |
| `decide-asset-update` | 仅所属直接 Human 记录「这版不换」；固定 WorkReference、原件、提示范围/变更 fingerprint、decision CAS 与理由，按 D.4.1 持久化；猫只读结果。 |

`purpose: used` 必须指定 `{contentRef, ownerRevision, metadataRevision?}`，展示这版实际用了的全部素材，含未标记、实验、失败、已取代、changed/missing 的项。这是 C6“看全”的默认行为；只选正典适用于**新增选用/制作找素材**，不能过滤旧片的已用清单。用途缺失或多义时给出候选/缺口，不能拿角色头像冒走路动作。

工具和 UI 消费相同服务。`ownerUserId`/actor 不进客户端可信字段；读取至少守原文件 root 权限，来自 Work 的索引还守原作品/线程/exact grant。正典资格不能扩大访问；列表、历史和更新提示均先按当前权限裁剪，不泄露其他线程的片名、路径或替代件。

**写权沿原来源，不能从“能读文件”推导。** D 本期库记录只允许所属直接 Human、或原记录创建猫修改；猫仍须为当前严格制作调用，并保有原来源的当前访问权。首次 index-asset 原子登记不可变 creator，重复索引不能改 creator。Work 内发起时另外核该 Work 当前写权；授权改 W1 的 exact Task grant 仅管 W1，不能借它改影响 W2 的全库标签。异作者猫没有已实现的素材级授权对象时一律 access_denied；本期不新增通用授权体系，也不以自然语言“受托”、同名身份或调用者自报 evidence 放行。取代/改判涉及多个原记录时逐一核写权；涉及用途绑定时再逐一核绑定写权，任一不满足则整项不写。

成员/系列的全局形象绑定及 member-avatar 本期由所属直接 Human 通过原设置/素材面板作明确选择；猫可检索、提出候选和整理来源，不能通过给自制素材标 canonical 就换成员头像。首批已有定稿可由已获明确授权的导入过程将原 Human 选择登记为固定来源，但运行时的 cat 命令不能自附一段“Human 已同意”就获得绑定权。已绑定成员的设置入口仍执行原成员写权限检查，再把单一头像选择写入 F309。实现需给这些边界精确的 action authorizer 与测试，不能只复用工具名声称已守住。

##### D.3 成员资料与 character-bible 接同一选择

成员 catId 及生效身份继续来自 `getResolvedCats` / `catRegistry`；系列角色用稳定的 `{seriesKey, characterKey}` 引用，已存在的角色不因设定文档修订而换身份。character-bible 的固定文档 revision/digest + 章节是该次选择的依据，单列在 evidenceRefs 中。绑定保存角色与成员的明确关系，不将所有“Maine Coon”、所有布偶或新 model 自动当成同一个角色。猫形、直立猫形、系列的人形必须分开；`styleKey` 属于该系列，不能把醋醋喵漫画规则自动覆盖猫猫星球的人形样本。

正文设定和选择依据仍在 character-bible / 原确认消息；F309 正典记录是机器可查询的**实际文件选择**。character-bible 写稳定用途绑定引用并保留历史图与定稿来由，不再维护第二张会手工漂移的“最新路径”表。API 给成员资料增加只读 visualAssets 投影；猫取素材、作品模式和成员资料读同一绑定。成员当前头像只解析唯一 member-avatar 槽位，其余用途按完整键解析。用户改已绑定成员的头像时，既有成员设置入口调用同一正典选择服务，不能让 catalog 的 avatar 路径与正典绑定各自可写。

F309 仅原子写正典选择，成员 API 只读投影，不双写 catalog.avatar。原 PATCH 同时改头像和其他成员字段时，本期在任何写入前拒绝该组合，由设置界面拆成有独立回执的“保存资料”和“选择头像”；不能暗称两个 owner 一起成功。首次建立绑定前的旧头像设置保留兼容读写，并明确“尚未关联正典”；一旦接入，clear 也表示已接入但当前未选择，不能重新启用旧 avatar 作为竞争写源。已绑定但文件失效时呈现不可用，不回退另一张并冒称当前正典。该连接不写人格、relationshipKey 或原 profile 内容。

首批登记按可核原件导入，不整库批量盖“正典”。已有 character-bible §7 的 6 月定稿、10-07 Ragdoll更新以及后来的形态选择须按各自系列/用途和原 Human 来源核实；旧 EP0 不回改的约定保留。You 指出的“走路Ragdoll是失败样本”“Maine Coon人形不要大尾巴”（`[thread-id]#private-source-id`）作为查找实际文件的依据，未定位到确切文件/digest 前不能批量贴标签或移用到别的系列。不能用现行 avatar URL、目录名或最新 mtime 代替原定稿证据。

##### D.4 引用旧版的提示从实际使用关系计算

使用关系的真相是固定 `WorkReference + metadataRevision` 下的 `WorkVideoContext.assets[].versionId/uses`；有 Phase A sourceBinding 时沿其固定来源版本，不读今天的 source head。将所选版本解析到 indexedVersionRef，再与当前正典/取代关系连接；需要精确到段落或镜头，只使用已有 uses / timeline 证据，不能从文件名猜时间。

新素材经用途绑定选用时，**必须**保存并验证 `{bindingRef, bindingRevision, indexedVersionRef}`，确认该绑定修订当时确实选择了该原件，仍随原 WorkContext 元数据持久化；不能省略来源后声称已覆盖该用途的更新提示。直接按文件选用、历史导入等本就没有用途绑定来源的记录才允许缺少它。历史清单没有 bindingRef 时，仅按精确原件及显式取代边提示；不能因为“同一只猫”出现新图就把所有旧片标过时。若用途绑定从 A 换到 B 而 A 仍服务其他用途，只对确实记录该绑定且使用 A 的片子报更新。

提示分开返回：`replacement_available`（原件有已授权且可用的新正典）、`no_longer_canonical`（已改判）、`source_changed / source_missing / access_denied / unverified`（文件状态）；新版不可用不能显示“可换用”。每项给原使用坐标、原件引用、可见的新件引用、变更理由/记录和当前查询 snapshot。无权读取替代件时不返回其身份/路径。派生反向索引/缓存可重建，key 至少含 work metadata revision 与 canon/binding revision，写标记/换绑定/撤权后重新核实；不可把缓存当独立“待换片子”账。

提示出现在原作品的素材区和猫读取/选材结果，不自动生成 Task、催导演、重渲染、替换文件或增加影片版本。旧片继续播放原成片；明确选择保留旧设计是正常决定，不因提示宣称失败。D 验收至少真实走一件失败样本的纠正和一次正典更新→已有片子出现准确提示→新制作取到新件，不能用当前目录里挑几张图代替。

###### D.4.1 「这版不换」是持久的 Human 决定

记录字段为 `{reference: WorkReference, indexedVersionRef, noticeScope, updateFingerprint, observedMetadataRevision, revision, decision: keep_this_version, actor, reason, recordedAt, operationId, requestDigest}`。`noticeScope` 区分原件的取代/改判提醒与特定用途绑定的更新提醒；有 bindingRef 的通知固定该绑定，不能因同一文件还用于头像就顺带收起立绘的独立提示。`updateFingerprint` 由服务端从这条提示实际依据的取代/改判事件及 revision、当前有效取代链/终点 revision、涉及的当前 bindingRevision 生成，同时保留这些依据可追溯；不采用全库 revision 或整个页面 snapshot。`observedMetadataRevision` 只记核对过的使用清单；无关字幕/章节元数据更新不让同一提醒复活，实际素材或用途引用变了则重新计算。

共同命令增加 `decide-asset-update`，本期只接 `keep_this_version`。输入包含固定 reference、原件、服务端返回的 noticeScope / updateFingerprint、`expectedDecisionRevision`（首记 0）、非空 reason 和 operationId。仅所属直接 Human 经原 `/api/works/command` 可写，保存前复核原 Work 的当前写权限和该版确有此素材/用途；猫通过 callback/MCP 调此写动作拒绝，读取仍按原权限。actor、owner、recordedAt 由服务端填，不能借成员头像权限替代 Work 权限，也不能用调用者自报的“Human 已同意”落账。提示所依赖的正典/绑定 revision、作品使用关系的最终核对、decision CAS 与追加回执在同一 F309 事务内确认：若页面看的是 A→B，点下时已变成 A→B→C，返回冲突并保留输入，不替人接受 C。

相同 operationId + 完整相同意图重试返回原决定和回执；换 reason、scope、fingerprint 或 actor 均冲突。先按当前权限查原幂等回执，再做新写入检查：即使回执丢失后又出了 C，重试旧 A→B 决定也不会重写成对 C 的决定。无论刷新、重启、跨入口或猫读取，只有 `reference + indexedVersionRef + noticeScope + updateFingerprint` 全部匹配的提醒才从待处理提示及数量中收起；素材清单仍完整显示，并能读到“这版保留”、谁、为什么、何时及原取代经过。它不改影片/WorkContext、Task、全库标记或默认正典选材，不发消息、不创建修改请求。

同一原件又被取代/改判，或其后继再换代（A→B 后 B→C）、所用绑定产生新选择时，新的依据 fingerprint 不再匹配旧决定，重新提示；无关素材更新不打扰。影片新 ownerRevision 是另一个 WorkReference，不继承“这版不换”。`source_changed / source_missing / access_denied / unverified` 等文件/权限状态始终独立呈现，不能被保留决定屏蔽；无权读取的旧决定和替代件也不因存在回执而泄露。

定向验证须覆盖：EP0 式保留→刷新/重启/猫读仍收起→A→B→C 再提示；无关素材或字幕更新不再提示；新影片版本不继承；同文件不同用途只收对应项；Human 与并发换代/CAS/幂等回执竞态；猫伪写被拒；文件丢失/撤权不被掩盖。此处仅补数据合同，「下一版换上」继续沿已确认设计走原讨论/意见链，不由 keep 命令触发。

##### D.5 实现接点与反例

已核基线为 F326 接受修订 `54332db93904c3d46ea08d29682d4694c8d96d31` 及主线现有代码：

- 索引与文件：`packages/shared/src/types/video-project-primitives.ts`、`packages/api/src/domains/video-studio/project/asset-index.ts`；C 元数据与只读素材入口：`packages/shared/src/types/work-video.ts`、`packages/api/src/domains/collaborative-content/works/context-store.ts`、`packages/api/src/domains/collaborative-content/works/video-context.ts`、`packages/api/src/routes/work-video-asset-routes.ts`。
- 共同工具/身份：`packages/mcp-server/src/tools/work-tools.ts`、`packages/api/src/domains/collaborative-content/works/access.ts`；成员：`packages/shared/src/types/cat.ts`、`packages/api/src/routes/cats.ts`、`packages/api/src/config/cat-config-loader.ts`。
- 角色来源：`docs/videos/cucu-pr-flow/character-bible-v0.1.md` §7。`video-forge` / `anime-forge` / `sprite-forge` 的取材指向同一正典读取；只调整取材与交付接缝，沿 KD-9 保留各自创作自由。

实现 PR 的 claim guard：同文件在两片中标记一致；同名异路径不误合；原地换字节不继承标签；空正典不降级实验；失败/旧正典在已用清单不消失；并发换代与重放只产生一个结果；A→B→C/环/多用途部分更新处理明确；角色/风格/形态不串；跨线程/撤权/伪造 actor 与借 Work 提权被拒；重启保留全部经过；更新提示既不改旧片也不漏有证据的旧引用。选材结果和实际打开字节都重新验 digest/权限；查到正典后又被改判或换代，制作取用时应报告当前差异，不能继续把旧选择说成当前正典。

### Phase E: 包装与发布

高清封面从源文件直接渲染、标题按平台写几版、片尾用家里统一模板、按平台出画幅和时长、导出记录、清理中间渲染产物。

### Phase F: 动画片深加工（原 C/D）

动画片才需要的：镜头表改剪辑输入、按场次的检查页与画稿、Remotion 合成往返（原 Phase C 与 Phase D 的内容并入这里；《平行世界》那条改为用 Phase C 的真实片子验证）。

每个 Phase 一个 PR，不拆碎；界面稿由Ragdoll先画、You 看过再实现，架构可以先行。

## User Journey

### Primary Journey: You 看一版片子，只标不同意的地方
- **Scope unit**: 一部片子的一个版本（例：醋醋喵 EP0 · v0 精绘与动效）
- **Actor**: operator
- **Entry**: Workspace 里打开这部片子的剪辑台，默认落在「审片」
- **Flow**:
  1. 顶栏写「猫已自审 100 个镜头」和「1 项待你决定」；大播放器放在中间，下面两层时间轴（全片九场概览 + 当前片段镜头条）。
  2. You 拖进度条、跳到片尾、逐帧、循环一个镜头，不用切到 QuickTime。
  3. 看到不对的地方按「标记问题」（M），先选挂在这一刻 / 这个镜头 / 全片，可在画面上框一块，写一句话，记下。说不清是哪一张就挂全片。
  4. 没标的地方都算通过；不需要逐张点「同意」。
  5. 猫定位、改好以后，问题栏这一条写「已修改」，下面是经过（You 提 → Ragdoll定位 → 小星星重画）；点「查看修改」看画稿对比（同步缩放），点「在影片中查看」跳到那张画真正出现的时刻继续播。还不对就点「还不对」。
  6. 待决定的事（例：Ragdoll的项圈）直接在问题栏里选。
- **Success evidence**: 真实入口的浏览器旅程（大于 10MB 的成片拖动 + 跳到片尾 + 标记一个问题 + 查看修改），截图与 Network 206 证据。
- **Non-goals**: 通用剪辑软件（关键帧曲线、多轨精剪、手调动效）；生图、配音、渲染本身（猫在 skill 和插件里做，台面只显示结果和开关）；剧本写作（只读、能跳转）；git / PR。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | 一个镜头 | 猫（导演 / 画师） | 镜头 → 选场次 → 点一格 → 检查栏改时长、画面版本、画面切换、溶接 / 震动 / 轻微起伏、字幕 → 生成预览 → 对比上一版 | 浏览器旅程 + 预览产物 |
| S2 | 一个检查页 | operator或猫 | 画稿 → 检查 → 新建 → 写名称、看什么、选参考图、用在哪些场次、谁来做 → 新建 → 每场出现这一页，没有图的场次可请画师补 | 浏览器旅程 + 持久化（TTL=0） |
| S3 | 一次导出 | 猫 | 导出 → 选版本、用途、范围、发到哪、分辨率 → 导出 → 记录里出现这一份（大小写数字） | 产物 + 记录 |
| S4 | 一个待决定 | operator | 设定或审片的问题栏 → 在选项里选一个 → 猫收到并按设定统一改 | 选择持久化 + 猫收到的消息 |
| S5 | 一件素材的确切版本 | operator / 有权修改该记录的猫 | 已用清单看全 → 标正典/实验/失败并留理由 → 新制作默认选当前正典 → 换代后旧片出现准确提示、原片不改 | 原文件核验 + 同源标记/使用关系 + 重启回读 |
| S6 | 一位成员或系列角色的一个用途 | operator选择，猫读取 | 选已定稿的角色/形态/用途 → 绑定确切正典 → 成员资料和制片取材读同一选择 → 改绑只提示真正用过该用途的片子 | 唯一头像槽位 + 用途绑定/固定版本 + 权限与历史回读 |

## Acceptance Criteria

<!-- 每条回到 Why：在家里看片、只提异议、猫在同一处干活、下一部片子能复用。 -->

### Phase A（架构与数据合同）
- [x] AC-A1: Design Gate 写出 `Architecture cell / Map delta / Why` 三行，并对 OQ-1 给出结论：剪辑台的片子、素材、版本是复用 F138 的 owner，还是有明确理由另立；不私造第二份项目真相。
- [x] AC-A2: 一份通用时间线合同能无损表示 EP0（`sbAnimaticCues.json` 的 100 个镜头、多画稿镜头、切换帧）和《平行世界》的节拍；用这两部片子的真实数据跑通往返（导入 → 读出一致）。
- [x] AC-A3: 审片意见（四种锚点 + 经过）、检查页（六个字段）、待决定都持久化（TTL=0），重启后原样恢复。
- [x] AC-A4: 主仓 `package.json` 依赖里没有 `remotion` / `@remotion/*`；Remotion 相关代码只在插件里（F202）。

### Phase B（审片）
- [x] AC-B1: 从 Workspace 真实入口（不带手输参数的默认入口）打开 EP0 的剪辑台，默认落在审片；大于 10MB 的成片能拖动、跳到片尾，Network 有 206。
- [x] AC-B2: 标记问题可选这一刻 / 这个镜头 / 全片，可框选画面区域；记下后出现在问题栏，负责的猫收到通知。
- [x] AC-B3: 顶栏「猫已自审 N 个镜头」「N 项待你决定」来自真实状态；没有逐张「同意」按钮。
- [x] AC-B4: 查看修改是画稿对比（并排、同步缩放）；「在影片中查看」跳到的时刻按渲染规则计算（EP0 的 C08c 是 0:47.6，不是镜头起点 0:45.3）。
- [x] AC-B5: 对比上一版：两版同步播放，新意见记在新版本上。

### Phase C（真实片子进剪辑台）
- [x] AC-C1: 家里任何一支片子（知识片、宣传片、愿景片、动画，不论在哪个仓做的）都是一件作品：猫交一版成片（文件 + 这一版改了什么）就成为这件作品的新版本，在 Works 里找得到（「视频」类型），不另立片子列表，不要求先有 Remotion 合同。用这几天的真实片子验收（Anthropic 解读、记忆篇、猫猫星球、RSI 至少三支）。
- [x] AC-C2: 故事线：从成片自己的数据（时间线或字幕）读出章节和逐句旁白，放在作品模式左边；点一句跳到那一刻，可以在某一句上标意见（只标异议）。不要求猫先写脚本，剪辑台不规定做片流程。
- [x] AC-C3: 看片与时间点意见：从聊天、作品、剪辑台任一入口打开都能真全屏、拖动；在这一刻 / 这一段 / 全片标意见（沿用 B）；意见到负责的导演猫。
- [x] AC-C4: 版本就是这件作品的版本（与 F309 活的作品同一身份、同一版本链，`contentRef + ownerRevision`），顶栏「第 N 版 · 当前 ⌄」切换；「对比版本」两版并排或先后、按故事线同一段对齐；旧意见在新版上显示「已改 / 还不对」；聊天卡引用确定的版本。
- [x] AC-C5: 猫能感知：猫通过工具登记片子与版本、读到 You 的意见、回报改动；做片的 skill 指向剪辑台，交片走剪辑台而不是只把 mp4 发进聊天。
- [x] AC-C6: 这部片子用到的素材在作品模式里一处能看全（图、视频、配音、配乐、字幕、封面），按种类分；只读，索引原文件、不搬家（OQ-2 已定）。哪个是正典留给 Phase D。
- [x] AC-C7: 结果：家里已有的片子（至少《人还剩什么？》、两版记忆篇、猫猫星球、RSI、一根线、AI-native builder 的一天、以后再说）都已接进来，带上各自已有的版本；You 用一轮：在片子上直接标不满意的地方、猫收到并在下一版回应，素材在一处看到；这一轮没有再用 QuickTime / Finder 看片，也没在聊天里写时间点。

### Phase D（素材正典库）
- [ ] AC-D2: 家里猫的最新形象（头像、立绘、动作）从正典库取；正典更新后，引用旧版的片子有提示。

### Phase E（包装与发布）
- [ ] AC-E1: 封面从源文件直接渲染出高清图；标题可以按平台各写一版。
- [ ] AC-E2: 片尾职员表用家里统一模板，按这部片子实际参与的人和猫填。
- [ ] AC-E3: 按平台（B 站、抖音、小红书）导出画幅和时长版本，有导出记录；文件大小写数字，只有正在导出的任务画进度条；中间渲染产物定期清理，写清清了多少。

### Phase F（动画片深加工，原 C/D）
- [ ] AC-F1: 镜头表可切场次；状态只标例外，配「全部 / 有说明 / 需修改」筛选；检查栏改的是剪辑输入，生成预览后能对比上一版。
- [ ] AC-F2: 检查页由人或猫新建（Supporting S2 全流程）；页签不写死，EP0 各场按真实登记显示（第三、四场只有脸和头顶，第八场有道具）。
- [ ] AC-F3: 待决定可以在设定或问题栏里直接选，选择持久化并通知负责的猫。
- [ ] AC-F4: Remotion 插件把 EP0 的合成读成通用时间线、把剪辑台的改动写回合成，并能渲染预览；人和猫看到的是同一份数据。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 「… 剪辑台 … 素材的收纳 … 以这一个处处喵的这个片子为一个打样」 | AC-A2, AC-B1, AC-C1 | 真实入口浏览器旅程（EP0 数据） | [ ] |
| R2 | 「家里的chat里的富文本vedio的渲染 不能让我拉动进度条 … 那个能看片的对人而言挺重要的」 | AC-B1 | 大于 10MB 的 mp4 拖动 + 206 | [x] |
| R3 | 「我应该反馈的只有哪张不同意，不应该反馈同意！要反过来」 | AC-B2, AC-B3 | 浏览器旅程：无逐张同意按钮，标记一个问题 | [x] |
| R4 | 「我们下次换了一个项目 … 产品宣传视频。那么我们又需要什么东西呢？」 | AC-A2, AC-D2 | 《平行世界》往返与一轮审片 | [ ] |
| R5 | 「这个东西你要集成也得做成插件那个样子的去集成，你不能集成到主仓 会太臃肿」；「我们自己的mit 开源授权的 的开源项目」 | AC-A4, AC-D1 | 依赖检查 + 插件往返 | [ ] |
| R6 | 「有tab分页 是对的， 但是 我们不应该写死 而是这个页面允许用户（operator，猫猫） 自己定义新建很重要？不同的需要不一样的」 | AC-A3, AC-C2 | 浏览器旅程：新建检查页并持久化 | [ ] |
| R7 | 「制作视频的工作台都有色彩的问题，一个色 ui ux的文字也有问题」 | AC-B1–C4（设计稿对照） | 真实页面对照北极星 v4 与 DESIGN.md「制作工作台」 | [ ] |
| R8 | 「关于F326我们这几天其实做了很多视频的，不同的场景有知识有宣传片有各种 你可以看看 然后大概知道我们到底想要个啥了」 | AC-C1, AC-C2, AC-C6 | 至少三支近期真实片子登记、脚本与看片走完 | [ ] |
| R9 | 「QuickTime 看的 从3 or 4s 就开始闪了」（`[thread-id]#private-source-id`）；「我说的是 打开 mp4！」 | AC-C3, AC-C6 | 真实入口真全屏、拖动、标时间点 | [ ] |
| R10 | 「你这里面的素材很多都不是最新的或者效果最好的，有很多都是大家的实验……那只走路的Ragdoll是……fail样本」（`[thread-id]#private-source-id`） | AC-D1, AC-D2 | 正典标记与默认取用 | [ ] |
| R11 | 「差个封面」「片尾……换成家里醋醋喵片尾统一的」（`[thread-id]#private-source-id`）；「b站用这个抖音用那个 小红书用 xxx」 | AC-E1, AC-E2, AC-E3 | 一支片子的封面、片尾、平台版本 | [ ] |
| R12 | 「猫猫们 最好也能感知这个特性，然后不要把pr拆的太碎一个pahse 一个pr」（`[thread-id]#private-source-id`） | AC-C5；KD-7 | 猫用工具交片读意见；每 Phase 一个 PR | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式
- [ ] 前端需求有足以判断实际结果的依据

## Dependencies

- **Evolved from**: F309（Studio 北极星 §1.6 的视频剪辑器稿，2026-10-02 当时定为「另立」）
- **Dependency satisfied**: F322 C 线 raw 媒体 Range 修复 [#5243](https://github.com/zts212653/clowder-ai/pull/5243) 已合入（`9e064f5ae665e59b73fc7c61e26865411b3c7a20`）；Phase B 原片的实际 206、拖动和定位已验实。
- **Related**: F138（视频制作管线：项目 / 素材 / revision / 渲染的 owner，见 OQ-1）、F202（插件框架，Remotion 插件走这里）、F205（视频生成 / 分析 provider 插件）、F307（作品模式与整窗）、F322（Workspace 外壳与 v2 设计语言）

## Risk

| 风险 | 缓解 |
|------|------|
| 和 F138 各记一份项目 / 素材 / 版本，真相分叉 | Phase A 先答 OQ-1；F191 三行写清归属，不私造 Store |
| 拖不动的原因不止 raw 路由（播放器路径、publication 分支） | Phase B 以真实 Chat / Workspace 里的那支视频为准复现，F322 C 线的取证结果先读 |
| 北极星只是设计稿、没上手过，做出来才发现不好用 | You 已说小步快跑：Phase B 先交审片一屏，真页面上手后再改，不一次铺五屏 |
| Remotion 授权与主仓 MIT 冲突 | 只在插件里，由用户自己装；插件说明写清 Remotion 的条款 |
| 检查页、问题经过这类内容被界面替人或猫改写 | 名称和说明原样显示；用词规矩放在猫的 skill 里 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 审片只提异议：没标的都算通过，不给人逐张同意的按钮 | You 原话（R3）；EP0 实际是Ragdoll和小星星自审，You 只看不同意的 | 2026-10-07 |
| KD-2 | 渲染引擎只在插件里，主仓只认通用时间线 | You：Remotion 不能进主仓；主仓 MIT | 2026-10-07 |
| KD-3 | 检查页由人和猫自己新建，界面不写死分类 | You 纠正（R6）；品味记录 `4737511a4d` | 2026-10-07 |
| KD-4 | 设计以北极星 v4 为当前稿，小步快跑，上手后再改 | You 2026-10-07 18:44 PDT | 2026-10-07 |
| KD-5 | 分工：设计Ragdoll，架构小星星，执行小太阳；review 由Maine Coon自己定 | You 立项授权（`[thread-id]#private-source-id`）：「项目design owner是你，架构小星星，执行喵小太阳sol61 然后review什么的就让Maine Coon他们自己决定甚至可以小太阳自己喊自己的subagent 也选小太阳去re 都可以的」 | 2026-10-07 |
| KD-6 | 阶段重排：C 真实片子进剪辑台、D 素材正典库、E 包装与发布、F 动画片深加工（原 C/D 并入 F） | 近期五支片子都没走剪辑台，痛点在故事、看片、素材、包装四层；You 认可（`[thread-id]#private-source-id`） | 2026-10-20 |
| KD-7 | 每个 Phase 一个 PR，不拆碎；猫必须能感知并使用剪辑台（工具 + skill 指向） | You 同一条原话 | 2026-10-20 |
| KD-8 | 片子是 F309 的活的作品：作品身份、版本、Works 目录、聊天引用与其他格式归一（clowder-ai #1621 方向）；剪辑台是视频的作品模式，不另立片子列表或版本库；筛选和版本用下拉，顶栏照「打开作品后：一排顶栏」 | You：「我们这版本什么的好像某种情况也得对齐？还是我们独立？」「这里最好不是平铺的！我们家的风格好像是下拉框？」（`[thread-id]#private-source-id`） | 2026-10-20 |
| KD-9 | 剪辑台不规定猫怎么做片：不要求先写脚本、不要求在家里的仓或照 skill 做；故事线从成片读出来 | You 同一条：「新建一个thread甚至不是在家里的仓+告诉你别看skills 你都没先做脚本的情况下 比如猫猫星球 效果反而最惊艳」 | 2026-10-20 |
| KD-10 | C 先做出来、把家里已有的片子接进去，由 You 用过再判断；C 的重点是三件：已有片子接入、直接标意见、素材一处看全（素材查看从 D 提前到 C，正典标记仍在 D） | You：「这个工作台感觉其实是给🐈用的……我唯一不方便的是有些地方不满意不好批注给你们看 有的地方要看素材也不好统一能看到 所以感觉只有你做出来，然后让家里曾经的这些片子先接进去 我看看效果可能才能知道」（`[thread-id]#private-source-id`） | 2026-10-20 |

## Tips Contribution（F244）

Phase B 已加入 1 条：「审片只标不同意的地方，没标的都算通过」，指向 DESIGN.md「制作工作台」和本 spec 的 Primary Journey（随 #5357 合入）。

## Review Gate

- 由Maine Coon自己定（KD-5）。设计对照由Ragdoll看真实页面，对照北极星 v4 与 DESIGN.md「制作工作台」。
