# Live Audio — 实时音频采集与转写

> 来源：F195 Phase B
> 用途：底层能力 skill，教猫使用 audio_* MCP 工具进行音频采集和转写
> 场景 skill（如 meeting-copilot）引用此 ref 获取底层能力

## 能力概述

你可以通过 MCP 工具实时采集音频并获取转写文本。支持两种采集模式：

| 模式 | 工具参数 | 采集什么 |
|------|---------|---------|
| App 音频 | `source: "app"` + `app_name` | 指定应用的音频输出（如腾讯会议、Chrome、Zoom） |
| 麦克风 | `source: "mic"` | Mac 内置或外接麦克风（录制环境声音） |

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

铲屎官说"监听XX"时，先确认采集模式：

- 提到具体 App 名（腾讯会议、Chrome、Zoom、华为云会议） → `source: "app"`
- 提到"麦克风""录环境""线下会议" → `source: "mic"`
- 不确定 → 用 `cat_cafe_audio_list_sources` 列出可用源，让铲屎官选

### 2. 开始采集

**必须传 `thread_id`**——不传则转写不会持久化到 MD 文件，猫也收不到 transcript path hint。

```
cat_cafe_audio_capture_start({
  source: "app",
  app_name: "腾讯会议",
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

### 3. 读取转写

铲屎官问问题时，读取最近的转写：

```
cat_cafe_audio_read_transcript({ latest: 20 })
```

需要特定时间段：
```
cat_cafe_audio_read_transcript({ from: 1715300000, to: 1715300300 })
```

### 4. 停止采集

铲屎官说"停""不听了""结束" → 停止采集：

```
cat_cafe_audio_capture_stop()
```

## 注意事项

- 采集需要 audio-service 进程运行（Python，端口 9881）
- App 音频采集需要 macOS 屏幕录制权限（首次使用会弹窗授权）
- ASR 服务需要运行（端口 9876，Qwen3-ASR）
- 转写有 ~3 秒延迟（每 3 秒一个 chunk）
- 中文识别质量好，中英混合基本正确
- 不做 speaker diarization（双路物理隔离够用）
