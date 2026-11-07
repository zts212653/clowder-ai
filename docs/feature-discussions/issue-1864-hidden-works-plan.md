---
feature_ids: [F232, F307]
topics: [works, workbench, performance]
doc_kind: plan
created: 2026-11-06
---

# Issue #1864 实施与验收方案

## 基线与分工

- `zts212653/clowder-ai:next@471b56a4bbe45f331902adeb6c03ca99d19bb30c`。#1839 让纯文本片段不再推动线程作品材料失效。#1866 增加后端线程及来源索引、页内线程作品共享 entry，未接入 retained Works 可见性，也未限制可见全局目录的总读取页数。
- GitHub 指派记录为 `whutzefengxie-ops`，当前 `gh` 使用同一账号。Issue 维护者邀请 mindfn 对齐两个切片，已核到其实际候选是 fork PR #252（`6b5421a86`，`develop_base`，Open、非 Draft）与 #254（`eb7c86436`，同 base，Open、非 Draft）。上游 #1864 时间线及上游在飞 PR 没有发现这两片的候选或 mindfn 的认领回执。两条 fork PR 的职责按各自实际 diff 认定。
- [mindfn#252](https://github.com/mindfn/clowder-ai/pull/252) 修改 `useGlobalArtifacts`、`usePagedGlobalWorks`、`useThreadArtifacts` 的失效来源和局部线程替换，并修改 socket 与后端投影事件。隐藏切片会触碰三个 hook，但职责限于 I/O 准入与生命周期。#252 的局部替换在目录 complete 后工作，启动仍自动走完 cursor，且没有面板可见性接线。未来移植须以 #1866 和本切片的共享生命周期为基础，保留撤权和失效重试语义。
- [mindfn#254](https://github.com/mindfn/clowder-ai/pull/254) 修改 `global-works-page.ts`、`routes/threads.ts` 和 API 测试，缩小续页的目录授权成本。它可以独立落地，浏览器仍请求同样页数。

## 隐藏停 I/O（切片 A）

归属仍在 `thread-chat-surface` 的作品消费者与页内 entry。保留 `collaborative-content-plane` 的内容和授权边界。`apiFetch` 已按 GET 等候者处理底层取消，暂停单个全局消费者会退出自己的等候，共用同一请求的其他消费者仍可取得结果。

1. `F307ExperienceWorkbench` 保留 owner DOM，`F307OwnerSurfaceRenderer` 把 `surfaceVisible` 传进 `WorkspaceSurfaceVisibilityProvider`。在 classic `ArtifactsPanel` 和 `ThreadWorksPanelV2` 读该上下文。线程绑定用 surface 自己的 `threadId`，包括与当前 URL 不同的恢复场景。classic 保留原来 unprojected thread/global 端点，v2 保留 `view=works` thread/paged global。未置于 Provider 的可见入口沿用默认 true。当前 scope 和 surface 可见性共同决定 panel 此刻的读取需求。
2. 线程 entry 身份继续用 session owner、generation、绑定 thread、view。保留订阅者与活跃读取者分开。任一活跃消费者保有共享请求。最后一名活跃消费者离开时，沿用清理微任务并取消本 entry 的请求和标题补齐，清掉待发失效。只剩隐藏消费者时保留现有 entry 和数据，最后一个挂载消费者退出才逐出现有 Map。重新出现且没有活跃 sibling 时，沿用一次共享再验证。活跃 sibling 继续读，复用同一份数据。暂停的 owner 不向作品失效事件登记读取回调。
3. 全局 `enabled` 保留原有 scope 关闭语义（清状态），新增 `paused` 控制同一身份的读取准入。owner/session 与请求路径变化隔离旧结果，即使此时处于暂停。隐藏会撤销 source/visibility listeners、清除 refresh timer 和待发标记，并 abort 当前读。取消后的响应在写 snapshot 和调度前拒收。恢复时现有可见读流程再验证一次，以防暂停期间错过作品变化。正在验证时沿用已渲染的同身份列表，包含尚未读完的快照。切片 A 保留现有可见读取策略。读策略变更单独结算。
4. 同一 retained DOM 不换 key。读到旧列表时的再验证保留卡片节点，避免 scrollport 因移除列表被夹到顶部。V2 的自动滤镜校正只在可见且已完成当前读后运行。继续复用现有搜索、筛选、渐进渲染和滚动状态。
5. 作者自查逐个对照线程三方（页头、作品面板、HomeWorksSummary）和非 Works reader，保留原有共享 Map 与 single flight。全局沿用每个现有 hook 的快照、失效与计时入口。暂停不新增事件总线、缓存、进程或轮询。代价是隐藏 panel 保留一份已经存在的数据到 owner 卸载，恢复可能需要一次再验证，以维持列表连续性和看到新作品。用户打开可见目录的总请求数继续由切片 B 收敛。

验收先用完整 Workbench 路由记录旧版的浏览器请求及取消，再对比 tab/Home、隐藏期间的投影失效、恢复和滚动/筛选。使用两页恢复绑定非当前线程的 owner，检查目标线程的隐藏计数并用可见 sibling 作正对照。定向测试覆盖最后一个 active 暂停时的 signal、忽略迟到结果、隐藏更换身份、待发 refresh timer、同页 sibling 不取消。浏览器启动、取消、后端开始执行及完成独立计数。fixture/proxy 的执行仅作为对应层的证据，和实际 Host 路由分开记账。

## 可见全局目录有界读取（切片 B）

`ThreadWorksPanelV2` 和首页 `RecentWorks` 共用 paged reader。首页先读 `recent-works&limit=12`，展开后当前必须 `all.complete` 且 lineage resolved 才切数据源，现有 sentinel 只扩展已取回的列表。V2 的 `useProgressiveWorks` 同样只是显示预算。任何仅改 reader 停在首批的方案都须同时处理这两处。

候选交互是首开一个固定预算批次，目录面板通过显式「加载更多」消费 continuation，RecentWorks 保留最近 12 件并给出进入完整目录的路径，或共同支持合并近期结果与已取到的目录部分后继续。需确定两处的显式按钮或滚动触发、以及每次 action 的页预算。服务端页可能含零件作品，单页停止仍应有可用的继续入口。`complete` 仅由末页与成功的 lineage 共同证明，部分结果只显示已加载数量，筛选限定已加载作品，未命中需说明仍有更多。只有完整结果可以宣告全局空态。continuation 失败应保留列表，过期/撤权沿实际 API 契约处理。

普通聊天、任务活动与无确定作品变化的宽泛失效不得自动扫完整目录。确定作品变化可以标记 stale 或最多刷新首批，已有列表与 continuation 的替换时点需要统一定义，避免旧新 cursor 混用。独立验收首批、一次主动继续、遍历到末页、真实作品新增和普通活动，分别计浏览器 GET、取消和服务端执行。分页 UI 和失效契约尚待收敛，先交付切片 A。两片各自 `Refs #1864`，本 Issue 在分别验收前保持 Open。

## 回退

回退切片 A 的 Web 提交即可回到原读策略，无数据迁移。保留 #1866 的索引和共享读取。如需现场临时止血，可显式关闭 retained Works 标签。
