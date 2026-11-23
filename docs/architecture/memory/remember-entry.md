---
doc_kind: architecture
feature_ids: [F332]
created: 2026-11-11
updated: 2026-11-16
owner: codex-astra
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/memory/remember-entry.md"
mcp_admission_claims:
  - {ref: "file:docs/architecture/memory/remember-entry.md", toolName: cat_cafe_remember, resourceFamily: memory, boundaryKind: resource-entry, decision: accepted}
---

# remember 的入口绑定

事情页当前写法：`items:[{itemId:"one",target:"matter",payload:{operation:"create",title:"讨论背景",summary:"猫的一句归纳"}}]`。
不需要 quote/块号/附件/位置，也不先调用选句工具；sources 可省略，或只给 `[{threadId}]`，知道具体消息再带 messageId。
默认出处由服务端绑定本次真实调用，不把归纳当原话；新归纳按实际写入主体留名。只更正出处时保留归纳原作者或未知，
更正操作者另存于当次回执 writer；实际重写归纳才更新内容作者。追加/更正保留原 expectedRevision 等必要坐标。
兼容的新建 description（未带 summary/sources）同时生成归纳与页说明，两者按真实条目关联；更正/停用条目会更新/清除该说明。
明确同时填写的 description 与 summary 仍各自独立，不按文字相等建立关联；旧页不据此回填。
逐字引用继续可选且原校验保留。requestId 可省，由既有批次转发按 item 生成稳定键；重试同一次 remember 仍保留 clientRequestId。
完整边界见[事情页当前合同](../f332-matter-memory-contract.md#current-writing-contract-2026-11-16)。

人类授权原件：`[thread-id]#private-source-id`。
`cat_cafe_remember`接一次1–4项请求，逐项转给现有领域提交路由，返回原提案/结果/拒绝原因与groupId。
分组用现有消息的`meta.memoryGroup`保存引用；决定和正文仍归原审批、存储及去重。
事情写入行的 `matterWriteRef` 指向原请求表里固定的当次回执：动作、结果版本及实际改动由服务端同事务保存。
卡片先核当前页及全部来源权限，再读这份回执；追加和改说明不会再都显示为最新整页归纳。
分组消息不复制归纳/原话正文；遗忘会清除原请求回执里的内容。旧行没有当次回执时明确标成当前页预览，
失败项使用“提交结果”标题，不称“记下的内容”。真实问题原件为主线程 Human1548 `private-source-id`，
两张原卡 `private-source-id` / `private-source-id` 已完整回读。
它不是读取、批准或遗忘入口，不授权新的writer，也不引入批次协调或效果证明。

此绑定落实人类已点名的统一入口；不表示实现已review、合入或验收。
当前范围见474接续文档，
本包验证见薄入口证据。
旧八工具须W4读取恢复与真实完整替代均通过后才撤，本包保留它们。

## 2026-11-13 撤旧写工具

You 原话：「要删除老的记忆工具，然后再各种skill 系统提示词 l0 以及 query 注入里 改成新的才行啊！！你这等于做了路（code）没放路牌」（`[thread-id]`，11-13）。上一条「等 W4」的前提由此取消：`remember` 转给的是同一批原路由，和读记忆是否恢复没有技术关联。

- 猫的工具面只剩 `cat_cafe_remember` 一个写记忆入口；原人物、暂缓、放弃、实体、事件更正五个工具撤除，原路由、审批卡、回执不变。
- 每个 target 的 payload 在 `remember` 的 schema 里有自己的字段与用法说明（原工具说明里的用法要点搬入对应分支），不再写「同原工具」。
- `person_defer`、`person_abstain` 两类走 `remember` 时不出分组卡，保持原来的静默；混合请求的卡只列可见项。
- 守望猫的临时三工具/profile 例外已由 [#7029](https://github.com/zts212653/clowder-ai/pull/7029)（`01092998f4`）撤除：统一入口一张票认领整个1–4项批次，API仅在该父请求的内部作用域授权精确转发，内层仍验证原路由 allowlist 与领域权限。profile/taste/matter 三类权限不扩张，原审批与存储保持；完整外层回执与未知结果不重放沿原票据生命周期。代码合入不代表运行加载，后者由F335原home核验。
- 完整撤除清单：`packages/mcp-server/governance/cutovers/memory-entry-remember-write-tools.json`；八旧写工具均不得重新出现在执行面。

## 2026-11-14 公开切面的原子清单

公开基线 `1ac5dfe475` 仍含全部八个旧名，而当前源已完成两阶段撤除。两个阶段的清单共享资源族，不能各以五个、三个旧名代表本次完整八项差异。现将它们收敛为一份完整清单，七层消费者证据取两阶段并集；严格守卫、固定扫描根、旧名负引用规则和原权限不变。

原五项清单与守望三项清单逐字保留在同目录 `history/memory-entry-remember-write-tools-phase1.json`、`history/watcher-memory-entry-remember-write-tools-phase2.json`。历史子目录不作为现行清单加载。完整回滚点保留第一阶段前的 `08f1d5f1408ae030f77b666ca7dfb4bc22c38a1b`，其工具基线真实包含八个旧名；后阶段回滚点仅保留在阶段原件。`remember-write-public-199-projection.json` 记录真实公开基线的八个旧名、资源族和运行 profile，支持累计差异的回归检查；共同的 191 个工具资源族与 profile 无变化。
