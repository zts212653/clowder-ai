---
topics: [message, a2a, presentation, timeline]
doc_kind: plan
created: 2026-11-06
---

# Issue #1890：在真实发言位置呈现接续结果

来源：[Issue #1890](https://github.com/zts212653/clowder-ai/issues/1890)；用户本线程消息 `0001793962764826-000213-0e0ae9de` 明确授权共同设计、隔离实现、验证并提交目标 next 的 PR，在 PR 邀请 zts212653 与 mindfn。

基线：`upstream/next@43c1c3cb7e4e2ba0285c993d5cc5bd016824a663`。Task：`0001793962844408-000215-2ffb0d41`。作者砚砚，鲸鲸参与方案与最终代码审查；创作位只做一次形状校准。首次创作调用因 provider 403 未形成结论，已换可用创作伙伴，不能把失败调用记作设计通过。

Architecture cell：现有 bubble-pipeline / output projection。
Map delta：none；MessageStore、Queue、TurnExecution 与原输出正文的 owner 不变。
Why：执行气泡固定、正文累计更新时，后来的输入与之后生成的真实文本不在同一阅读位置，用户误判未响应。

## 成功条件

用户在同一聊天页看到：原任务前文 → reviewer 回执 S → 接收方在 S 之后产生的真实接续文本。中途追加、最终完成、刷新/重连保持一致。不是只加“已处理”提示，也不是把整个旧回复移到最后。

固定 response R 的 ID、orderKey、正文与执行终态继续是唯一原始记录；复制、转发、原文与回执仍引用它。新增的发言位置是同一正文片段的显示引用，不是另一条 Agent History 消息，也不是第二套 Queue 或 receipt。

## 已查实的约束

- #1082 是不同旧机制，不能套旧 timestamp 修法。
- `message-timeline.ts` 与 viewport 固定位置是当前明确策略。无需改其 orderKey 或恢复 completedAt 排序。
- `MessageOutputLayoutV1` 已拥有正文 UTF-16 范围、native runs、通用 successful-turn tool boundaries；但其 native phase 分类在流式阶段可能是 unavailable，不能等到终局才解决接续显示。
- 已有补充消息 footer、源消息状态与回复跳转；复用它们，不再造关联。

## 输出观测与持久化

复用现有 accumulator / materializer / outputLayout / draft snapshot 路径，为 Host 实际观察到的文本 run 记录首次可见时间。

在 outputLayout 的公共部分增加可选 `speech` 范围引用（id、start/end、首次 observedAt、已有换行 glue 长度）。它独立于 native channel/identity 分类，不能声称未知 provider 的 native phase。available 和 unavailable layout 都可携带已证实的 Host 文本范围；不另存一份正文。

- 首次文本观察来自 Host clock，不从 provider 自报字段或正文猜时间。
- 同一 run 的 append、完成 snapshot 与重复回执保留首次时间；空观察不抢占真实文本的时刻。
- Native run 边界复用现有 identity；通用 carrier 复用真实 tool boundary；不逐 token 创建发言卡。
- 内容冲突、整体替换或不能对齐的变换不发布旧范围。持久化精确 trim 的情况只按实际 trim 重定位引用。
- 字段缺失的旧历史保持完整原文与原关联，不推算旧时间、不迁移/改写用户历史。
- 所有时间和范围随既有 response/draft 原子快照进入持久化；不写进 provider stdout。

## 会话投影与呈现

会话组件只消费当前可读的 canonical 消息。验证 layout owner、当前正文 revision/hash 与范围完整性后，派生同一 R 的发言片段：

1. R 原位置保留执行身份、此前文本和现有状态/回执；全文仍可从此展开。
2. 被其他公开消息隔开的后续文本片段按真实 observedAt 出现在对应对话位置，以同猫接续发言呈现；相邻未被打断的片段合并。
3. 片段只引用 R 的正文范围，保留文字选择到原始 source offset 的关系，不进入 store、未读计数、独立删除/转发和 History API。
4. 新片段使用派生展示身份插入，绕过“既有消息 ID 不移动”的误修；不移动原 R 或已有输入。
5. 现有“看回复”去除不可靠的固定向下箭头；不能用箭头修正替代主体交付。
6. 原始全文、工具记录、富块、失败/取消事实与原动作继续属于 R。不能因为分段而遗失其尾部签名或重复显示正文。

原生输出分类或 Host 观测不足时保持全文；不得用文字相似度、完成时间或客户端 Date.now 为旧记录伪造发言。新输出须验证运行中、终局与刷新，而不只静态排序函数。

## 工作单元与验证

1. 输出观测：先 RED 证明时间缺失，再补 Host clock→accumulator→materializer→wire 校验。Native 与 generic 两条路径、stream/replace/replay、旧布局兼容分别验证。
2. 派生会话：纯投影回归验证 `前文→S→接续结果`、多个追加、多猫、晚到 snapshot、无真实范围的旧历史、错误 owner/hash 和正文完整性。
3. 真实组件：复用 ChatMessage、NativeReplyText 与既有 token，验证 live→completed→reload、正文选择/全文、原始动作和回执；不新增消息存储。
4. 非 happy path：失败/取消后保留已观察发言；未证明范围时不截断原文。抽样 classic/v2 与窄屏，检查主对话与单猫视图不会遗失正文。
5. 提交前跑 shared/API 编译、Web 类型检查、受影响组件和输出回归、Biome 与 diff check。鲸鲸审最终 exact HEAD；PR base=next，公开邀请 zts212653/mindfn 讨论设计、契约和代码。

已观察 RED：`node --import tsx --test test/issue1890-output-time.test.ts`，两项均因为真实输出范围没有首次 observedAt 而失败，不是环境/语法红灯。

当前仓命令：

```text
node <pnpm9.15.4>/bin/pnpm.cjs --filter @cat-cafe/shared build
node --import tsx --test test/issue1890-output-time.test.ts test/f322-message-output-accumulator.test.ts
node <pnpm9.15.4>/bin/pnpm.cjs --filter @cat-cafe/web exec vitest run <affected-files>
node <pnpm9.15.4>/bin/pnpm.cjs --filter @cat-cafe/web exec tsc --noEmit --incremental false
node <pnpm9.15.4>/bin/pnpm.cjs exec biome check <changed-source-files>
git diff --check
```

测试和浏览器只使用 feature checkout 与隔离 fixture；不连接生产 Redis，不启动/修改运行版，不重新产生真实模型执行。UI 验证需看实际运行组件，mock 只能说明对应边界，不冒充整页或 provider 验收。

## 风险与回退

行为风险是正文片段的阅读位置与 canonical 动作身份，数据风险是新增可选引用与旧布局兼容。无鉴权、provider 协议或外部依赖改变。任何片段都不能获取原消息不具备的可见性。

回退可撤本 PR；字段可选，旧 reader 不应因新投影而丢全文。保持原 R 和完整正文，不需要删除或重置任何历史。

方案与形状反馈待回执归档；未形成真实同意前不把它记作 reviewed。最终交付仍以实际代码、测试和浏览器完整阅读路径为准。
