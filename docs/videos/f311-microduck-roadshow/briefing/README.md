---
title: 鸭鸭学踢足球到元进化 · 周四讲解页
doc_kind: guide
created: 2026-09-07
status: in-progress
owner: codex-astra
source: [thread-id]#private-source-id
tips_exempt: Standalone event briefing; does not add a product capability or change Hub navigation.
---

# 鸭鸭学踢足球到元进化

约 20 分钟的可离线演示 HTML，供 2026-09-10 F311 交流使用。它是讲解载体，真实四阶段验收仍归本目录上级 README 与同一 canonical Task；页面不会写入 Program、批准或采用候选。

2026-09-07 按 operator 原始足球目标纠正讲解：开场改用同轮 MuJoCo 真实视频，可切换近球、远球、原地 kick 与走近控制；同时显示对应实际样本。第二页展示六层准备，第三页可切换完整足球实验版本和失败结果。原行走 0.90/1.05/1.10 对照保留为历史基础，不再说足球是另一个任务。正式 Workspace 的准备/候选阅读面由同一总任务中的产品实现单独验收；这份讲解页不能替代产品交付。

## Demo Contract

- **类型 / 车道**：`concept_story × external_showcase`。
- **唯一判断**：观众能区分“鸭鸭控制配置的改进”和“产生、验证、采用改进的方法自身变好”，并指出后者还缺什么证据。
- **复述句**：我们为了足球目标，固定模型并记录真实动作；近球能踢、远球够不到的结果推动控制器和采集方法变化，之后仍要用新结果判断变化是否有用。
- **灵魂画面**：上下两条版本线。上方是鸭鸭配置，下面是方法版本；两者之间必须有后续结果回流，不能用工具写好了直接宣称元进化完成。
- **视觉真相**：`../stage/index.html` 的暖白、陶土色与留白；*(internal reference removed)* 的双版本线契约；operator 本 source 附的蓝白四轴图（原图原样收录）。
- **原生结构 / 舞台化**：保留四阶段命名与真实状态；放大比较图、讲者笔记、假设条件控件服务讲解。常驻标明“讲解页 · 证据快照”，不冒充正式产品 UI。
- **证据下限 / 上限**：真实足球视频、状态和动作来自同轮采集；v2 两段另行同参数运行的录像与原 capture 字节完全相同，分开保留执行来源。完整场景表保留失败，代码/文件完整性不充当能力验收。历史行走公开预选不能说明足球会了、holdout 通过、正式采用或元进化效果已证实。
- **信号路径**：真实 runner 产出物理量 → 冻结规则做公开预选 → 独立验证确认或拒绝 → owner 决策与加载 → 新任务结果决定后续沿用。后半链当前待完成。

## 场景与节奏

| 页 | 讲什么 | 建议时间 |
|---|---|---|
| 1 | 真实足球录像、近球与远球、对应动作样本 | 1:30 |
| 2 | 环境、数据、harness、model、eval、tracing 的实际准备 | 2:30 |
| 3 | 足球各版本的完整结果与取舍；可展开历史行走基础 | 3:00 |
| 4 | 四阶段当前走到哪里 | 3:00 |
| 5 | 对象版本与方法版本 | 2:30 |
| 6 | 用反例检验元进化主张 | 2:30 |
| 7 | 和原 PPT 四轴图对齐 | 3:00 |
| 8 | 哪些已做到，后续如何验证 | 2:00 |

环境、数据、控制、模型、评估、观测均可成为改进对象；每轮选择一个清楚的对象与 claim。足球一直是总目标；不训练新网络仍可组合官方 walking / standing / kick 并改进控制与实验。确定契约用测试，运行健康用日志/指标，效用用有 consumer 的评估，不要求每层都跑 eval。

## 证据与更新

足球证据从 `../pipeline/football/evidence/` 的 fixed-kicks、approach-v1/v2/v3 与 v3-extended 五份归档构建。读取各自 archive manifest 校验 index、选用 capture、录像和截图；解压后的 capture 另核原始 hash。合计 36 场景、30,636 条状态，16 段完整录像，讲解页内嵌其中 10 段。v2 原 index 的 `video: null` 保持不变；独立的 `media-run.json` 必须与原运行的计划、环境、模型、依赖、代码和 capture hashes 全部一致才能配入。样本明确显示为“首次触球对应控制帧”或“无触球末帧”，完整轨迹仍在仓内。

v1 因命令过小未起步，v2 保持纵向步态后已踢到直线远球；纯侧移/原地转向对照又推动 v3 保持前进走弧线。v3 的两个偏侧场景在 20 秒仍未完成；单独预声明的 26 秒补充中，前 20 秒状态逐条相同，左右于 22.35 / 21.365 秒真实触球、无提前接触或跌倒。各版取舍与原失败结果均可切换。原始来源见 [足球准备总览](../pipeline/football/README.md)。球和地面的 `condim=3` 未启用滚动摩擦，最终长距离滚动不用于足球策略排名；目标 +X 位移不等于球门命中。

`football-extension.mjs` 在构建读取入口对两份归档做交叉守卫：左右场景各解压原 1,001 条与扩展 1,301 条状态，检查完整前缀、截至 20 秒的全部事件及零触球；计划只允许预声明的 20→26 秒和两个既有 case，控制器、算法、模型、场景与运行环境固定。两次 runner 仅增加 CLI plan 选项的差异绑定原始文件 hash 对，不能任意忽略 runner 变化。即使替换轨迹后重写自身 manifest，也不能继续生成“前 20 秒相同”的说明。回归测试只改临时归档副本，不改历史原件。

`project-evidence/public-evaluation.json` 来自 T1 已提交并获代码审阅通过的版本 `82c58336e89fb47987bbacc3d29f01e47c6880ad`，是**公开实验文件快照**，不是独立 holdout 结果或 owner 已发布证书。最终 runner 为 `af6a754c0392fa9ee76983d812b7db393ff256cd`；5 组公开 metric 与原 `6fa17cb6` 快照逐值相同，公开预选也未变。新 receipt `97d3a31a4b2b7c881a2deddb74b3ae6f309ce95a61cd1b96ccea1aae4abe9ece` 替代旧 `6e88fb23`，不混用旧 runner ref。`project-evidence/provenance.json` 记录来源、文件 SHA、runner revision、review source 与读到的 Program 序号。证据缺项时构建拒绝；正式 Program 准备项不由该快照补齐。`assets/meta-evolution.png` 为本 source 的用户附件；`assets/baseline-space.png` 为仓内官方 Space 基线截图，仅作场景说明，不是本次候选结果。

候选 0.90 / 1.05 / 1.10 在结果之前于 `e7970bed05a48670030843499645513fd7445039` 预注册；当前 runner revision 由收录 receipt 指定。判据沿用已经合入的 `pipeline/src/evaluator.mjs`：public 与 holdout 每臂 n≥8，距离增益大于 2 倍合成标准误，存活率点估计不得下降；不为过线修改判据。

## 打开与验证

直接打开 index.html 即可离线讲解；图片、样式、脚本与公开证据已内嵌。没有网络请求，没有后端写入。方向键切页，Space 暂停或继续，N 切讲者笔记，F 全屏；默认为手动讲解。切页或打开证据对话框会暂停计时。计时默认约 20 分钟，不自动播放配音。

从 repo 根目录运行：

```bash
node docs/videos/f311-microduck-roadshow/briefing/build.mjs
node docs/videos/f311-microduck-roadshow/briefing/build.mjs --check
node --test docs/videos/f311-microduck-roadshow/briefing/briefing-model.test.mjs docs/videos/f311-microduck-roadshow/briefing/football-model.test.mjs docs/videos/f311-microduck-roadshow/briefing/football-assets.test.mjs docs/videos/f311-microduck-roadshow/briefing/football-extension.test.mjs docs/videos/f311-microduck-roadshow/briefing/briefing-ui.test.mjs
```

UI 测试复用仓内 Playwright，以 `file://` 验证断网运行、真实读数、暂停/切页、反例控件、原图展开、证据下载和 1440/390 宽度；截图默认写 `/tmp/cat-cafe-evidence/f311-meta-briefing`。公共证据解析与方法条件测试先真实 RED，再 GREEN。所有静态资产在构建时 SHA 校验；`--check` 检查提交 HTML 是否与源文件和证据一致。

正式发放前按最新 owner 证据更新 `project-evidence/provenance.json` 与收录 receipt，核对叙事状态及讲者笔记，然后重建并复验。公开实验准备与正式 Program 是不同快照；没有证据的步骤继续显示“待完成”。当前 snapshot 不含 hidden seeds 或任何采用凭据。

## Author 验证范围

五轴：行为为展示页切页、计时与条件判断；数据仅为公开文件快照和用户附图；无权限、生产写入、owner 契约或不可逆变更。Architecture cell 为现有 F311 roadshow，Map delta: none，原因是独立讲解载体、不增加生产组件。

2026-09-07 已实跑 5 项模型行为测试与 1 项整条浏览器旅程测试（内部含八页、两种宽度、离线无网络、原图、证据下载等断言）。原图 SHA 与上传附件一致。1440 桌面与 390 手机画面已人工查看；控制条保持可用。`designs/meta-evolution-workspace.pen` 是原生 Workspace 四阶段/窄栏稿；本页使用另行冻结的 external_showcase 视觉契约及用户原图，不把展示壳当产品实现。根 Biome 配置明确排除 `docs/videos`，因此不把“0 files processed”记为 lint PASS；以 Node 语法、构建一致性、行为测试与浏览器证据检验本切片。

第一轮足球修正的 author preview 来自隔离 worktree `cat-cafe-f311-football-probe` 内 `briefing/index.html` 的 file URL；当时实跑 9 项模型/浏览器测试，包含四段视频与 8/10 场景表，截图在 `/tmp/cat-cafe-evidence/f311-football-briefing-20260907/`。

新增 v2/v3 后，已在同一隔离 worktree 上通过共享 `standalone-web-browser` 资源池重跑 **12/12（零跳过）**：十段真实 MP4 均可解码、默认最新偏侧回放可播放、触球定位/从头查看、61/14 维样本、2/8/10 场景完整表、原超时不被补充实验覆盖、旧行走结果、离线无 HTTP 与八页的 1440/390 宽度。新截图位于 `/tmp/cat-cafe-evidence/f311-football-briefing-v3-20260907/`，桌面及手机开场已目视核验。归档媒体来源检查真实 RED→GREEN，并拒绝改计划、改控制器或 capture 不同的近似复跑。历史 4188 预览有过期时间，不再承诺在线。独立 review 与总项目真实四阶段验收仍按各自证据推进。
