---
doc_kind: architecture
description: "W0-D 派生视图 census v0.2：11 类现存 view 的 lineage 与 invalidation 矩阵；Wave 1 深读纠正 per-cat primer 与 Taste 的 current-main 结构链，并把过度概括的‘自动全健康/手工全带病’收窄为可重建性与失效合同才是健康分水岭。"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-15T13:04:00Z
feature_ids: []
related_features: [F148, F276, F287, F200, F231, F296, F332, F335]
related_docs:
  - docs/architecture/memory-derived-view-contract.md
  - feature-specs/2026-08-15-memory-system-research-first-roadmap.md
  - docs/architecture/memory-write-lane-census.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - feature-discussions/2026-08-10-memory-write-trigger-rethink.md
topics: [memory, derived-view, lineage, invalidation, census, cache]
created: 2026-08-15
updated: 2026-11-07
status: v0.2
---

# Memory Derived View Census（W0-D）

> **范围**：一切"从原始证据派生、被当作现成认知消费"的物件——cache / summary /
> card / index / view / 手册 / 文档现状节。逐个问两问：**lineage**（能回源吗）、
> **invalidation**（会过期吗、谁刷新、过期可见吗）。对照契约 = rethink §4.3 六字段
> （sourceRefs / revisions / valid-time / ACL / constructor version / stale state）。

## F332计划内增量（2026-11-07，未实施）

来源：You `[thread-id]#private-source-id` 要求归一与迁退，
Opus845指出首版路线未接本census。下面是联合路线 (internal)
W0/W1/W2的计划登记，**不是新增已运行view**。下文11类矩阵及其健康结论保留2026-08-15的观察时态。

唯一生命周期合同为[Derived View Contract v1](memory-derived-view-contract.md) §2–7；
本表记录每类怎样对上原合同，不复制一份状态机。W0须给出现有字段映射、缺口和真实负例，
W1/W2接入时补具体constructor版本、测试/发布证据；目前全部为`planned / contract-alignment-open`。

| 计划内view | canonical来源与lineage | 构造/派生owner及消费者 | v1字段映射与失效接线 | 交付与退役 |
| --- | --- | --- | --- | --- |
| 按事整理的归纳view | 已批准读取的原消息片段/revision；落Matter时同时绑定matter/page revision及全部支持来源；文档导航仍读文档原owner | memory cell；W2构造，Opus5.5核整理语义；原Matter owner持canonical写入/更正；搜索、cue、守望和人阅读 | `sourceRefs/revisions`保留各原说话者与片段；`asOf/validTime`分开历史观察与所称现实区间；constructor/model版本记录实际运行。依赖谓词逐结论映射，ACL取全部支持源交集，按v1做失效/重验；不把重写等同批准新人物/Taste事实 | W2先隔离试点。聊天页沿[原Matter合同](f332-matter-memory-contract.md)写新revision；移除构造器不删除canonical原话/用户页。源owner遗忘清除相关派生正文；剩余结论须重核后才能重建 |
| 有证据的推断关联view | 两端稳定对象/revision及真正支持关联的片段；MD引用chat仍属同一证据链，不能增为独立证人 | memory cell；W2仅在确定性关联/整理仍留下缺口时构造；共同发现消费，原端点owner保权威 | `sourceRefs/revisions`覆盖双端与支持证据；constructor版本区分推断与确定性抽取；`asOf/validTime`及依赖谓词绑定实际条件。按v1传播端点更正/撤权/遗忘，不把模型关联升级成声明或执行权 | W2推断组单独验效用；W1已有索引/边体系承载可重建投影，不另建关系真相库。方法撤除只退该投影；原件与直接发现路径保持 |
| Matter的搜索索引view | `MatterMemoryService`权威页revision＋支撑标题/描述的原source revisions；不由index row替代原页 | memory cell；W1索引构造，原Matter service持权限投影；共同发现供搜索/目录/cue/守望消费 | ownerScope从原页来；source delta经v1依赖接线失效/重建，ACL交集由原`project()`终检。构造时间/证据截止/validTime和索引constructor版本不得混同；缺映射时不能把旧摘要交进模型上下文 | W1迁掉目录的重复发现分支，同包验证更正/遗忘对索引与向量残留的处理；索引可重建，删除索引不删除无TTL的原页、原消息或重试抑制 |

上述派生与canonical用户状态分层：v1的ephemeral-first决定可重建view是否值得物化，
不改变Matter/消息等用户状态的持久化合同。某viewer无权或一次读取失败只影响该消费，
不是原owner遗忘命令；原owner的forget/redact必须按v1清除能恢复被忘内容的派生，不能只隐藏搜索结果。
整理页落入Matter后，生命周期仍只有`MatterMemoryService.project()`及原写/忘合同；
W0把现有revision、`sources_changed`、不可读原因和原source delta映射到v1字段，不再挂第二份envelope/状态owner。
该映射不得把已确认的correct/forget弱化成可用的旧正文，也不能把一次读取失败升级成全局遗忘。
推断关联只物化为导航投影；W2试点不批量发人物/画像/Taste提案，相关线索只在合法整理页标候选。
共同发现的迁移/删除完成点由路线迁退表 (internal)持有，
模块之间的目标连接由[总图](memory-system-overview.md#f332共同发现目标拓扑2026-11-07)持有。

### W1字段映射与反例（2026-11-07施工）

本节只补原v1的映射，不给Matter页新增envelope或状态owner。实现版本以W1合入证据为准，
正式加载与效用仍未声明。共同编排版本为`knowledge-discovery-v1`，Matter索引构造器为
`matter-discovery-v1`；审计capture记录resolverVersion，旧capture缺值明确为unknown。扩展漏斗sourceRevision升为`f332-discovery-v1`，历史`f256-health-v2`仍可读、不能混成同版效用。

| v1字段组 | 本包实际映射与缺口 |
| --- | --- |
| identity/owner | 文档以collection+anchor、聊天以threadId+messageId、Matter以matterId标识；原reader持权限/内容真相。共同sourceId只标发现来路，不是新authority |
| lineage/revision | 文档沿sourcePath/sourceHash与published版本；聊天沿canonical contentRevision和当前索引；Matter沿page.revision及全部entry.source.sourceRevision。引用同一原消息不是第二独立证人 |
| constructor/time | `KnowledgeResolver.discover().version`标共同编排；SQLite V79创建Matter外部内容FTS/排序索引。page.updatedAt是原页更新时间，不冒充来源现实有效期；查询/回验时刻是本次asOf。未有显式valid-time的历史材料只作历史线索 |
| scope/ACL | collection server grants、MessageSearchService原权限与发布前终检、MatterMemoryService.project全部支持源交集；来源适配器不得把索引正文当权限凭据 |
| state/invalidators | Matter页revision或索引坐标不一致则omit；源变化由原sources_changed表示、开场不注入旧归纳；源不可读整页不返回。viewer拒绝只影响本次消费，不代替owner forget。页更正/编辑/忘记在原SQLite事务内同步FTS |
| miss/forget | 不持第二份Matter正文或向量；FTS从原页外部内容view重建。forget删除原页与索引token，保原消息和exact-retry fence。直接读原件仍可用，不运行旧全量发现作为fallback |
| outcome | 目录/索引命中不写read/applied；原显式read写F287 presented/drilled。新共同入口保来路/版本及预算停止原因；效用unknown留给W4原记录裁决 |

反例使用开发夹具，不进入未见成绩：

- 45页中只查一页，不得先投影其余44页；分页只读有界候选和实际返回前的原源。
- 当前线程候选藏在旧前12之外仍须找到；更正后的旧来源不能继续取得线程优先权。
- 一页含多只猫不同可见性的来源，任一支持源不可读即不泄露title/description；owner管理只保无正文占位。
- 页更新/forget后，旧查询不能凭FTS残留返回正文；重开数据库、重建evidence不丢用户页与重试抑制。
- 聊天在最后回验时撤权/改版即被去掉；时间排序仍只覆盖首32个准入来源，不能冒称全部历史。
- 相同坐标来自两个adapter只占一个候选；source来路不变成两个独立证人，rank/流行度也不变成truth。

### W2/W3实际登记（2026-11-07）

原计划表保留其观察时态；W1已由#6793落地共同入口与原Matter索引映射。
W2 #6788采用**简化**：两页隔离开发草稿和人工原件指针，无生产Matter物化、在线归纳或推断关联。
W3工程候选只消费W1原生发现，不新增记忆事实view或第二个生命周期owner。

| 实际对象 | 原owner与lineage | 构造/失效与读取 | 消费及判断边界 |
| --- | --- | --- | --- |
| 准备机会/不透明指针元数据（非记忆正文view） | F287 callback的严格owner/thread/cat/invocation、原触发消息、原context epoch及项目；原源ref/revision | `work_preparation` catalog v9、resolver版本和`knowledge-discovery-v1`随记录保留；原owner每次读源核ACL/revision，epoch/项目变化关闭旧scope。API重启关闭旧process-key句柄，持久化元数据仍可审计 | `cat_cafe_prepare_memory_context`的明确HTML/video准备；共20候选/2指针。`delivery=unknown`与真实显式read分列，不保存源正文，不新增有效性判官 |
| 准备读取的消费回执（原ledger分支） | `memory_cue_events`；每条实际来源坐标/版本、原opportunity和consumer scope | 成功owner read后一个事务写presented/drilled，`read_origin=explicit_read`；更正/忘记/撤权由原reader关闭，append-only guards与旧Matter行保留 | 采用/忽略仍走原后果合同；Matter只保读证据。W4按原consumer/来源记unknown，缺provider commit不能写制作前曝光 |

工程验证与独审/合入/Alpha状态以W3证据 (internal)为准。
本登记没有把旧11类快照升格为当前全仓健康，也没有宣布W4效用或正式runtime加载完成。

## 1. 现存 view 盘点矩阵（11 类）

| View | 生产方式 | Lineage（回源） | Invalidation（失效） | Verdict |
|---|---|---|---|---|
| thread/session digest（summary_segments/state） | 自动 | 带 anchor | 增量重建 | ✅ 健康 |
| embedding / FTS 索引（4.4GB 主体） | 自动 | 完全（机械派生） | 全量可重建（entity_mentions 每次重建即先例） | ✅ 健康耗材 |
| anchor_recall_metrics / CTR 基线 | 自动聚合 | recall_events | 重算 | ✅ 健康耗材 |
| message_recall_index_snapshots | 自动 | 有 | 重建 + suppressions 表 | ✅ 健康 |
| F148 briefing / threadMemory | 自动 | 部分带 anchor | 每轮重建（短命 view，天然免疫过期） | ✅ 健康 |
| F287 RecallOpportunityCatalog | 生成 | 是 | token 预算约束（300/420） | ✅ 健康 |
| **memory-cue 卡（F276）** | 拉式（实体命中） | 带 drill 指针 | **sha256 内容指纹——全家唯一** | ✅ **模板级**：最接近六字段契约的 view（有指纹，缺 valid-time） |
| **MEMORY.md 索引** | **手工**（猫维护） | 链接 feedback 文件 | **人肉**——时态卫生纪律是唯一防线 | 🔴 全家最大的无契约 view；引用腐烂高危区 |
| **per-cat primer / 画像** | 手工/半自动 | canonical data root + persona scope + logical URI/authenticated read 已闭；内容级 source refs 弱 | compiler 每次可重读，但缺 source revision / valid-time / stale state | 🟡 结构链已修；trigger/organic consumption 与内容失效仍病 |
| **taste vignette/index passage** | 审批物化 + 自动索引 | proposal source refs + canonical-main vignette/index + sha256 passage revision | 文件变更可重建索引；speaker provenance 与显式 stale/ACL state 仍缺 | 🟡 write/read 结构链已闭；治理与消费健康未闭 |
| **docs "现状/Current State" 节** | 手工 | 引用 | **无 valid-time**——本项目稿件自证腐烂 n=2（F255"幽灵"/F276"dormant"过时快照） | 🟡 需 valid-time 书写纪律（as-of 日期已在部分文档实践） |

## 2. 核心发现

1. **生产方式只是风险预测器，真正分水岭是可重建性 + 失效合同**：自动生成通常更容易
   重建，手工维护通常更容易腐烂，但二者都不能凭生产方式自动判健康。primer 与 taste 的
   current-main 结构链已经修复，却仍缺 revision/valid-time/organic consumption；自动 view 若缺
   ACL、依赖谓词或 stale state 也同样会污染。**推论**：Wave 1 合同适用于所有会进入判断
   context 的 persisted view；手工 view 优先迁移，自动 view 只在缺 lineage/失效传播时入账。
2. **memory-cue 的 sha256 指纹是全家唯一的内容寻址先例**——谓词失效（rethink
   §4.3 三层设计）需要的地基已存在于一个 view，Wave 1 合同可以从"推广 cue 的
   指纹机制"起步而非发明新机制。
3. **§4.3 六字段目前没有任何 view 完整实现**；最接近的是 memory-cue（sourceRefs
   ✅ 指纹 ✅ drill ✅；缺 valid-time / ACL 显式化 / stale state）。
4. **短命 view 是被低估的健康形态**：F148 briefing 每轮重建、F287 catalog 每次
   生成——"活得短"天然免疫过期。**不是所有 view 都需要持久化**；持久化本身应
   是被论证的例外（呼应 rethink §4.3"有些东西不该物化"）。
5. 与 W0-G 的接缝：view 的**消费后果**观测（被有害消费如何被发现）依赖 F263
   `harmful_consumption`——emitter 缺席（Maine Coon W0-G 实测），故当前所有 view 的
   "被用错了"均不可见。view 契约与 outcome 契约必须在 Wave 1 同时冻结才闭环。

## 3. 首根法庭纵切建议（回传件 3）

按 W0-G 五条件（合同覆盖 / 可裁决 outcome / 可归因边界 / 最少新基建 / 负例能力）
结合本 census 评分：

- **首选维持 ASR→F276（Person 车道）**：合同覆盖穿 write trigger → receipt →
  证据闸 → 审批 → cue 消费全链；owner 裁决强（黄挺先例）；基建全在（最少新建）；
  负例路径 schema 已有（reject/not-now/correct/forget）；且它恰好测到本 census
  最关注的剪刀差（receipt 1104 vs cue 消费 3）。
- **反例自审（预注册"我最可能错在哪"）**：Taste 车道的 speaker/审批/organic consumption
  病灶覆盖面很广，且有跨 owner 野外
  样本——若 Wave 1 认为"法庭该选病最重的被告"，Taste 反超。我判 ASR→F276 仍
  优的理由：法庭第一案要的是**证伪合同的完整链路**，不是修最多的 bug——Taste 虽已有
  canonical write/read，但没有 F276 同等级的 immediate/deferred、reject/not-now、correct/forget
  负路径；补齐它们会触发“为法庭造特供”。Taste 作为第二根，其 speaker guard 本来就在
  rethink §12-11。
- 终选权在三份 census（C/D/G）合并评分 + operator，此处只立建议与反例。

## 4. 不足以冻结合同的（回传件 4 之 W0-D 部分）

- invalidation 判定为定性（读代码/store 结构），未做逐 view 的 supersede 实测
  （改一条 source 看哪些 view 声称自己 stale——目前预期全部沉默）；
- ACL intersection 维度本轮未查（view 的可见域是否窄于其 source 的并集）；
- 手工 view 的实际消费频率未量化（MEMORY.md 每 session 注入=高频消费高风险；primer 的
  加载路径已闭环，但 organic read/adoption 仍无 typed evidence）。

### 4.1 Wave 1 深读更正

W0-C v0.2 已给出 Taste/Profile current-main code 坐标。这里据此撤回“primer 无加载路径”、
“Taste 与索引断链”以及“自动全健康/手工全带病”的 current-state 断言；三者保留为历史事故或
风险启发，不再作为冻结合同的前提。合同仍需覆盖 revision、valid-time、ACL intersection、
constructor version 与 `fresh|suspect|invalidated`，因为结构链存在不等于失效闭环存在。

---
*W0-D census v0.2 · 原始 census Ragdoll/claude-fable-5；Wave 1 深读更正 小太阳·Maine Coon/gpt-5.6-sol · 2026-08-15 · 取证均为只读*
