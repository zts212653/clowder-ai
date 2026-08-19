---
name: sprite-forge
description: >
  角色动态 sprite / 桌宠皮肤 / atlas 状态行生产线：母图锚身份 → Frame A 首帧 →
  AI 视频生成（人工环节）→ 截帧确定性加工 → atlas row + 三道闸。
  Use when: 做桌宠皮肤、给猫补新状态动画行、visible-cafe/F258 猫形象素材、
  角色小循环动画（呼吸/走路/睡觉/挥手级）、把静态角色"做成动态的"。
  Not for: 动画短片成片（用 anime-forge）、录屏/教程视频（用 video-forge）、
  单张静态图/头像（用 image-generation）、UI 图标。
  Output: 192×208 atlas row strip + QA 包（contact/GIF/provenance）→ 过三道闸 + operator identity veto 后接 pet.json。
---

# Sprite Forge — 角色动态素材生产线

> 出生：F229 xianxian-codex 9 态 atlas 的实际生产管线（2026-06-22~24，`video-to-spritesheet-pipeline.md`）。
> Skill 化诱因：F258 素材首跑两连翻车（2026-07-08）——猫不知道家里有这条验证过的路，临场发明了两条被淘汰的路线（32px 手搓 + imagegen 逐帧直出），operator 连续两次 identity veto 后拉闸："未来做动态的东西，你们要能想到用这个 skill。"

## 第一性原理（本 skill 的灵魂判断）

**动画的帧间一致性问题，靠换介质解决，不靠更好的 prompt。**
imagegen 逐帧独立生图 = 体型漂移、风格跳变、帧间无时序关系（Spike R2 实证，59×64 显示尺寸下可感知劣于视频截帧）。视频模型天然时序连贯——所以生成层必须是**视频**，图像模型只出首帧。

## 管线五步（人猫协作产线，人工环节是设计的一部分）

| 步 | 做什么 | 谁 | 关键约束 |
|---|---|---|---|
| 1 锚身份 | 取角色设定母图（KD-21 视觉 canon） | — | 母图库=`docs/videos/cucu-pr-flow/assets/references/character-sheets/`（按角色名对应 `*-r0N.png` 四足设定图） |
| 2 生成首尾帧 | imagegen 出 **Frame A + Frame B 两张**（1024×1024 纯白底）：A=基准姿态，B=同姿态仅微小差异（"Only differences: ... Everything else IDENTICAL"句式） | 生图猫（须原生 imagegen；prompt 可由更贵的猫代写） | 强 2D 风格锚；母图作 reference image 传入；**每次只做一个状态**；B 帧锁不住（缩放/构图漂移）→ 降级单图 i2v 只用 A 帧 |
| 3 拍视频 | AI 视频工具生成 2-3s 循环：**首尾帧模式（A+B，更可控）优先；单图 i2v（只喂 A，更稳）备选** | **人工（operator / 云端 Gemini）** | 16:9 横屏 / 低运动强度 / 2D 锚 + 反 3D negative（模板见真相源 §3） |
| 4 截帧加工 | ffmpeg 截帧 → 抠图 → 缩放 → 拼 row | **廉价猫（sonnet 级）即可**——纯确定性命令活，别烧贵猫 | 确定性工具链，命令见下 |
| 5 验收 | 三道闸 + 分批审 | 主审猫 + **operator identity veto 终审** | 每批过了才做下一批（2-2-3 批次制先例） |

## 截帧加工命令（Step 4 速查）

```bash
ffmpeg -i video.mp4 -vf "fps=4" frame_%02d.png          # 2-3s → 8-12 帧
magick frame_01.png -fuzz 10% -transparent white f1.png  # 白底转透明（脏边则重跑 despill）
magick f1.png -resize 192x208 -gravity center -extent 192x208 cell_01.png
magick cell_*.png +append state_row.png                  # 拼 row strip
magick cell_01.png -resize 59x64 preview.png             # 必做：缩到实际显示尺寸目检
```

## 工艺红线（每条都是真翻车）

1. **2D 风格锚是保命符**：视频 prompt 首行必须 `2D hand-drawn anime illustration style, flat cel-shaded coloring, clean visible outlines` + negative 排除 `3D/CGI/photorealistic/plastic/Pixar`——不加锚视频秒变塑料 3D（R1 实录）
2. **16:9 横屏**：9:16 会把尾巴甩出画框（R1 实录）
3. **运动强度调低**：大幅运动=角色变形
4. **约束宜简（五爪判例）**：一页解剖学约束反而让模型逐条画出每个被提到的爪→五爪；operator 一句"不要生成五只猫爪了"完美通过。**简单意图 + 一句负面 > 详细规格书**
5. **主审第一问是"这是不是我们家那只猫"**，不是特征锚清单——checklist 全过 + operator"不像"= false pass（F229 r3-alpha 与 F258 两次翻车同型）
6. **实战提示词必须回流**：Step 3 人工环节实际用的提示词（含中途修正版）才是被验证的版本——生产完成后回流 prompt-pack/provenance。理论版翻车靠人工修正救活却不回流 = 下一只猫在同一个坑再摔一遍

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| imagegen 逐帧直出动画 row | 帧间漂移；被 operator identity veto（2026-07-08 实录） | 生成层换视频（第一性原理） |
| 手搓低分辨率像素格 | "看不出是猫"（2026-07-08 实录） | 高清生成→工具缩放，宽松生成确定性加工 |
| 拿 atlas 截图当身份 canon | 分辨率层面"像"，母设定层面"不像" | canon = character-sheets 母图，不是下游产物 |
| 读了素材池 README 就动工 | 把合规层（hatch-pet/三道闸）误当生成层 | **先读 `video-to-spritesheet-pipeline.md` 全文**再动手 |
| 一次铺满所有状态 | 打回成本×N | 每次一个状态行，分批过 operator |
| 跳过 59×64 实际尺寸预览 | 大图好看小图糊 | Step 4 最后一条命令必跑 |
| 把状态表达物（微粒/气泡/道具）烧进素材 | 失去状态绑定，表情从 telemetry 变演技；环境道具还加剧视频漂移 | 素材只含猫本体动作；粒子/道具/光效归渲染层按状态叠加（F258 S2/S3 判例） |
| **高遮挡姿势 prompt**（紧蜷 donut / 肢体交叠） | 视频模型省略被遮挡躯干——生成"头+巨尾"解剖不完整猫（2026-07-09 S1 实录，operator 抽卡翻车） | 蜷姿描述留躯干可见弧线（curled 但 body visible）；抽卡 2-3 败即换姿势写法别硬 roll；修正成功版按红线 6 回流 |

## 与其他 skill 的区别

- `anime-forge`：产**短片成片**（分镜/EDL/节奏）——sprite-forge 产**可循环状态行素材**；共享"图锁确定性→视频给活气"哲学
- `image-generation`：单张静态图——不解决帧间一致性
- GOTCHA：本 skill 含人工环节（拍视频），**不是全自动管线**；发任务书时必须显式安排"谁拍视频"（operator 或云端 Gemini），不可默认猫能自己完成

## 真相源（重材料按需读，不复制进上下文）

- **完整提示词模板库 + Spike 数据 + 9 态任务表**：`docs/features/assets/F229/desktop-pet-sprite/video-to-spritesheet-pipeline.md`
- **近例 prompt pack（首尾帧句式 + 渲染分层决策范例）**：`docs/features/assets/F258/prompt-pack-v1.md`
- cell 规格与三道闸（合规层）：`docs/features/F229-petskin-contract.md`
- pet.json atlas 格式实例：`packages/web/public/concierge/skins/xianxian-codex/pet.json`

## 下一步

素材过全部闸门 → 接 `pet.json` / 渲染层（代码改动走 `worktree` + `tdd`）→ 新猫皮肤开整套 = 回 Step 1 换母图。
