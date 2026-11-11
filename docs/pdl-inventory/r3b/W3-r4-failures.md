# W3 第四轮：剩余失败逐条说明

最终 Vitest 原文：

```text
 Test Files  25 failed | 923 passed (948)
      Tests  59 failed | 7911 passed | 1 skipped (7971)
```

59 / 59 条在删除前的实跑中已失败，没有新增失败。前 19 条是当前 PDL / store / hook 契约，后 40 条涉及本轮保留的独立入口依赖。保留原因与入口链见 [W3.md](W3.md)；断言、期望 / 实际值和堆栈全文见 [删后失败原文](W3-r4-tests-after.txt)。下表描述可观察的失败原因，不把契约分歧自行认定为应修改哪一层。


## src/pdl/__tests__/runtime.test.ts

1. `opens the verified recall source and its original reply through one existing row menu`：回忆侧栏的既有 `[data-act="menu"]` 选择器没有命中按钮；发生在 r135 基线，未改原型或宿主。

2. `renders real reply groups and connects the r129 older link without excluding a focused older reply`：回复元数据中按既有文字匹配的 recall 按钮没有命中；发生在 r135 基线，未改原型或宿主。


## src/stores/__tests__/chatStore-multithread.test.ts

3. `orders a newly appended message from addMessage on the shared presentation timeline`：addMessage 的当前投影顺序是 second / first / third，用例预期 first / second / third。

4. `orders a newly appended message from active addMessageToThread on the shared presentation timeline`：活动线程 addMessageToThread 返回 second / first / third，和旧时间线排序预期不同。

5. `orders a newly appended message from background addMessageToThread on the shared presentation timeline`：后台线程 addMessageToThread 返回 second / first / third，和旧时间线排序预期不同。

6. `keeps an active response in place during streaming and moves it only after an input is read`：流式 response 仍排在后到的 user 前，用例预期读入后把 user 排到前面。

7. `reorders a lifecycle response when it becomes terminal, and it stops streaming`：终态 response 的当前排序仍是 response / user，用例预期 user / response。

8. `uses deliveredAt over timestamp when snapshotting idle thread`：闲置快照的最后活动时间与 deliveredAt 预期相差 115,000ms；保留真实快照逻辑和用例。


## src/stores/__tests__/chatStore-order-invariant-coverage.test.ts

9. `'patchMessage' exposes one ordered presentation view`：patchMessage 后为 middle / moving，用例预期 moving / middle。

10. `'patchThreadMessage(active)' exposes one ordered presentation view`：活动线程 patchThreadMessage 后为 middle / moving，用例预期 moving / middle。

11. `'patchThreadMessage(background)' exposes one ordered presentation view`：后台线程 patchThreadMessage 后为 middle / moving，用例预期 moving / middle。

12. `'setStreaming' exposes one ordered presentation view`：setStreaming 后为 streaming / middle，用例预期 middle / streaming。

13. `'setThreadMessageStreaming(background)' exposes one ordered presentation view`：后台 setThreadMessageStreaming 后为 streaming / middle，用例预期 middle / streaming。


## src/hooks/__tests__/mergeReplaceHydrationMessages-timeline-order.test.ts

14. `reorders a history-only hydration by terminal completion time instead of storage order`：历史补水返回的投影顺序不符合该用例按终态完成时间重排的预期。


## src/hooks/__tests__/useChatHistory-draft-restores-active.test.ts

15. `a later invocationless draft stays active after an identity-matched terminal slot`：补水后 inv-old 槽仍在，用例预期 activeInvocations 为空。


## src/hooks/__tests__/useSendMessage-recoverable-admission.test.ts

16. `retries the same first message with the owner key and explicit intent, without optimistic History`：用例把所有 apiFetch 调用都当作带 RequestInit.body 的写请求；记录中至少一次没有该参数，map 时读 body 抛错。


## src/hooks/__tests__/useSocket-thread-guard.test.ts

17. `spawn_started on active thread registers exact invocation slots (pending bubble before intent_mode)`：用例预期 projectPath 过滤的 active execution 请求，真实 hook 已请求 `?scope=all`。

18. `message lifecycle changes immediately re-read canonical active execution truth`：生命周期事件重读同样已用 `?scope=all`，和旧 projectPath 请求断言不同。


## src/hooks/__tests__/useThreadScopedSelectors.test.ts

19. `derives one ordered presentation view for active and background threads`：活动 / 后台选择器返回 response-active / user-active，和旧 user / response 排序预期不同。


## src/components/__tests__/ApprovalItemCard-f269-critical.test.tsx

20. `'F221 taste evidence' uses a visible disclosure that reaches every detail`：F221 卡片的既有详情 disclosure 选择器未命中；组件仍在独立路由依赖树，未改行为。

21. `'F193 dispatch content' uses a visible disclosure that reaches every detail`：F193 卡片的既有详情 disclosure 选择器未命中；组件仍在独立路由依赖树，未改行为。

22. `'F260 registration rationale' uses a visible disclosure that reaches every detail`：F260 卡片的既有详情 disclosure 选择器未命中；组件仍在独立路由依赖树，未改行为。


## src/components/__tests__/ApprovalItemCard-f276.test.tsx

23. `renders claim-level source and excerpt, then submits only checked IDs`：卡片展示“成员名称暂不可读”等当前身份文案，用例仍期待 `You 明确陈述`。


## src/components/__tests__/domain-approval-original-card.test.tsx

24. `only resumes an approving taste operation through the original approve writer`：测试找不到预期的 Continue writing 动作；原始领域批准卡仍被独立 Workbench 树引用。

25. `shows original F221 facts with folded long content instead of the four generic questions`：测试的原始 taste 审批 writer spy 没收到预期调用；保留已有领域动作契约供 owner 判断。


## src/components/__tests__/f232-artifacts-detail.test.ts

26. `点击 PR 产物行 → 进入详情（GitHub 打开链接）；点返回 → 回列表`：产物点击后找不到旧详情返回按钮；ArtifactsPanel 仍被独立 Workbench 树引用。

27. `an image without persisted source coordinates remains unavailable instead of opening a weak preview`：缺少来源坐标的图片没有渲染用例查找的旧说明节点，后续字符串断言得到 undefined。

28. `opens a verified published image through the shared Workspace target while preserving its exact message item`：点击发布图片触发 resolve 读取，与旧用例“不调用 resolve”的预期相反。

29. `lets the F307 adapter consume the exact owner DTO instead of creating a second selected-record store`：旧 F307 adapter spy 没收到预期的完整 DTO 调用；对应组件仍被保留树引用。

30. `P1-2: 切 thread 后清空选中详情（不串 thread）`：旧用例在切线程前就没进入其期望的详情 DOM，因而无法检查清空。


## src/components/__tests__/f232-phase-b-scope-toggle.test.ts

31. `P1 fix: cross-thread artifact detail passes null worktreeId to prevent wrong-file preview`：跨线程产物用例没有找到原详情节点，尚未进入 worktreeId 断言。


## src/components/__tests__/lightbox.test.ts

32. `uses v2/zh for the image copy action and successful feedback`：v2 中文实际是“复制图片”，旧用例期待“复制”。

33. `uses v2/en for the image copy action and successful feedback`：v2 英文实际是“Copy image”，旧用例期待“Copy”。

34. `uses classic/zh for the image copy action and successful feedback`：classic 中文实际是“复制图片”，旧用例期待“Copy”。


## src/components/__tests__/yarn-ball-panel.test.tsx

35. `renders the selected C SVG without changing its shapes or colors`：基线缺失 `docs/evidence/2026-10-26-f322-undrawn/art/yarn-C.svg` 证据素材；该素材不在本轮删除列表。


## src/components/capability-evolution/__tests__/evolution-exploration-story.test.tsx

36. `reads historical cases from the first step through the next, keeps source navigation and the selected place`：历史案例视图缺少用例查找的“看原案例”按钮；仍属独立路由依赖。


## src/components/growing/__tests__/NeedsMePanel.test.tsx

37. `renders exactly the current producer judgment with prepared Artifact truth`：准备项的当前身份文案不含用例预期的 You；组件仍被独立 Workbench 引用。


## src/components/growing/__tests__/ProductSchedulePanel.test.tsx

38. `shows quiet and actionable admitted work in business-time order from typed owner reads`：当前 owner 缺失时展示“负责人未提供”，用例期待 You。


## src/components/content-review/__tests__/video-artwork-controls.test.tsx

39. `has one custom seek control, keeps native controls for other viewers and translates every tool including range entry`：英文视频用例仍读到中文浏览器不支持视频提示，被其中文禁用正则命中。


## src/components/rich/__tests__/CardBlock.test.tsx

40. `collapses matching cards when another tab settles the profile update`：profile-update 用例的某次 apiFetch mock 没返回 Promise，旧卡片继续 `.then` 抛错。

41. `hydrates and collapses already-approved profile-update cards on mount`：挂载卡片没有按旧断言读 `/api/profile-updates/p1`；保留被独立路由引用的卡片及用例。


## src/components/workspace-status/__tests__/cloud-compact.test.tsx

42. `compact cloud row keeps validated full URL copy/open and settings actions`：CloudConversationLink 的当前 compact 分支没有旧用例期待的外链节点。

43. `compact cloud row keeps empty binding setup without fabricating a conversation`：空 binding 的 compact 分支输出为空，旧用例期待“未绑定”。


## src/components/workspace-home/__tests__/home-owner-version.test.tsx

44. `displays the exact publication ownerRevision and passes its complete DTO to the original annotation owner`：Home 作品用例查找的旧版本 / 注释入口节点不存在，内容断言拿到 undefined。

45. `keeps the publication readable without inventing a version label when lineage is resolved and the item has no work`：lineage 已解析时旧 Home 说明节点不存在，内容断言拿到 undefined。

46. `keeps the publication readable without inventing a version label when lineage is unavailable and the item has no work`：lineage 不可用时旧 Home 说明节点不存在，内容断言拿到 undefined。


## src/components/workspace-home/__tests__/workspace-home-v3.test.tsx

47. `opens the exact picture in a local lightbox and Esc returns to the same card`：关闭本地图片预览后焦点仍在 body，旧 React 用例要求回到精确卡片按钮。

48. `returns focus to the exact replacement card after a pending catalogue refresh`：目录刷新后焦点仍在 body，旧用例要求替换后的卡片按钮获得焦点。

49. `leaves focus with the original annotation owner when that owner takes it`：注释 owner 接管后仍有旧预览 dialog，和用例预期不同。

50. `keeps the exact local preview entry when three new works displace it from the Home summary`：新作品挤出旧卡片后焦点留在 body，旧用例要求保留原卡片返回。

51. `retains exact reader return and local preview entries when their keys are distinct`：不同 key 的 reader / preview 返回后焦点在 body，旧用例要求返回卡片。

52. `retains exact reader return and local preview entries when their keys are identical`：相同 key 的 reader / preview 返回后焦点在 body，旧用例要求返回卡片。

53. `keeps dialog focus when new publications disable the focused Next control without changing the selected image`：新发布项禁用 Next 后，用例找不到预期的 dialog 控件状态（undefined）。

54. `keeps focus on an enabled lightbox control when either paging button reaches its boundary`：翻页到边界时，用例找不到其预期的可用控件 / 聚焦状态（undefined）。

55. `does not take focus from another owner when a catalogue refresh disables the previous dialog control`：另一 owner 持有焦点时，用例找不到其预期的 dialog 状态（undefined）。

56. `hands annotation the complete publication DTO and signed exact Home origin`：Home 的旧注释移交入口 / DTO 记录没有出现，spy 结果是 undefined。

57. `keeps an exact return pending until its fresh catalogue finishes loading`：目录加载期间没有保留旧 React 测试预期的精确返回 key（实际 null）。


## src/components/workbench/__tests__/real-surface-adapters.test.ts

58. `names 'report.pdf' with a human-readable artifact type`：PDF 描述符当前归为“文档”，旧适配器用例仍期待“文件”。


## src/components/workspace/__tests__/WorkspaceToolbarButton.test.tsx

59. `does not impose listen-specific flex layout on existing toolbar buttons`：按钮仍带 `whitespace-nowrap`，旧布局契约禁止该 class。

## Node 与 smoke 的环境阻塞

Node 批次：`tests 66 / pass 53 / fail 4 / skipped 9`。失败均为 `test/f311-workspace-browser-api.test.mjs` 的本地 HTTP fixture，当前沙箱对 `listen(0, 127.0.0.1)` 返回 `EPERM`：

- `the document runtime API origin permits credentialed reads from its owned Web server`：fixture 无法监听端口，未执行到业务断言。
- `server-side reads without an Origin remain available without a CORS grant`：fixture 无法监听端口，未执行到业务断言。
- `owned API preflight settles without a Program write and refuses foreign origins`：fixture 无法监听端口，未执行到业务断言。
- `allowing the fixture Web origin does not authorize Program mutations`：fixture 无法监听端口，未执行到业务断言。

smoke 尚未进入浏览器测试：仓库共用 browser-test lock 位于 worktree 可写范围外，创建 waiter 文件返回 `EPERM`。没有绕过共用锁，也没有启停应用服务。原文都保存在 [检查输出](W3-r4-checks.txt)。
