---
name: video-forge
description: >
  视频制作全链路：素材入库 → 剧本冻结 → 全局配音 → 对齐 → 渲染 → 审查 → 交付。
  Use when: 做视频、做 showcase、做教程视频、录屏剪辑、video review、节奏审查。
  Not for: 纯代码开发（用 worktree/tdd）、纯文档写作（直接写）、PPT（用 ppt-forge）。
  Output: schema 驱动的视频成片 + 多猫审查通过 + 可发布。
---

# Video Forge — AI 视频生产线

> 关联 Feature: [F138 Video Studio](../../docs/features/F138-video-studio.md)
> 技术收敛纪要: [2026-04-05 三猫收敛](../../feature-discussions/2026-04-05-f138-video-pipeline-tech-convergence.md)

## 核心原则

**视频不是一只猫的活，是三猫流水线 + 铲屎官素材。**

- Ragdoll：video-spec 编排 + Remotion 渲染 + 对齐集成
- Maine Coon：音画同步 QA + 事实审查 + schema review
- Siamese：节奏/调性审查 + 字幕/排版设计 + retiming 风格把关
- 铲屎官：素材录制 + 粗标时间点 + 剧本确认 + 审片

### 铁规矩

1. **全局音频，不段级切碎** — TTS 拿完整剧本一口气读完，保住情绪和呼吸感（KD-12）
2. **不赌 TTS 原生 timestamps** — forced alignment 出时间戳（KD-10）
3. **拒绝暴力慢放** — 画面不够时：FREEZE_STYLIZED > B_ROLL > SLOW_MO（KD-14）
4. **Contract 和 Renderer 解耦** — video-spec JSON 是真相源，Remotion/FFmpeg 是可替换渲染器

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
| 配音方案 | 猫猫配音 / 纯字幕 / 原声 | Ragdoll旁白 / 三猫声线 / 无配音 |

**没有开局参数 = 审查没有标准。开工前必须和铲屎官确认。**

## 场景路由（路径 B）

| 触发 | 场景 | 主导 | 说明 |
|------|------|------|------|
| 铲屎官说"做个视频" | **A: Brief + 素材盘点** | Ragdoll | 确认开局参数 + 分镜表 + 素材需求清单 |
| 铲屎官确认分镜 | **B: 素材入库** | 铲屎官录 + Ragdoll压缩归档 | 素材放 `docs/videos/{project}/assets/`，粗标写 `asset-markers.md` |
| 素材到齐 | **C: video-spec 冻结** | Ragdoll | 写 video-spec JSON（4 层 segment contract），铲屎官确认 |
| spec 确认 | **D: 全局配音 + 对齐** | Ragdoll | CosyVoice 全局配音 → Qwen3-ForcedAligner → word_timestamps |
| 对齐完成 | **E: Remotion 渲染** | Ragdoll | schema → inputProps → preview render |
| 预览版出来 | **F: 审查 Gate** | 三猫 + 铲屎官 | 见下方审查标准 |
| 审查通过 | **G: Final Render + 交付** | Ragdoll | 高质量渲染 + 封面导出 + 发布 |
| 铲屎官不满意 | **R: Patch Loop** | Ragdoll + Siamese | retiming / 重录 / 重写段落 |

## 审查 Gate（F 场景）

### F1: 音画同步审查（Maine Coon）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 配音和画面脱节 | 说到 X 时画面不是 X |
| P1 | 时间戳偏移 | 字幕和声音对不上（>200ms） |
| P1 | 音频断裂 | 段间有不自然的静音或跳跃 |
| P2 | 音量不均 | 原声和配音音量差异大 |

### F2: 节奏/调性审查（Siamese）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 暴力慢放 | 画面被强行降速拉伸，卡顿拖沓 |
| P1 | 节奏断裂 | 高燃段突然变慢 / 温馨段突然快切 |
| P2 | vibe 不连贯 | 整体情绪没有起承转合 |
| P2 | 字幕风格不一致 | 不同段落字幕样式混乱 |

### F3: 内容审查（铲屎官）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 事实错误 | 展示的功能/数据不对 |
| P1 | 敏感信息泄露 | 截图里有 token / API key / 私人信息 |
| P2 | 画面选取不佳 | "这段换个更好的片段" |

## 素材管理规范

### 目录结构
```
docs/videos/{project-name}/
├── asset-markers.md       ← 素材标注表（铲屎官 + Ragdoll共同编辑）
├── video-spec.json        ← segment contract（Ragdoll生成）
├── voice-script.md        ← 配音剧本（Ragdoll草稿 + 铲屎官确认）
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

### 粗标格式（铲屎官填）
```
时间 | 画面内容
0:00 - 0:50 | 铲屎官在打字
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
| 加速后沿用原始时间轴切段 | **加速会压缩时长，后续段的起始时间必须重新计算。** 例：A 段原 130s 以 2x 输出 65s，B 段在 final timeline 从 65s 开始而非 130s。用 output duration 逐段累加，不要用 source timestamps 直接拼 |
| 只加速长等待段忽略短等待 | 分段不够细时，"Thinking"状态可能散落在多个区间里。逐段审素材，把所有等待态都标出来分别处理 |

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

路径 B 完整流程跑通后 → `quality-gate`（自检）→ `request-review`（Maine Coon审音画，Siamese审节奏）
