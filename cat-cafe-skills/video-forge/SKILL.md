---
name: video-forge
description: >
  家里用 Remotion 做视频要知道的事：工程在哪、本机配音和回听怎么调、You 定过的片子规矩、真踩过的坑、怎么在 Console 里交片。
  Use when: 要做或改一支视频（宣传片、产品界面演示、讲解片、动态排版、录屏剪辑），包括主角是家里的猫、片里有剧情的产品宣传片；
  或给片子配音、对时间轴、交片。
  Not for: 只查某个 Remotion API 怎么写（读官方 remotion-best-practices skill 的 rules/）；
  目的就是讲角色自己故事的动画短片（用 anime-forge）；PPT（用 ppt-forge）。
  Output: Remotion 工程 + Works 中的视频作品与确定版本的交片卡；修改沿原作品续版、回应原意见。
  GOTCHA: 本 skill 不教怎么拍得好看，那靠你自己看片的眼光；2026-10-14 前的长版方法和审美条文把猫带成了「走流程」，已删。
---

# Video Forge：家里做视频要知道的事

> 2026-10-14 从约 9 万字砍成这一页。原来的五步方法、审美条文、导演合同和统计脚本，让做片子的猫把力气花在写稿、量数、过清单上，片子本身反而粗糙：同一支《AI-native builder 的一天》，同一个模型在云端、没装这些 skill，看一遍就指出了字小、角色是静图平移、段间溶解没有载体，而这几条在旧条文里都写着禁止。这里只留模型自己不知道的家里事实、You 定过的规矩和真踩过的坑。**怎么拍好看，先自己当观众把片子连续看一遍。**

## You 定过的（不知道就会做错）

- **宣传片的故事可以编。** 人物、场景、台词、梦想、结局都可以编，要的是陌生人的共鸣。只有当真用来证明的东西要和事实一致：产品能力、业绩、作品归属（别把别人的作品说成家里做的，别把编的数字当成绩）。能力成立、只是项目因为钱或优先级没做完的，可以拍成做完，拿不准交他判断。纪录、复盘、产品史、demo 片才守事实：原话不改字，重演标「重演」。（他 6 天里纠正过 4 次「我们又不是拍纪录片」。）
- **人在画面里当主角。** 界面放进他手里的设备里，人可以只出背影，方便观众代入；关键段落要看得见他想要什么、做了什么。
- **猫是同一个 thread 里对等的伙伴**，不编成「X 队」。
- **表世界和里世界**（屏幕里的产品界面、猫住的小楼）各有一扇固定的门，进出时要有东西把观众带过去。
- **好不好看由他判。** 别的猫只审事实、技术和音画同步。
- **先问给谁看**（家里看还是公开发）：克隆声线只能家里看；要公开先换声线，每个角色给他两三个候选念同一句，由他选。
- **配乐**：AI 生成和免费曲库他已经授权（10-12），不用再为来源请示；听起来对才算。别拿代码合成的配乐当正式 BGM，他嫌怪过两次。

## 真踩过的坑

| 坑 | 后果 | 怎么避 |
|---|---|---|
| 参考音和它配的文字不是同一句（《醋醋喵》EP0） | 开口先念出参考文字，后面全是胡言乱语，16 句全坏 | 用参考音前跑 `scripts/tts-check.py --check-ref 参考音.wav "文字"` |
| 同音词（寓言 / 预言、梳理 / 书里） | 听写对不上，观众也听不出 | 换个说法，别指望字幕 |
| 跨镜头的长句压到下一句（EP0） | 两层字幕叠在一起 | 渲染前跑 `scripts/timeline-check.py timeline.json` |
| 只看截帧拼图、统计数字就说「看过了」（《AI-native builder 的一天》10-12 冷读、10-14 粗剪） | 气泡直接蹦出来、角色不动、转场没东西带着，静帧上都看不出来 | 动作和声音只有连续看、带声听才知道；没连续看过就写「没看过」 |
| 先交静帧平移的全片粗片，动效和后期留到后面（同片 10-14，5:38） | 人和猫全是静图平移、8 处 18 帧溶解、配乐占位，交出去的片子像半成品 | 「先粗后精」只适合画面要靠 AI 生成或画师画、重画很贵的片子（anime-forge）。Remotion 里让角色动起来和让它平移费的工夫差不多：交出去的每一段都按成片做 |

## 工程

- **宣传片工程**：私有仓 `meow-club/cat-cafe-films`，一支片一个能独立渲染的 Remotion 工程（`npm install --include=dev`）。《AI-native builder 的一天》以这个仓为准，家里的改动走 PR。
- **老工作台**：You 机器上的 `~/projects/remotion-studio`（Remotion 4.0.438，官方 skill 在 `.agents/skills/remotion-best-practices`）。里面常有别人没提交的改动：只在自己的 `src/<Film>/` 里干活，不改 `Root.tsx`。
- **Remotion API** 读官方 `remotion-best-practices` 的 `rules/*.md`，别凭记忆写；装包用 `npx remotion add <包名>` 对齐版本。
- **本机配音和回听**：TTS `http://127.0.0.1:9879/v1/audio/speech`，Whisper `http://127.0.0.1:9876/v1/audio/transcriptions`；`scripts/tts-check.py lines.json voices.json out/` 逐句合成、逐句回听，对不上自动重录，最多三次。听写只当提醒，不当证据。
- **逐词对齐**：`scripts/video-forge/align.py`（仓库根目录，Qwen3-ForcedAligner），别用 TTS 自带的时间戳。时间轴只来自最终用进片子的那版音频。
- **实测过的版本坑**：
  - 中文 Google 字体的 `loadFont` 别传 `subsets`，会在渲染时报错。
  - `@remotion/media` 的 `<Video>` / `<Audio>` 用 `trimBefore` / `trimAfter`，`startFrom` 会类型报错。
  - 要放大的元素别加 `will-change: transform`，字会糊。
  - `--scale 0.6667` 算出的高度不是整数，拼接会报错退出：渲 1080 再用 ffmpeg 缩。
  - 本机 headless shell 解压失败时，加 `--browser-executable` 指向本机 Chrome。
  - 响度：`loudnorm` 单遍在动态范围大时到不了目标，用 `volume` + `alimiter` 调到 -16 LUFS。

## 交片

用 `cat_cafe_work` 保存作品，再发布它的固定版本卡，让 You 从 Works 或聊天直接进剪辑台批注。具体调用见 [视频作品交付](../.cat-cafe-shared-refs/video-work-delivery.md)。原文件留在实际制作仓，不要求搬到主仓、先写脚本或补 Remotion 合同；高清母版可直接登记，10MB 是另行发送聊天附件的限制，不是作品版本的上限。

改片前读同一份原意见，交新版用原 `contentRef` 和读取到的 `expectedOwnerRevision`，附「改了什么」。按原回报命令回应逐条意见及可核的新位置；猫说已调整后，仍等 You 在片上选「已改／还不对」。不要把续版当作意见自动通过，也不要让 You 回聊天手写时间点。

## 和别的 skill 的区别

- `anime-forge`：目的就是讲角色自己故事的动画（醋醋喵这类连载、家里真事改编）。推产品、讲功能的片子哪怕主角是猫、片里有剧情，也用本 skill；要画猫时，画稿开头照 anime-forge 的 `assets/art-brief-header.md` 写。
- 官方 `remotion-best-practices`：API 怎么写。
- `ppt-forge`：要的是幻灯片，不是视频。
