# Meeting Copilot — 会议实时智囊

> 来源：F195 Phase B + Phase D
> 前置：refs/live-audio.md（底层音频采集能力）
> 用途：会议场景专用 skill ref，教猫在会议中充当operator的实时智囊

## 场景定义

operator正在开会（线上或线下），需要猫实时参与：

- 听会议内容，随时回答"他们在聊什么"
- 帮operator理解对方说了什么
- 在operator需要发言前快速整理要点

## 会议类型判断

| operator说的 | 采集模式 | app_name |
|-----------|---------|----------|
| "监听腾讯会议" | app | 腾讯会议 |
| "监听华为云会议" | app | 华为云会议 |
| "监听 Zoom" | app | zoom.us |
| "监听 Chrome"（网页会议） | app | Google Chrome |
| "线下会议""用麦克风听" | mic | — |

## 完整流程

### 启动

1. operator说"开始监听 XX"
2. 用 `cat_cafe_audio_capture_start` 开始采集，**必须传 `thread_id`**（当前对话的 thread ID）：
   ```
   cat_cafe_audio_capture_start({
     source: "app",
     app_name: "腾讯会议",
     thread_id: "<当前 thread ID>"
   })
   ```
3. 告诉operator已开始，转写窗会自动打开

### 会议进行中

operator可能会问：

| operator说 | 猫的动作 |
|---------|---------|
| "他们在聊什么" | 读最近 10-20 条转写，做 2-3 句摘要 |
| "刚才那个数字是多少" | 读最近转写，找到具体数据 |
| "帮我整理一下要点" | 读全部转写，按主题整理 |
| "我要发言了，帮我想想" | 读最近转写，给 2-3 个发言建议 |

**读转写的策略**：
- 日常问答：`latest: 10`（最近 10 条，约 30 秒内容）
- 要全貌：`latest: 50` 或不加限制
- 要回看：用 `from`/`to` 时间戳精确定位

### 回答风格

- **简洁**：会议中operator没时间看长文，2-3 句话为主
- **结构化**：用短列表，不写段落
- **可操作**：如果operator要发言，给具体建议而不是泛泛分析
- **标注不确定**：ASR 不完美，如果关键信息模糊就说"转写不太清楚，可能是 XX"

### 结束

operator说"停""不听了""会议结束了"：

1. 用 `cat_cafe_audio_capture_stop` 停止采集
2. 如果会议时间 > 5 分钟，主动给一个简短的会议摘要
3. 问operator是否需要整理会议纪要

## 主动建议模式（Active Advisory）

> 来源：F195 Phase C3

**前提**：advisory_mode 必须由用户显式开启（默认 passive）。

当 active 且检测到 intervention window 时：
- 浮动窗显示轻提示（不发 chat 消息）
- 带论点的建议只来自用户注册的 talking points
- 每 5 分钟最多 1 条（运行时限频，不靠猫自觉）
- 用户说"别打扰" → 15 分钟静默

**触发方式**：
- `cat_cafe_audio_set_advisory_mode` — 开启/关闭 active 模式
- `cat_cafe_audio_set_talking_points` — 注册用户的发言要点

**禁止**：
- 不允许从转写文本生成立场性建议
- 不允许主动发 chat 消息（Phase C3b 再开）
- 不允许猫代替用户注册 talking points（必须来自用户输入）

## 转写持久化（Phase D）

会议转写自动持久化到 MD 文件（`scripts/meeting-copilot/transcripts/{thread_id}/transcript-{meeting_id}.md`，同 meeting_id 去重加序号）。
原始录音同步保存为 MP3（ffmpeg 转换；不可用时保留原始 PCM）。

**你不需要做任何事情——持久化全自动**：
- 启动会议时自动创建 MD 文件（按 speaking turn 分段，不是每个 chunk 一行）
- 每 30 秒自动插入 Rolling Summary 段落
- PCM 音频流自动写盘，finalize 时转 MP3
- 停止会议时自动 finalize + 标记 meta.json 为 inactive

**你的上下文中会自动注入文件路径**（不是文件内容）：
- `[Meeting transcript: /path/to/transcript-{meeting_id}.md]` — 会议转写 MD 文件路径
- `[Latest range: 00:05:30–00:06:00]` — 最新的时间段
- `[Participants: Host, Alice]` — 参会人列表

**录音路径获取**（不自动注入上下文）：
- UI 停止录音后在转写窗/浮动窗显示 `Recording: /path/to/recording-{meeting_id}.mp3`
- `cat_cafe_audio_capture_stop` 返回的 `summary.recording_path` 字段

**读转写的方式**：
- 快速问答仍用 `cat_cafe_audio_read_transcript`（实时 API，延迟低）
- 需要全文/深度分析时直接 `Read` 注入的 MD 文件路径（文件包含完整转写 + 摘要）
- 会议结束后只能用 MD 文件（内存转写已清空）
- 需要重新转写时用录音文件（更换 ASR 模型后可重跑）

## 不要做的事

- 不要主动推送信息（passive 模式下，operator问你才答）
- 不要把转写内容直接发到聊天里（转写窗已经在显示了）
- 不要对转写内容做价值判断（"这个观点不对"之类的）
- 不要在operator没问的时候插嘴（active 模式下只通过浮动窗轻提示）
