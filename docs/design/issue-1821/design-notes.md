# Issue #1821 · 上下文交接卡设计说明

> **状态：合成内容，待 zts 审核。** 本稿是默认态 / 展开态的设计提案，不是设计验收，也不是实现。
> 只新增 `docs/design/issue-1821/design-proposal.html` 与 `docs/design/issue-1821/design-notes.md`；未改 `packages/**`，未 commit / push。同目录的 `README.md`、`data-contract.md`、`capture-proposal.mjs` 是砚砚已放好的审稿/截图脚手架，本稿按它们的边界写。实现、截图与 PR 由缅因猫集成。

样张里的对话、接收猫、5/42 计数、`T0/T1/T2` 数字均为合成内容；真实字段映射见第 5 节。旧版被驳回的样张在 `docs/review-evidence/issue-1821/`。

## 1. 这次改什么

旧稿的问题不是单点样式，而是默认态把三类信息并排：

- 通用用途句「本次提供给猫的背景与查阅入口」；
- 接收猫；
- 「近期消息 5 条 · 历史略过 42 条」计数。

三者都在抢“这张卡说了什么”，而真正的交接内容被藏到第二层。展开后还有「查看详情 → 诊断详情」两次展开，原始字段与长 ID 反复出现。

新稿只改信息层级，不改消息流、不改投喂内容、不改数据生命周期：

1. **默认态只回答“给谁、交接了什么”**：类型 + 接收猫 + 一句真实交接摘录 + 交接人/时间 + 唯一入口。
2. **摘要原位展开**：点开后在原位显示完整的已记录摘录，不声称保存了整条原消息，也不在下面重复一段“原文”。
3. **一个详情入口**：展开后先「交接与依据」，再「诊断」，完整 ID / 命令收在最后；交接与真相源不重复。
4. **未知就写未知**：旧卡没有接收者就写“接收猫 未记录”，没有覆盖计数就写“未记录”，不补 0，不猜。

## 2. 默认态

结构（自上而下）：

| 行 | 内容 | 作用 |
|---|---|---|
| 抬头 | `上下文交接 · 给 鲸鲸` + 右侧「详情」 | 先回答给谁；一个入口 |
| 摘要 | 交接消息的原话首句 | 回答交接了什么；宽屏 2 行、≤440px 3 行 |
| 回执 | `缅因猫 · 08:02 交接` | 谁在何时交过来；保留可核对性 |

明确不放在默认态：

- 「本次提供给猫的背景与查阅入口」这类通用用途句；
- 近期 / 略过 / 锚点 / 证据计数；
- `cold`、`carrier_unsupported`、`T0/T1/T2`、epoch、deltaSize；
- 完整 threadId、原始命令、字段名。

默认态的“一句摘要”取自 `baton.mentionExcerpt` 的首句，而不是模型生成的 task topic。这样默认文案有原话出处，不会凭空编造任务主题；代价是它可能不够“像标题”，所以用 2–3 行截断，完整摘录在原位展开。摘录本身可能只覆盖原消息的第一行，界面不能称其为消息全文。

保留：如果 `fields.传球` 带 `⚠️ 之前有“别动”指令`，这是行动相关警告，不能因为改版丢掉。默认态在回执行保留 warning 点 + `之前有“别动”指令`，展开后的交接行照旧；样张没画这个分支，实现必须保留。

## 3. 展开态

仍然只有一个入口，点开就是一层：

```
交接与依据
  交接   缅因猫 → 鲸鲸 · 11-06 08:02
  真相源 issue-1821-context-briefing-next.md
         docs/plans/issue-1821-context-briefing-next.md
  覆盖   近期消息 5 条 · 历史略过 42 条
────────────────────────────
诊断                            仅供核对
  上下文  cold · carrier_unsupported · epoch 1 · large
  呈现    T0 7 · T1 0 · T2 1 · invalid 0
  坐标    acp/desktop · direct · serial
  cold 是上下文模式原码，不等于没有历史；T0/T1/T2 是证据来源等级，不表示任务完成。
  原始记录（原样）
    会话
    cat_cafe_search_evidence({ ... })
    完整 ID 与命令不做截断。
```

设计约束：

- 不再有「诊断详情」第二层 `<details>`；诊断与原始记录都在同一个展开面板里，靠分隔线和字号降级，不靠再点一次。
- 「交接与依据」只放人能读的事实：谁交给谁、依据哪份真相源、覆盖了多少。原文已经在摘要区原位展开，不重复。
- 若 `anchorSummaries` / `threadMemorySummary` 存在，在「交接与依据」末尾各加一行：线程记忆标“记忆摘要”，锚点标“可回源锚点”；不把指针说成已投喂全文。样张未包含这两个分支。
- 「诊断」用等宽字 + muted，明确写“仅供核对”；不把状态码解释成任务完成/未完成。
- 「原始记录」只补可读区没有的事实：完整会话 ID 与检索命令；不重复交接、真相源、标题。长 ID、路径、命令统一 `overflow-wrap:anywhere`，不横向滚动。`bodyMarkdown` 里的锚点、线程记忆、活跃任务若存在，放在「交接与依据」末尾作为补充依据（每类一行），不在原始记录里再抄一遍；样张为控制长度只截了命令。
- 320px 下展开态较长（约 0.85–0.9k 卡高），但原始记录永远在最后，不挡前面的事实；不引入面板内滚动。

## 4. 旧卡与缺字段

| 场景 | 默认态 | 展开态 |
|---|---|---|
| 新版卡（modern） | 接收猫 + 原话首句 + 交接人/时间 | 交接、依据、覆盖；诊断；原始记录 |
| 旧卡（legacy，只有 title/fields/body） | `接收猫 未记录`；摘要用已记录的真相源，例如「依据 …（旧卡未记录摘要）」；提示交接记录在详情 | 交接字段原样显示，原记录中的“你”不补身份；原文（“旧卡没有保存交接原文”）、依据、覆盖（“未记录”）；诊断三项都“未记录”；原始记录只补会话 ID 与原命令 |
| 缺字段（missing，无接收者/无交接/无来源） | `接收猫 未记录`；`未记录交接摘要；真相源尚未关联。`；`交接来源未记录` | 四项都写“未记录 / 尚未关联”；诊断只展示真实存在的上下文模式、计数与坐标；原始记录只保留真实存在的会话 ID 与检索命令 |

按 `data-contract.md` 的“只保留一次”：可读区已经表达的交接、真相源、覆盖，不在原始记录里再抄；原始记录只补会话 ID 与命令，`bodyMarkdown` 的其余内容不再整段重抄。这样展开态不会变成第二份全量卡片。

旧卡规则：

- 不把 `title` 当摘要硬塞；`title` 里可能含 `→ 你` 和长路径。默认摘要优先用 `fields` 的「真相源」。
- 没有 `coverageSummary` 就写“未记录”，**不写 0**；旧卡没有覆盖元数据，0 会被读成“真的没有略过”。
- 原始记录不重复旧卡的标题 / 传球 / 真相源；只补会话 ID 与原命令。旧卡没有接收猫时写“旧卡没有记录接收猫”。

缺字段规则：

- 不猜接收者、不猜交接来源、不猜历史覆盖数；
- 不拿通用用途句填空；没有摘要就写没有；
- `cold` 仍然展示，但必须和“不等于没有历史”一起出现；`T0/T1/T2` 仍然展示，但必须和“不表示任务完成”一起出现。

## 5. 数据映射（给实现核对）

| 界面 | 拟消费的真实字段 | 现状 / 缺口 | 不成立时的回退 |
|---|---|---|---|
| 接收猫 | `meta.receiverDisplayName` → `meta.receiverCatId` | 已有；当前 `BriefingCard` 也是这个顺序 | `接收猫 未记录`；只有 ID 时用等宽字显示 ID，不伪装成人名 |
| 默认摘要 | `baton.mentionExcerpt` 的首句 | **当前只嵌在 `bodyMarkdown` 的 `原文:` 里，没有进 card meta**；且 `extractBatonContext` 取 `content.split('\n')[0]`，如果 @ 单独占一行，excerpt 会为空 | 采用 `selectDirectiveSources(rankedSources)[0]` 的已记录来源；仍缺失则写 `未记录交接摘要` |
| 交接人 / 时间 | `baton.fromSpeakerDisplay` / `baton.timestamp` | 新卡可直接记录结构化值；旧卡只有 `fields.传球` 和 `bodyMarkdown` | 旧卡保留交接字段原文，不从任意正文猜身份或拆出新的接收者 |
| 真相源 | `fields.真相源`，构建期取 `selectDirectiveSources(rankedSources)[0]` 的 label/ref | 已有；`fields` 是 `label — ref` 字符串，拆 label/ref 需要约定；不能直接用未经筛选的 `rankedSources[0]` | 整串原样显示（等宽、换行），不做二次猜测 |
| 覆盖 | `meta.coverageSummary` | 已有，字符串就是「近期消息 N 条 · 历史略过 M 条」 | `未记录`；旧卡不写 0 |
| 上下文 / 呈现 / 坐标 | `fields.上下文`、`fields.呈现`、`fields.坐标`（来自 `contextSurfaceProjection`）；或 `meta.contextSurfaceProjection` | 已有；当前实现已生成这些行 | 任一缺失就写“未记录”，其余照常显示 |
| 原始记录 | `block.bodyMarkdown` 里的命令、`block.fields.下一步`、完整 `threadId` | 已有；只取可读区没有的技术值，不重复交接 / 真相源 / 标题 | 无命令就不显示命令块，只留会话 ID |
| 旧卡 | 仅 `title/fields/body`，无 `receiver*`、无 `coverage*` | 历史持久化卡没有这些 meta | 按第 4 节降级，不迁移数据 |
| 缺字段 | `fields.传球 = 直接 @`、`fields.真相源` 以“未定位”开头 | 当前 `BriefingCard` 已把这两类值改写为“未记录交接来源 / 尚未关联到明确依据” | 沿用现有改写；不要用 title 猜来源 |

### 5.1 建议的最小 formatter 增量

为了让默认态不解析 Markdown、不猜，建议在 `buildBriefingMessage` 的 `meta` 里增量输出（都是内部 metadata，向后兼容）：

```ts
handoffExcerpt?: string;      // 完整的已记录 baton.mentionExcerpt；前端仅在默认态取首句
handoffFromDisplay?: string;  // baton.fromSpeakerDisplay
handoffAt?: number;           // baton.timestamp
truthSourceLabel?: string;    // selectDirectiveSources(rankedSources)[0]?.label
truthSourceRef?: string;      // 同一筛选结果的 ref
```

这是持久化展示 metadata 的兼容增量，不需要改 shared card schema，也不改变 prompt 或投喂内容；旧卡没有这些字段，前端按第 4 节降级。字段方案在具体实现时核实，不能把样例里存在的值当成历史库中已有的值。

### 5.2 已知的真实缺口

`extractBatonContext` 当前这样取 excerpt：

```ts
const excerpt = m.content.split('\n')[0].replace(/@[\p{L}\p{N}_-]+/gu, '').trim();
```

如果消息是：

```
@dsh
枫哥在本轮明确要求……
```

第一行只有 `@dsh`，替换后为空字符串，默认摘要就拿不到原话。本稿不要求修改共享的 `extractBatonContext`，因为它也服务于 prompt/导航；不能把更改它的影响说成仅有展示。先使用实际已记录的摘录；缺失时用已筛选的来源或诚实显示未记录。若后续确需从原消息提取展示摘录，应在展示数据构建处单独核实来源与影响，不借设计稿扩大上下文投喂改动。

## 6. 视觉与布局

- **颜色**：沿用 `canvas / surface-1 / surface-2 / surface-3 / hairline / ink / muted`。信息蓝只作为非文字类别标记：3px 左边线、16px 链接图标、约 5% 淡底；不用蓝色写正文或小字（DESIGN 的 Semantic 规则：状态色不做文字色）。深色用 `dark-canvas / dark-surface-* / dark-hairline / on-dark / on-dark-muted`，不另起主题。
- **字号**：11（eyebrow / section label）、12（caption / meta / 原始记录）、13（摘要 / 正文）、14（接收猫）、28/22（审阅页标题，DESIGN display-md/sm）。全部在字号表内。
- **间距 / 圆角**：卡内距横向 16px、纵向 12px（窄屏 12px），卡圆角 12px（lg），原始记录圆角 8px（md），分隔线 1px hairline；不用阴影，不做独立 dashboard。
- **宽度**：`width` 是聊天列宽（含内距），不是卡面净宽；视口可直接取 `width`，聊天列会占满视口（`capture-proposal.mjs` 就是这样截图）。600 时卡面约 566；375 时约 349；320 时约 294（`chrome=0` 时 288）。320 是本次硬边界，所有值可换行。卡片带 `data-proposal-card`，供截图脚本定位。
- **层级**：抬头一行 → 摘要 → 回执 → 详情；不把计数做成 badge，不把诊断做成第二张卡。
- **可访问性**：`button` + `aria-expanded` + `aria-controls` + `hidden`；焦点环 2px `focus` + 3px offset；不靠颜色单独传达状态。

## 7. 交互与截图参数

`design-proposal.html` 支持：

| 参数 | 值 | 默认 | 说明 |
|---|---|---|---|
| `width` | `600` / `375` / `320` | `600` | 聊天列宽；视口可直接取 width，页面会占满 |
| `theme` | `light` / `dark` | `light` | 明暗 |
| `state` | `collapsed` / `expanded` | `collapsed` | 初始展开态 |
| `case` | `modern` / `legacy` / `missing` | `modern` | 新版 / 旧卡 / 缺字段 |
| `chrome` | `1` / `0` | `1` | `0` 隐藏审阅页头、参数条与组件外标注 |
| `frame` | `1` / `0` | `1` | `0` 隐藏聊天头部与用户消息，只留卡片 |

点击「详情 / 收起」会同步更新 URL 的 `state`；顶部按钮也会同步 URL，方便直接截某个组合。`chrome=0&frame=0` 只留卡面；带“合成内容 · 待 zts 审核”的审阅截图用默认 `chrome=1`。

建议截图组合：

1. `width=600&state=collapsed&case=modern`，浅色，带标注（默认态全貌）
2. `width=600&state=expanded&case=modern`，浅色（展开态全貌）
3. `width=600&state=expanded&case=modern`，深色
4. `width=375&state=collapsed&case=legacy`，浅色（旧卡默认）
5. `width=375&state=expanded&case=legacy`，浅色（旧卡展开）
6. `width=320&state=collapsed&case=modern`，浅色（窄屏默认）
7. `width=320&state=expanded&case=modern`，浅色（长 ID / 命令折行）
8. `width=320&state=collapsed&case=missing`，深色（缺字段）
9. `width=320&theme=light&state=expanded&case=modern&chrome=0&frame=0`（干净卡面）

样张里的数字和对话是合成的；真实截图请保留 `chrome=1` 的审核标记，或在外层图注写明“合成内容 · 待 zts 审核”。

## 8. 创作交稿时的验证

以下为鲸鲸交稿版本的验证。砚砚整合后的内容已改为完全虚构的侧栏菜单样例，并校正摘录语义、cold 注解、历史字段原样展示及来源筛选说明；最终整合稿的实测见 `screenshots/measurements.json`，不将交稿时的哈希或尺寸冒充最终稿。

- 用本机 Chrome + Playwright 跑了 36 个组合：3 宽度 × 2 主题 × 3 用例 × 2 状态。
- 用同目录的 `capture-proposal.mjs` 跑了 20 张：modern 3 宽度 × 2 主题 × 2 状态，legacy / missing 各 375 × 2 主题 × 2 状态；`overflowing: 0`，脚本的 `data-proposal-card`、折叠态不泄漏 `thread_owned_/cat_cafe_/T0`、展开态含“诊断”断言全部通过。
- 全部组合：`document.scrollWidth == clientWidth`，卡面 `scrollWidth == clientWidth`，卡不越出聊天列；320px 无横向滚动。
- 详情开合：`aria-expanded`、`hidden`、URL `state` 三者一致；“展开”时原位全文可见。
- 最大卡高约 0.87k（320px 展开态，含完整原始记录）；这是预期高度，不是溢出。
- 截图覆盖：600 浅/深、375 旧卡、320 缺字段、320 长 ID/命令、干净卡面。
- 未验证：真实 runtime 数据、真实字体回退、实现后的组件行为；本稿不是安装版验收。

## 9. 待确认 / 风险

1. **默认态移除计数**：这与旧 plan 第 27 行“默认显示近期消息/历史略过数量”冲突，但符合 zts 本轮“避免泛说明、计数和诊断并排”的要求。建议以 zts 本轮为准；如果维护侧坚持默认保留计数，建议只保留一行极小字号、放在回执之后，且不再和摘要同一视觉层级——但这会重新引入竞争，我不推荐。
2. **`mentionExcerpt` 的提取缺口**：@ 单独一行会导致空摘要（5.2）。需要 build 侧小改，或接受默认态退化为“依据某文件”。这是本稿最关键的可实现性风险。
3. **新增 `meta.handoff*` 字段**：建议加，但不改 shared schema；如果维护侧不希望扩 metadata，前端只能解析 `fields/bodyMarkdown`，脆弱且会把原始格式带进默认态。请缅因猫核一下取舍。
4. **真相源 label/ref 拆分**：`fields.真相源` 是 `label — ref` 字符串；如果 label 本身含 ` — `，前端拆分会有歧义。建议同时给 `truthSourceLabel/Ref`，否则整串原样显示。
5. **320px 展开高度**：原始记录约 0.87k 卡高。若 zts 认为太长，可把原始记录做成“复制原始记录”而不是第二层展开；但“第二层展开”正是旧稿被驳回的点，所以本稿先保持单层。
6. **色彩浓度**：5% info 淡底 + 3px 左边线是“类别回执”，不是状态横幅；如果维护侧希望更中性，可去掉淡底只留左边线，不影响信息层级。

## 10. 交付边界

- 本稿只新增两份设计文件；不碰 `packages/**`，不 commit / push，不改 runtime。
- 由缅因猫集成、核实可实现性、出浏览器标注样张并送 zts；zts 确认前不把本稿称为“已接受设计”。
- 旧版实现仍保留在 PR #1823 / 分支上；本稿不替代代码 review，也不替代安装版验收。
