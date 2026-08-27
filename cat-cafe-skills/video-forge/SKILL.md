---
name: video-forge
tips_exempt: renewed for agent-product-promo-director routing and risk-matched review guidance; this changes cat production discipline, not a user-invokable product capability
description: >
  视频制作全链路：素材入库 → 剧本冻结 → 全局配音 → 对齐 → 渲染 → 审查 → 交付。
  Use when: 已明确要制作视频、做 showcase、做教程视频、录屏剪辑、video review、节奏审查。
  Not for: Agent 产品宣传片仍未锁定主角、观众信念与导演语法（先用 agent-product-promo-director）；
  只找时效性外部参考（用 deep-research）；纯代码开发（用 worktree/tdd）、纯文档写作（直接写）、PPT（用 ppt-forge）。
  Output: schema 驱动的视频成片 + operator 创意验收 + 风险匹配的技术审查 + 可发布。
---

# Video Forge — AI 视频生产线

> 关联 Feature: [F138 Video Studio](../../docs/features/F138-video-studio.md)
> 技术收敛纪要: 2026-04-05 三猫收敛

## Intent Gate：研究不是开机令

进入生产线前先判用户要解决的究竟是哪一个问题：

| Intent | 用户真正要的 | 本轮输出 | 禁止偷换成 |
|---|---|---|---|
| `research` | “宣传片该怎么剪”“看看别人怎么做”“有什么剪辑手法/Skill” | `agent-product-promo-director` 的主角/故事/镜头/声音合同；时效性案例由 `deep-research` 供证 | 挑一个现成页面直接录制或渲染试片 |
| `production` | 明确要求拍、剪、录、配音或渲染某一支片 | 下方开局参数 + 正式生产线 | 用研究报告代替成片 |
| `review` | 判断一支已有视频哪里对/错 | 对已有 artifact 的可见性、内容与节奏 verdict | 未经要求另拍一版 |

- 用户拿一个真实 thread、页面或旧片举例，只证明它是候选素材/证据，**不自动授权把它选成宣传片主题**。
- `research` 或 brief 未锁先走 `agent-product-promo-director`；需要近期外部参考时再由它调用 `deep-research`。只有用户明确转入 `production` 且主角/格式/beat sheet 已锁，才继续本 Skill。
- 意图模糊且开机会制造新素材时，留在可逆的 research/brief 层，并明确当前假设；不要用“先做个 rough cut 看看”代替方向判断。

> 失败史（2026-08-25）：用户最初要求研究真实 AI 产品宣传片的剪辑与叙事，团队却围绕一个 crime-wall 页面连续制作多版试片；后来即使修复了“PPT 化”的 motion 问题，仍然没有回答原问题。根因不是导演技巧不足，而是把 reference research 错路由成了 production。

## Narrative Subject Gate：产品是主角，成果只是 proof

产品宣传片在写分镜前，先用一句话回答：**观众看完应该想要哪个产品？**

- 合格主语：用户的愿望进入产品 → 产品把它变成共享目标 → 猫猫在产品里记忆、接力、用工具、碰壁并纠错 → 共享工作区中的成果逐渐长出来。
- 成果只承担 proof：网页、报告、代码或图片证明前面的产品过程真的完成了工作；它们不能取代产品成为整支片的 hero。
- 视觉主线要持续留在产品世界中：thread、球权、记忆、工具状态、workspace 与人类反馈是连续动作，不是成品前的一组过场字卡。
- 替换测试：把片中的具体成果换成另一种成果，若故事就不再成立，说明 brief 卖的是那个成果，不是 Clowder AI。
- 创意主语、情绪与“像不像我们”由 operator 验收；同行 review 可以审事实、技术和证据纪律，不能替代创意 ground truth。低风险玩票式试验直接找 operator 校准，不用同行 review 代替 taste 判断。

任一项不成立 → 停在 brief，不进素材、分镜或渲染。

> 失败史（2026-08-25）：修正 Intent Gate 后的首版 hero blueprint 虽然写到了多猫协作，却仍让 crime-wall artifact 承担视觉高潮。operator 指出“我们卖的是自己的产品，不是做出来的那个东西”；根因是 brief 有过程词汇，但没有锁定叙事主语与创意验收者。

## 核心原则

**视频职责要覆盖，但不默认拉多猫。** 一只执行猫可以兼任编排、渲染与低风险技术 QA；只有风险路由要求独立验证、任务确实需要专长，或 operator 明确要求时才找其他猫。创意 ground truth 始终回 operator，不能用同行 review 替代。

- 主执行猫（当前持球猫）：video-spec 编排 + 渲染 + 对齐集成 + 自证
- 风险匹配的独立验证者（按需）：音画同步、事实、安全、schema 或发布风险
- operator：创意主语、情绪、剧本与成片验收；玩票/低风险试验直接走此通道

### 铁规矩

1. **全局音频，不段级切碎** — TTS 拿完整剧本一口气读完，保住情绪和呼吸感（KD-12）
2. **不赌 TTS 原生 timestamps** — forced alignment 出时间戳（KD-10）
3. **拒绝暴力慢放** — 画面不够时：FREEZE_STYLIZED > B_ROLL > SLOW_MO（KD-14）
4. **Contract 和 Renderer 解耦** — video-spec JSON 是真相源，Remotion/FFmpeg 是可替换渲染器
5. **镜头内部必须发生事情** — 产品片 / showcase 的主要叙事节点必须有主体、UI 或状态随时间变化；静帧上的推拉、平移、溶解只算镜头包装，不算动作素材
6. **产品是主角，成果只是 proof** — 过程持续展示产品如何组织协作；成品只证明它做成了，不能抢走叙事主语

## 两条生产路径

| | 路径 B：先脚本后素材 | 路径 A：先素材后配音 |
|---|---|---|
| 触发 | "做个 showcase/教程视频" | "这段录屏帮我配个音" |
| 人的输入 | 分镜脚本 + 素材 + 粗标 | 原始视频 + 风格关键词 |
| spec 来源 | 人写 | 模型生成（PySceneDetect + VLM） |
| Phase | Phase 1 主攻 | Phase 3 引入 |

两条路径共享同一套 segment contract + 渲染层。

## 开局参数（必须声明）

| 参数 | 说明 | 示例 |
|------|------|------|
| 类型 | 视频类型 | showcase / 教程 / 攻防战 / 播客 |
| 时长目标 | 成片目标时长 | 60s / 3min / 6-8min |
| 调性 | 整体情绪基调 | 真实生活感 / 高燃极客 / 温馨猫咖 |
| 受众 | 谁看这个视频 | linux.do 社区 / B 站观众 / 内部 |
| 配音方案 | 猫猫配音 / 纯字幕 / 原声 | 单猫旁白 / 多猫声线 / 无配音 |

**没有开局参数 = 审查没有标准。开工前必须和operator确认。**

## 场景路由（路径 B）

| 触发 | 场景 | 主导 | 说明 |
|------|------|------|------|
| operator说"做个视频" | **A: Brief + 素材盘点** | 主执行猫 | 确认开局参数 + 分镜表 + 素材需求清单 |
| operator确认分镜 | **B: 素材入库** | operator录 + 主执行猫压缩归档 | 素材放 `docs/videos/{project}/assets/`，粗标写 `asset-markers.md` |
| 素材到齐 | **C: video-spec 冻结** | 主执行猫 | 写 video-spec JSON（4 层 segment contract），operator确认 |
| spec 确认 | **D: 全局配音 + 对齐** | 主执行猫 | CosyVoice 全局配音 → Qwen3-ForcedAligner → word_timestamps |
| 对齐完成 | **E: Remotion 渲染** | 主执行猫 | schema → inputProps → preview render |
| 预览版出来 | **F: 审查 Gate** | 主执行猫自证 + operator；风险命中时再加独立验证者 | 见下方审查标准 |
| 审查通过 | **G: Final Render + 交付** | 主执行猫 | 高质量渲染 + 封面导出 + 发布 |
| operator不满意 | **R: Patch Loop** | 主执行猫 + 视觉把关猫 | retiming / 重录 / 重写段落 |

## 审查 Gate（F 场景）

### F1: 音画同步审查（QA/审查猫）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 配音和画面脱节 | 说到 X 时画面不是 X |
| P1 | 时间戳偏移 | 字幕和声音对不上（>200ms） |
| P1 | 音频断裂 | 段间有不自然的静音或跳跃 |
| P2 | 音量不均 | 原声和配音音量差异大 |

### F2: 节奏/调性审查（视觉把关猫）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 暴力慢放 | 画面被强行降速拉伸，卡顿拖沓 |
| P1 | 节奏断裂 | 高燃段突然变慢 / 温馨段突然快切 |
| P1 | PPT 化 / 假运动 | 主要叙事节点只轮播静帧；唯一时间变化来自推拉、平移、字幕或转场 |
| P2 | vibe 不连贯 | 整体情绪没有起承转合 |
| P2 | 字幕风格不一致 | 不同段落字幕样式混乱 |

#### F2.5: Motion Evidence Gate（产品片 / showcase）

在预览渲染前，逐个主要叙事节点回答：**画面内部发生了什么？**

- 合格证据：真实录制的操作/反馈、purpose-recorded UI 状态变化、主体动作，或实际动画合成中的形变/接力/聚合。
- 不合格替代：对静态截图做 Ken Burns 推拉、横移、溶解、字幕入场；这些可以辅助动作，但不能独自承担动作。
- 若本轮要验证的是运镜、节奏或剪辑，预演必须包含真实时间变化；style frame / 静态分镜只能验证构图与美术，不能冒充 motion animatic。
- 任一主要节点没有 motion evidence → **BLOCK 预览交付**，回到素材补录或动效合成；不得再靠旁白、音乐或更多转场补偿。

> 失败史（2026-08-25 crime-wall）：连续两版用 viewport motion 移动录屏，第三版把六张精修静帧放上时间轴；技术检查均绿，但观感依次是“晕”“怪”“PPT”。共同根因是把 camera motion 当成了 subject motion。

### F3: 内容审查（operator）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 事实错误 | 展示的功能/数据不对 |
| P1 | 敏感信息泄露 | 截图里有 token / API key / 私人信息 |
| P1 | 叙事主语错位 | 影片卖的是某个页面/文件，而不是产品如何让协作发生 |
| P2 | 画面选取不佳 | "这段换个更好的片段" |

## AI 视频生成（短片段素材）

当素材来源是 AI 生成（而非人工录制）时，使用可用的视频生成工具（如 MCP 提供的 text2video / image2video 能力）。

### 单段限制

AI 视频生成 API 通常有单次时长限制（如 4-6 秒）。**不要试图用一次调用生成完整长视频。**

### 多段生成策略

目标时长超过单次限制时：
1. **分镜拆段**：按 video-spec 的 segment contract 拆分，每段一个生成任务
2. **逐段生成**：每段独立 submit → poll → 获取 resultUrl
3. **下载素材**：将各段视频下载到 `docs/videos/{project}/assets/` 目录
4. **FFmpeg 拼接**：按 segment 顺序拼接，注意转场处理
   ```bash
   # 简单拼接（同编码格式）
   ffmpeg -f concat -safe 0 -i segments.txt -c copy output.mp4
   # 需要重编码时（不同分辨率/编码）
   ffmpeg -f concat -safe 0 -i segments.txt -c:v libx264 -crf 23 -c:a aac output.mp4
   ```
5. **预览拼接结果**：用 rich block 内联播放（见「视频预览」章节）

### 注意事项

- 多段拼接必须过连续性合约（见下方「多段拼接连续性合约」）
- AI 生成的素材视为原始素材，后续配音/对齐/审查流程不变

## 多段拼接连续性合约

多段生成是正常的。假连续性不是。

拼接前先分类目标输出：

| 类型 | 定义 | 拼接约束 |
|------|------|---------|
| **Montage** | 显式多镜头序列 | 异源片段正常；转场可见且有意 |
| **Pseudo-one-shot** | 伪一镜到底 / 连续动作 | 必须通过连续性检查（见 [`refs/continuity.md`](refs/continuity.md)） |

**核心边界**：`concat`、`xfade`、crop、grading 是收尾工具，不是连续性修复工具。源片段不兼容时，后处理可以打磨接缝，但不能把它当作连续性的证明。

### Seam Review Gate（多段 pseudo-one-shot 必过）

成片后、final render 前，逐接缝回答 5 问：

1. 角色是否仍然是同一个？
2. 环境是否仍然是同一个场景？
3. 色温是否足够稳定？
4. 镜头方向是否连贯？
5. 运动是否暗示同一个动作，还是独立片段？

**任一项 "否" → 不能宣称 pseudo-one-shot → 走降级路径**（见 [`refs/continuity.md`](refs/continuity.md)）。

> 详细的事前预测清单、降级路径和 15s 典型失败案例见 [`refs/continuity.md`](refs/continuity.md)。

## 素材管理规范

### 目录结构
```
docs/videos/{project-name}/
├── asset-markers.md       ← 素材标注表（operator + 主执行猫共同编辑）
├── video-spec.json        ← segment contract（主执行猫生成）
├── voice-script.md        ← 配音剧本（主执行猫草稿 + operator确认）
└── assets/                ← 原始素材（gitignore, 仅本地）
    ├── 1-xxx.mov
    ├── 2-xxx.mov
    └── ...
```

### 素材压缩标准（入库前）
```bash
ffmpeg -i input.mov -c:v libx264 -crf 23 -c:a aac -b:a 128k output.mp4
# 目标：1080p, CRF 23, AAC 128k
```

### 粗标格式（operator填）
```
时间 | 画面内容
0:00 - 0:50 | operator在打字
0:50 - 1:20 | Ragdoll开始回复，1:20 Maine Coon跟上
```

## retiming 策略优先级

当配音长度和画面长度不匹配时，按以下优先级选择策略：

| 优先级 | 策略 | 说明 | 适用场景 |
|--------|------|------|---------|
| 1 | TRIM | 裁剪多余部分 | 画面比配音长 |
| 2 | FREEZE_STYLIZED | 定格末帧 + 毛玻璃/排版 | 配音比画面长，差距小 |
| 3 | B_ROLL | 插入空镜/截图/动效 | 配音比画面长，差距大 |
| 4 | SLOW_MO | 适度降速（≥0.7x） | 仅当画面本身适合慢放 |
| 5 | LOOP | 往复循环 | 最后手段 |

**绝对不允许 <0.7x 的慢放。** 如果需要填充超过 30% 的时间差，必须用 B_ROLL 或 FREEZE_STYLIZED。

## 常见错误

| 错误 | 修正 |
|------|------|
| TTS 逐段切碎生成 | 完整剧本全局配音，forced alignment 分段 |
| 赌 TTS 原生 timestamps | 用 Qwen3-ForcedAligner / WhisperX |
| 画面不够就暴力慢放 | 按 retiming 优先级处理 |
| 没压缩就用原始素材 | 入库前统一压缩（CRF 23） |
| segment contract 扁平不分层 | 4 层：source/narration/render/control |
| 用户问“宣传片该怎么剪”时先拿现成页面试拍 | 先过 Intent Gate；研究只交 reference breakdown + brief，素材示例不是 production 授权 |
| 宣传片围绕一个漂亮成果做 hero reveal | 先过 Narrative Subject Gate；Clowder AI 的协作过程是主角，成果只作 proof，创意方向由 operator 验收 |
| 加速后沿用原始时间轴切段 | **加速会压缩时长，后续段的起始时间必须重新计算。** 例：A 段原 130s 以 2x 输出 65s，B 段在 final timeline 从 65s 开始而非 130s。用 output duration 逐段累加，不要用 source timestamps 直接拼 |
| 只加速长等待段忽略短等待 | 分段不够细时，"Thinking"状态可能散落在多个区间里。逐段审素材，把所有等待态都标出来分别处理 |
| 把 style frames 加转场后当产品视频 | 先过 Motion Evidence Gate；没有镜头内部动作就只交 storyboard/style reel，不交视频预览 |

## 视频预览（Console 内联播放）

生成的视频**必须在 Console 中内联可看**，不要只贴 URL 或本地路径。

### 优先级

1. **本地终稿 / `/uploads/...` URL** → 优先用 `kind:"file"` rich block，`mimeType:"video/mp4"`。Web UI 会直接渲染内联 `<video>` 播放器，并进入 artifact 索引
2. **外部直链 URL**（如云端生成结果）→ 可直接发 `kind:"file"`；若你明确要 `autoplay muted`，再退回 `html_widget` + `<video>`
3. **只有工作区本地文件、还没可访问 URL** → 先放到 `/uploads/...`，再发 rich block；不要直接贴源码路径

### 示例：优先用 file rich block

```
cat_cafe_create_rich_block({
  block: JSON.stringify({
    id: "video-<唯一标识>",
    kind: "file",
    v: 1,
    url: "/uploads/final-cut.mp4",
    fileName: "final-cut.mp4",
    mimeType: "video/mp4"
  })
})
```

### 示例：外部直链需要 autoplay 时再用 html_widget

```
cat_cafe_create_rich_block({
  block: JSON.stringify({
    id: "video-<唯一标识>",
    kind: "html_widget",
    v: 1,
    title: "视频标题",
    height: 420,
    html: "<video controls autoplay muted playsinline style='width:100%;max-width:720px;border-radius:12px'><source src='<resultUrl>' type='video/mp4'></video>"
  })
})
```

### 注意事项

- `file` rich block 保证的是**内联播放器**；如果你要强制自动播放，再考虑 `html_widget` + 外部直链
- 本地视频目前没有图片那样的自动发布合约；要想稳定显示，先显式放到 `/uploads/...`
- 如果 `create_rich_block` 返回 `stale_ignored`，说明回调凭据过期（见 #1092），可尝试在消息文本中嵌入 `` ```cc_rich `` 格式作为降级
- 多段视频先用 FFmpeg 拼接成完整文件，再用一个 rich block 播放最终版

## 技术栈

| 层 | 组件 | License |
|----|------|---------|
| 渲染 | Remotion v4（Phase 1）/ FFmpeg（底层） | Remotion License / LGPL |
| TTS | CosyVoice（已有猫猫声线） | Apache-2.0 |
| 对齐 | Qwen3-ForcedAligner（首选）/ WhisperX（备选） | Apache-2.0 / BSD-2 |
| 队列 | BullMQ（Phase 2 引入） | MIT |
| 切分 | PySceneDetect（Phase 3 路径 A） | BSD-3 |
| VLM | Qwen2.5-VL-3B（Phase 3 路径 A） | Apache-2.0 |

## Next Step

路径 B 完整流程跑通后 → `quality-gate`（自检）→ `request-review`（QA/审查猫审音画，视觉把关猫审节奏）
