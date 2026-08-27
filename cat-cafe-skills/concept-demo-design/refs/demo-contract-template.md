# Demo Contract Template

复制本模板到 Demo 项目目录。先填完 0–6，再开始画页面。

## 0. 一句话契约

- **Demo 名称**：
- **demo_kind**：`concept_story` / `product_experience_gate` / `journey_validation`
- **目标观众**：
- **使用场景**：现场讲解 / 自助观看 / 录屏成片 / 内部对齐
- **观众复述句**：我看到 ______ 变成了 ______，因为 ______。
- **希望观众接下来做**：
- **主 claim**：
- **非目标**：本片明确不解释什么？

## 1. 判题类型、交付车道与视觉真相

- **delivery_lane**：`internal_product_gate` / `external_showcase`
- **交付位置**：Hub / Browser Preview / 公开页面 / 录屏 / 其他：
- **visual_source_of_truth**：具体产品页面、组件、截图或 worktree：
- **native_elements**：必须保留的产品结构与交互：
- **stylized_elements**：只为讲解服务的舞台、注释或控制：
- **dev_controls**：放在哪里，如何一键隐藏：
- **truth_label**：怎样标明概念编排 / 功能原型 / 真实产品：

只勾选所选车道：

### `internal_product_gate`

- [ ] 去掉 F 号、标题与开发控制后，画面仍像 Clowder AI 自然的一部分
- [ ] 从真实产品壳或组件组合开工，没有另造通用 SaaS 壳
- [ ] Demo 控制与产品交互视觉分层，控制层可以隐藏

### `external_showcase`

- [ ] 陌生观众无需家内术语也能进入故事
- [ ] 画面仍能识别 Clowder AI 品牌与产品身份
- [ ] 简化或舞台化的部分没有冒充生产 UI

若需要内外两用：

- **共享的状态模型**：
- **家内入口**：
- **对外入口**：

禁止用一个半产品、半宣传的混合壳代替两个入口。

只勾选所选 `demo_kind`：

### `concept_story`

- [ ] 观众复述句定义了唯一因果变化
- [ ] 灵魂画面在没有旁白时仍能表达主张
- [ ] 概念编排与真实证据没有混写

### `product_experience_gate`

- [ ] 写清 operator 要比较和裁决的变量，其他状态保持一致
- [ ] 包含安静默认态、主动作、折叠 / 召回、错误 / 恢复
- [ ] Must-Preserve 清单覆盖当前产品能力与生命周期语义
- [ ] 签字结果可以明确落为 keep / tune / sunset

### `journey_validation`

- [ ] 起始状态、目标结果与终态判据明确
- [ ] 每个跨人 / Agent / 工具 / surface 的 handoff 有 canonical 事件或契约
- [ ] 至少覆盖一次中断 / 恢复和一个诚实失败路径
- [ ] 没有用总结卡、模型转述或演示捷径代替真实导航与状态迁移

## 2. 视角与主角

- **视角**：工作台 / 控制室 / 其他：
- **主角**：用户 / 系统 / 资产（Skill、Memory、Harness 等）：
- **受益者**：
- **操作者**：
- **规约 owner**：谁定义“什么算好”？
- **裁判**：谁能证明变化有效？

若受益者、操作者、规约 owner 在场景间频繁更换，拆成两支 Demo。

## 3. 信号路径

```text
[信号产生者] → [系统可观察入口] → [归因者] → [晋升/拒绝决策者] → [被改变的资产] → [下一次行为]
```

逐项填写：

| 检查 | 答案 |
|---|---|
| 系统实际看得见什么？ | |
| 哪些信息它看不见？ | |
| 是否存在只负责转发的 middle man？ | |
| 反馈冲突时谁决定？ | |
| 哪类信号必须拒绝或继续观察？ | |

## 4. 诚实边界

| 画面 / 数据 / 行为 | 概念编排 | 功能原型 | 真实证据 | 屏幕标注 |
|---|:---:|:---:|:---:|---|
| | | | | |

开场或角标统一写明：

> 本界面为 ______；其中 ______ 来自真实机制 / 原型；所有数字 ______。

## 5. 灵魂画面

- **无旁白截图也能表达的变化**：
- **画面左/前**：
- **画面右/后**：
- **观众看到后应说**：
- **这一帧需要保留的真实细节**：

从这一帧倒推前因和后果，不从页面数量正推。

## 6. 场景表

| # | 幕名 | 世界状态变化 | 信号 / 角色 / 时间 | 屏幕主画面 | 讲词锚点 | 自动验证 |
|---:|---|---|---|---|---|---|
| 0 | 认识界面 | 观众理解面板与指标 | — | 新手导览 | 每栏回答什么 | 导览覆盖全部面板 |
| 1 | 变化前 | | | | | |
| 2 | 信号出现 | | | | | |
| 3 | 归因 / 分拣 | | | | | |
| 4 | 系统改变 | | | diff / 资产变化 | | |
| 5 | 新世界验证 | | 新样本 / 同题 / 灰度 | 对照结果 | | |
| 6 | 拒绝时刻（如适用） | | 坏尺子 / 越界反馈 | 拒绝或重建基线 | | |
| 7 | 谢幕 | 复述主 claim | | 灵魂画面回收 | | |

每幕只新增一个概念。切换人物、客户或时间时，在画面中加分隔与状态前提。

### 产品体验 Gate 裁决表（仅 `product_experience_gate`）

| 待裁决变量 | 方案 A | 方案 B | 固定不变的上下文 | operator 判题 | Must-Preserve 证据 | 结果 |
|---|---|---|---|---|---|---|
| | | | | | | keep / tune / sunset |

### Journey ledger（仅 `journey_validation`）

| # | actor | 起始状态 | 用户动作 / 系统信号 | canonical event / contract | surface | 下一状态 | 失败 / 恢复 | 验证证据 |
|---:|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |

旅程中的每一跳都要能回答“谁拥有状态、什么事件让它变化、失败后从哪里继续”。无法回答的跳转不能靠旁白补齐。

### 真实交互 Claim Evidence（仅有真实交互 claim 时）

只有交付声明包含编辑、输入、批注、聊天/讨论、发送、审批、拖动/加节点或可恢复草稿时填写。`concept_story` 的预设叙事和场景控制不填这一表；若它也声称上述能力，则同样必须填写。

| 交付 claim | 用户语义 → 状态因果 | 语义控件 / action handler | fixture 外的陌生 sentinel | 新 DOM / browser store 状态 | 恢复 claim 的刷新证据（仅适用） | 可重放浏览器旅程命令 |
|---|---|---|---|---|---|---|
| | | | | | N/A / | |

- 核心输入必须是可编辑语义控件；视觉上像输入的 `span`、空按钮、或只切换预写场景不能填作证据。
- sentinel 必须是 fixture 中原本不存在的字符串；完成动作后，DOM 或声明的 store 必须出现它。
- 只有声称可恢复/持久化时才要求刷新后仍能找到同一 sentinel；没有该 claim 不强加 storage。
- 截图/视频只能证明外观，不能单独替代这条可重放浏览器旅程。

### Workspace / Product Shell Claim Evidence（仅声称 Workspace / 主壳时）

- **提交式机器证据**：`docs/design-gate-claims/<id>.json`（`claims.productIntegration.userEntry + mountChain`；逐跳列出 `path + export`，由 checker 核验真实 import / mount）：

- **当前层级**：feature surface / object detail / product shell
- **working-set owner**：谁可以新增、关闭、排序、分屏和恢复工作上下文？
- **typed surfaces**：本 Gate 实际覆盖哪些不同职责的 surface？
- **sidecar 边界**：哪些对象只需临时窥视；哪些对象可晋升 tab / split？
- **真实产品宿主**：真实用户入口 + 目标宿主组件路径：
- **宿主挂载证据**：哪个 existing-product owner 实际 mount / import 了本 surface：
- **独立复制壳排除**：为什么这不是单独 `/dev` route、自造导航或复制产品 chrome：

| 真实入口 | fixture 外新对象 | 新 typed tab / pane | 与哪个异质 surface 共存 | 切换后保留的草稿 / 选择 / 滚动 | 跨刷新恢复（仅有 claim） | 多 Agent 继续运行与 exact result return（仅有 claim） | 可重放命令 |
|---|---|---|---|---|---|---|---|
| | | | | | N/A / | N/A / | |

- tab 标题、图标或预设场景切换不能单独证明 Workspace；用户必须从真实入口创造一个原本不存在于工作集的新上下文。
- sidecar / inspector 不能成为所有对象唯一宿主；持续阅读、编辑、对比或独立导航的对象必须有可晋升路径。
- 若没有多 Agent claim，不补运行连续性清单；若有，则离开当前 surface 后运行仍须继续，结果须回到 exact Artifact / Work / Review。

### Document Editor Claim Evidence（仅声称成熟文档编辑能力时）

- **提交式机器证据**：同一 JSON 的 `claims.documentEditor`（engine package/version/license/source、manifest、adapter、mount、五项 contract implementation tokens）：

- **成熟编辑器引擎**（名称、版本、license、官方来源）：
- **编辑器适配契约**：`human_edit / selection_anchor / annotation / patch_review / version_undo`
- **宿主 artifact / version 绑定**：
- **Agent patch 如何审阅后原位落回**：
- **明确排除**：原生 `textarea`、`contenteditable` 拼装或分段输入框不得填写为编辑器引擎。

## 7. 控场与节奏

- [ ] 播放 / 暂停
- [ ] 上一幕 / 下一幕
- [ ] 左右方向键
- [ ] 空格暂停 / 继续
- [ ] 暂停冻结主时间轴、字幕和弹层
- [ ] 可直接跳到任一场景做讲解
- [ ] 现场试讲后确定速度
- [ ] 录屏 viewport 与字体最小尺寸已定

## 8. 视觉语言

- **复用的产品组件 / token**：
- **逐项视觉来源与截图**：
- **需要新画的 SVG**：
- **不能使用的临时视觉**：emoji / 通用 SaaS 壳 / 假交互 / 低对比文字 / 其他：
- **灵魂帧截图路径**：

## 9. 验证与证据续接

### 确定契约

- [ ] 场景顺序、角色连续性、标签与控件有自动检查
- [ ] 页面无运行时错误
- [ ] 暂停期间没有计时器偷跑
- [ ] 概念数据与真实证据标注清楚
- [ ] `demo_kind` 与实际判题、证据类型一致
- [ ] `delivery_lane`、视觉真相源与实际页面一致
- [ ] `product_experience_gate` 的比较 fixture 只改变待裁决变量
- [ ] `journey_validation` 的 step / handoff / recovery / terminal state 均可确定重放
- [ ] 每条真实交互 claim 都有语义控件、陌生 sentinel 产生的新状态，以及可重放浏览器旅程；恢复 claim 另有刷新证据
- [ ] 每条 Workspace / product-shell claim 都证明用户能从真实入口创建异质工作上下文；若声称多 Agent，再证明离开 surface 后继续运行并 exact 回写
- [ ] 声称已接入产品时，有真实产品宿主与宿主挂载证据，且不是独立复制壳；声称成熟文档编辑时，有成熟编辑器引擎与五项编辑器适配契约，不用 `textarea` 冒充
- [ ] product/editor claim 已提交 `docs/design-gate-claims/<id>.json`，且 `pnpm check:design-gate-real-interaction` 对真实文件树核验通过；没有拿本模板文字或共享 fixture 代替证据

### 视觉与讲述

- [ ] 逐幕在浏览器检查
- [ ] 讲者能对着 Demo 讲完；卡壳点已补锚
- [ ] 目标观众能复述“一句话契约”

### 真实证据续接

- **Demo 后展示的截图 / PR / thread / 日志**：
- **这些证据支持哪个 claim**：
- **仍未验证的 claim**：

## 10. 完成判据

- **`concept_story`**：目标观众在无人补充解释时能复述 ______ 的因果变化，并区分概念编排、原型行为与真实证据。
- **`product_experience_gate`**：operator 能在原生产品语境中比较 ______，给出 keep / tune / sunset 裁决，且 Must-Preserve 基线无遗漏。
- **`journey_validation`**：代表性用户能从 ______ 到达 ______；每个 handoff、失败恢复与终态都有可重放证据。
