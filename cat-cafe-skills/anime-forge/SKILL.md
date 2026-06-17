---
name: anime-forge
description: >
  AI 生成动画短片生产线：图（关键帧锁确定性）→ 视频（i2v 给活气）→ 后期（剪辑做节奏）。
  Use when: 做动画短剧/角色 IP 短片、猫咖日记系列新集、图生视频管线、剧情类 AI 视频。
  Not for: 录屏/教程/showcase 视频（用 video-forge）、单张图生成（用 image-generation）、PPT（用 ppt-forge）。
  Output: charter+分镜+prompt book+素材账本+EDL 驱动的成片，全程可复现可重渲。
---

# Anime Forge — AI 动画短片生产线

> 出生：EP01「醋醋喵诞生记」（2026-06-10~12，docs/videos/cucu-pr-flow/）。本 skill 的每条规则都对应一次真实翻车或一次实测验证，n=1 边界诚实标注——竖屏重制就是第一次 dogfood，踩到新坑回来补 Common Mistakes。

## 为什么是 skill（价值门禁）

不教"什么是 i2v"。只沉淀：实测分工路由（中文乱码）、prompt 配方（四次翻车打磨）、工程纪律（防 operational cost 跑偏重演）、六个真金白银的坑。

## 第一性架构：确定性分层

**视频模型不能同时当导演、UI 设计、演员和剪辑师。** 把确定性按层分配：

| 层 | 负责 | 绝不交给它的 |
|---|---|---|
| 图（关键帧） | 画风、角色一致性、屏幕文字、构图 | — |
| 视频（i2v） | 活气：表情微动、小动作 | 精确文字、节奏、画风决定权 |
| 后期（剪辑） | 节奏卡点、字幕、SFX、时间字卡 | — |

推论：**状态卡/信息卡镜头根本不需要 i2v**——静帧+剪辑切=零抽卡。EP01 11 镜头只抽了 8 个视频。

## 流程（每步指向真相源，不复制）

1. **立项 charter**（operator signoff 的 scope/路线/预算护栏/Non-goals）→ 范例 `docs/videos/cucu-pr-flow/episode-brief.md`；轻量立项规则见 shared-rules §21（LL-071：先对齐再批量产出）
2. **分镜表**：每镜头唯一验收点（一镜一梗）+ 类型 + 方法 + FM 标签 + 3 连败降级预案 → 范例 `shot-plan-v0.1.md`
3. **Prompt book**：图 prompt + i2v prompt 全部写成可复制块，含 per-shot 翻车修法 → 范例+配方 `prompt-book-v0.1.md`（§0.5 附图铁则 / §0.6 i2v 五段配方——**从实测成功原文最小修改，禁止凭理解重写**）
4. **生产 roll**：每 prompt ≤3 roll；roll 判定/FM taxonomy 用 `review-protocol-v0.1.md`；30 秒人工验收四问（画风像锚图吗/人物比例/文字可读/构图漂没漂）
5. **素材账本**：入库即登记 md5/时长/状态；视频 gitignored 账本作存在证明 → 范例 `assets/README.md`
6. **Animatic 检查点（行为刹车）**：烧贵素材前先用静帧+占位拼粗剪验证节奏；剧本结构问题（见下）必须在这层抓
7. **EDL 渲染**：`animatic/edl-v1.mjs`（时长/字幕/段序真相源）+ `build-animatic.mjs`（零 npm 依赖：Chrome 当字幕/字卡渲染器 + ffmpeg）——改数字重渲，画幅参数化

## 实测分工路由（硬约束，不是偏好）

| 任务 | 路由 | 实测依据 |
|---|---|---|
| 含中文文字的图/卡 | GPT 系生图 | Google 系图/视频中文乱码（2026-06-12 实测） |
| i2v 生视频 | Gemini 系 | 时长遵守 prompt 的 N-second 指令（非固定 10s） |
| 字幕/字卡/注解 | 本地 Chrome 渲染 + ffmpeg overlay | 中文完美、零成本、绕开无 libass |

## 剧本结构（导演层 checklist）

- **喜剧 = 预期 vs 现实，预期端必须拍**（任务多小/时间多久）——EP01 初剪"观众看不懂"就是只拍了现实端
- **动机闭环**：种子（S00 宣布）→ 潜意识曝光（用自己的头像）→ OS 自白 → 定罪 → true end（爱）
- 真实素材 payoff：片头承诺（"呈堂证供"）片尾兑现（聊天截图证据卷轴）
- 内心 OS 用独立字幕样式（os 参数）；时间跳跃用默片字卡（intertitle.html）

## Common Mistakes（全部实测，持续补）

| 错误 | 后果 | 修复 |
|---|---|---|
| i2v prompt 写风格描述词 | 邀请重采样→第二帧跳变 | 风格 100% 来自首帧，prompt 零风格词（配方 §0.6） |
| 正面段写 "the man/adult human" | 往写实拉 | 角色用名字；反幼态只进末尾负面清单 |
| 动作太稀（10s 只给 2 动作） | 模型自己编戏 | 3-4 个 Then 串联填满时间线 |
| 图 prompt 不附参考图 | 画风每次重新采样 | 附图铁则：参考图+reference 第一行（§0.5） |
| 猫角色只靠首帧锁 | "cat" 写实先验拉跑 | Keep cartoon 句 + Do not realistic 双保险 |
| 库里有实测成功配方却凭理解重写 | 四个新自由度同时引入，连环翻车 | 从原文最小修改，一次只动一个变量 |
| 先生产后对齐 | operational cost 跑偏（LL-071） | charter 先行；批量产出前一句话确认路线 |
| 不先问素材画幅就定输出画幅 | 横竖分裂，pad 兜底但割裂 | 开抽前统一画幅；混了用 blur-pad 过渡，终态重抽 |
| 静态 PNG overlay 长片尾段 | ~66s 后 framesync 失效字幕全挂 | PNG 输入加 `-loop 1`（builder 已内置） |
| 字幕长句贴 max-width | 折行被渲染窗裁掉 | 字号留安全区；改完必抽帧亲眼验 |

## 和其他 skill 的区别（GOTCHA）

- **video-forge**：录屏/教程/showcase 范式（素材是录的）——anime-forge 素材是**生成**的，核心难题是控制生成模型。做"产品演示视频"→ video-forge；做"有角色有剧情的动画"→ 本 skill
- **image-generation**：单图生成能力——本 skill 消费它（关键帧步骤），但管的是全片生产
- **ppt-forge**：静态页面交付——无时间轴

## 下一步

新集立项 → feat-lifecycle（轻量 charter）；写分镜/prompt 直接抄 EP01 范例改内容；渲染问题先查 `build-animatic.mjs` 注释里的坑。
