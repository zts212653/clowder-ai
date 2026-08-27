# Design-in-Context Checklist（在地设计检查单）

凡是往已有页面或组件添加用户可见 UI，在 Design Gate 必须使用这一份检查单。它只是现有原则的操作投影，不创建第二套设计规则：

- 结构来源：ADR-043 C4 判断转移 / C5 折叠态优先
- 视觉与现场来源：[F056 在地设计](../../docs/features/F056-cat-cafe-design-language.md#实践规则f154-事故后补充)

## 用户正在做什么（ADR-043 C4 / C5）

- [ ] 先写一个可信的用户场景：谁在什么情况下，要完成什么；体验稿使用这个场景里的内容，不拿 Feature 或架构解释充当示例数据。
- [ ] 用户此刻唯一要完成的事情是什么？首屏完成它只需要哪些事实？
- [ ] 系统已经知道什么、能先给出什么建议或默认值？不得把系统能判断的事重新推给用户填表。
- [ ] 主操作无需滚动即可发现；不参与当前决定的内容按需展开。
- [ ] 产品主体只使用用户完成任务所需的语言。Feature ID、ADR、Gate、stage、状态机、架构、评审术语等内部概念不得出现在产品文案或示例数据中，除非它本来就是目标用户的任务词汇。
- [ ] 把设计说明、对比控制和开发标签全部遮住后，第一次看到页面的人仍能回答：发生了什么、要不要我行动、下一步是什么？不能 → 退回重做内容与层级。
- [ ] URI、revision、绝对路径、Raw、内部映射语法等工程细节是否默认折叠，并且需要时仍可找到？

## 放回真实页面（F056 在地设计）

- [ ] 读过目标页面的实际组件代码（标注文件路径 + 关键行号）。
- [ ] 列出该区域已有的 UI 元素（按钮、指示器、空间占用），或附上当前页面真实结构截图。
- [ ] 明确新能力是新增入口、替代旧入口，还是与旧入口共存。
- [ ] 明确新元素放置位置及原因，并给出至少一个备选位置或形态及其取舍。
- [ ] 评估密度上限，说明移动端或窄宽度的退化策略（隐藏、折叠或移位）。
- [ ] 明确现有 UX 是变好还是变差，为什么。
- [ ] 覆盖空态、已有态、切换或变更时的即时反馈，以及失败后的现场恢复动作。
- [ ] 若交付声明含真实交互 claim，写清用户在做什么、哪个语义控件可编辑、哪个 handler 造成哪条新状态；`span`、空按钮或预设场景切换不能冒充输入/编辑/审批。
- [ ] 用 fixture 外的陌生 sentinel 走可重放浏览器旅程：动作后 DOM 或声明的 browser store 出现新状态；只有声称可恢复/持久化时才加刷新后的同值恢复断言。
- [ ] 截图/录屏只证明外观，不能单独证明真实交互 claim；批注、聊天/讨论、协同记录或历史要写出用户语义与因果，不用“右栏”代替。
- [ ] 若跨 surface（如 Hub / Connector / Sidebar），说明如何保持一致。
- [ ] 设计稿的对比控制、状态切换和解释文字位于产品主体之外，并可隐藏后独立验收产品画面。
- [ ] [视觉专属] 新元素的颜色、阴影、层级是否与周围元素打架？是否复用了现有 Design Token？

## 仅当声称 Workspace / 产品主壳时

普通详情页、设置页和一次性流程跳过本节；不要把 Workspace 清单变成所有页面都要补齐的功能表。

- [ ] 明确当前交付是 feature surface、对象详情还是 product shell；单个资产页、Channel 页或右栏不能冒充整个产品工作区。
- [ ] 若声称“已接入现有产品 / Collective”，必须给出**真实产品宿主**的用户入口、目标宿主组件路径与**宿主挂载证据**；独立 `/dev` route、另造导航与 **独立复制壳**只能标为组件实验，不能据此推进正式后端阶段。
- [ ] 用户能从真实入口把 fixture 外的新对象加入 working set；新增 tab / pane 来自用户动作，不是预写场景切换。
- [ ] 至少两类职责不同的 surface 能共存或快速切回，例如 Channel + Artifact、Chat + Review、File + Browser；它们不共用一张万能卡皮肤。
- [ ] inspector / sidecar 只承载临时上下文、短动作或窥视；需要持续阅读、编辑、对比、独立导航的对象可以晋升为 tab / split pane。
- [ ] 切换 surface 后，各自的草稿、选择、滚动、缩放和内部导航不丢；只有声称跨刷新恢复时才要求恢复完整 working set。
- [ ] 若声称多 Agent 并行，离开其 surface 后运行仍继续、状态可找、结果回到 exact Artifact / Work / Review；头像、presence 或预写状态不算证据。
- [ ] 响应式只改变排布，不偷偷把多 surface 能力降级为单槽；窄屏仍有可预测的 tab 切换、返回和恢复路径。

## 仅当声称成熟文档编辑能力时

普通短文本输入、表单与概念故事跳过本节。若 claim 是“共同编辑文档、精确批注、审阅 Agent patch、版本撤销”，必须嵌入**成熟编辑器引擎**，并列出 `human_edit / selection_anchor / annotation / patch_review / version_undo` 五项**编辑器适配契约**。原生 `textarea`、`contenteditable` 拼装或分段输入框只能证明字段可改，不能证明文档编辑器成立。

- [ ] product/editor claim 已提交 `docs/design-gate-claims/<id>.json`，而不是只在设计说明里填写路径
- [ ] `claims.productIntegration.mountChain` 的入口、宿主与 surface 逐跳存在真实 import/mount；入口不是独立 `/dev` 复制壳
- [ ] `claims.documentEditor` 的 engine 在 manifest 中真实声明并由 adapter 导入；五项 contract 的实现 token 可在 adapter 中找到，且 adapter 被真实 surface mount
- [ ] `pnpm check:design-gate-real-interaction` 已读取上述提交式证据并通过
