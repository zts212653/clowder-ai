# Live Audio — 实时音频采集与转写

> 来源：F195 Phase B
> 用途：底层能力 skill，教猫使用 audio_* MCP 工具进行音频采集和转写
> 场景 skill（如 meeting-copilot）引用此 ref 获取底层能力

## 能力概述

你可以通过同一个 durable `AudioSession` 实时采集 1..8 路音频并获取转写文本。App 与麦克风是输入类型，不是互斥的会话模式：

| 模式 | 工具参数 | 采集什么 |
|------|---------|---------|
| App 音频 | `source: "app"` + `app_name=<稳定 ID>` | `audio_list_sources` 返回的 ScreenCaptureKit 应用音频 |
| 麦克风 | `source: "mic"` | Mac 内置或外接麦克风（录制环境声音） |

既有 `source/app_name/device` 是单输入兼容 shorthand。需要 App + 本地评论、会议混音 + 麦克风时，用 primary source 加 `additional_inputs`；它们共享一个 transcript、session-local Speaker N registry 与回声去重边界。

## MCP 工具

| 工具 | 用途 |
|------|------|
| `cat_cafe_audio_list_sources` | 列出可采集的应用和麦克风设备 |
| `cat_cafe_audio_capture_start` | 开始采集（自动转写） |
| `cat_cafe_audio_capture_stop` | 停止采集 |
| `cat_cafe_audio_capture_status` | 查看当前采集状态 |
| `cat_cafe_audio_read_transcript` | 读取转写文本 |

## 标准流程

### 1. 确认音频源

operator说"监听XX"时，先确认采集模式：

- 提到具体 App 名（腾讯会议、Chrome、Zoom、华为云会议） → `source: "app"`，并先调用 `cat_cafe_audio_list_sources`
- 提到"麦克风""录环境""线下会议" → `source: "mic"`
- 不确定 → 用 `cat_cafe_audio_list_sources` 列出可用源，让operator选

App 列表会显示 `名称 [稳定 ID]`。按名称选择，但把方括号里的 ID 原样传给 start；禁止把 System Events 进程名、展示名或产品 alias 猜成 `app_name`。例如列表返回 `Huawei Cloud Meeting [com.huawei.cloudlink]`，调用值就是 `com.huawei.cloudlink`。

### 2. 开始采集

**必须传 `thread_id`**——不传则转写不会持久化到 MD 文件，猫也收不到 transcript path hint。

```
cat_cafe_audio_capture_start({
  source: "app",
  app_name: "com.huawei.cloudlink",
  label: "Huawei Cloud Meeting",
  thread_id: "<当前 thread ID>"
})
```

或麦克风模式：
```
cat_cafe_audio_capture_start({
  source: "mic",
  thread_id: "<当前 thread ID>"
})
```

App + 本地麦克风：

```
cat_cafe_audio_capture_start({
  source: "app",
  app_name: "com.huawei.cloudlink",
  label: "Huawei Cloud Meeting",
  thread_id: "<当前 thread ID>",
  additional_inputs: [
    { id: "local-comment", source: "mic", label: "Local microphone" }
  ]
})
```

有 provider participant/track 或明确独占输入证据时，可以在对应 input 上附 `speaker_evidence`。普通 App 名、麦克风名和 participant metadata 都不能直接推断人名。

### 3. 读取转写

operator问问题时，读取最近的转写：

```
cat_cafe_audio_read_transcript({ latest: 20 })
```

需要特定时间段：
```
cat_cafe_audio_read_transcript({ from: 1715300000, to: 1715300300 })
```

### 4. 停止采集

operator说"停""不听了""结束" → 停止采集：

```
cat_cafe_audio_capture_stop()
```

## 注意事项

- 采集需要 audio-service 进程运行（Python，端口 9881）
- App 音频采集需要 macOS 屏幕录制权限（首次使用会弹窗授权）
- ASR 服务需要运行（端口 9876，Qwen3-ASR）
- 转写有 ~3 秒延迟（每 3 秒一个 chunk）
- 中文识别质量好，中英混合基本正确
- API/UI controller 持有 sidecar lease；MCP invocation 退出不会停止采集。猫在后续 turn 继续用 status/read，只有用户 stop、API shutdown 或 lease expiry 才结束。
- `cat_cafe_audio_capture_status` 必须分别查看 ASR、speaker separation 和每个 input 的状态/原因；进程活着不代表 speaker 模型可推理。
- App 输入永远先 list 再 start：展示名只给人看，`apps[].id` 才是采集坐标；不得为 WeLink/Zoom/Chrome 增加 alias/fallback。
- 每条 transcript 的 input source 与 speaker identity 是正交字段。身份优先级只有：人工确认 → provider track/独占源 → enrolled voice → session-local Speaker N → Unknown。
- Speaker N 需要两次相干声纹证据才出生；status 中 `confirmed / learning / recovered` 是聚类健康，不应把学习中的短片段误报为永久新说话人。
- App + mic 捕获到同一扬声器内容时，共用聚合层会抑制近时重复并在 input status 记录 `deduplicated_chunks`；不要再写会议/视频场景特判。
- 可重跑真实 CAM++ fixture：`~/.cat-cafe/audio-capture-venv/bin/python scripts/meeting-copilot/verify_true_companion_fixture.py`。它下载 checksum-pinned 公共语音，真实产生 Speaker 1/2/3，并检查回声去重、provider/exclusive evidence 和缺模型 fail-closed。
