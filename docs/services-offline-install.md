# 服务离线/受限网络安装指南

Cat Café 的语音/嵌入/LLM 服务通过 Console 设置页一键安装，背后跑 `scripts/services/<service>-install.{sh,ps1}`。脚本要做两件涉及网络的事：

1. `pip install` 拉 Python 依赖
2. 下载模型文件（HuggingFace Hub `snapshot_download` 或直接 curl Piper voice）

在国内 / 内网 / 受限网络下任一步可能失败。本文给出可选的解决方案，按"轻 → 重"排序。

---

## 1. 国内镜像（最常用，5 秒配好）

在 `<repo-root>/.env` 增加：

```env
# HuggingFace 国内镜像（whisper / TTS / embedding / LLM 模型都走这个）
HF_ENDPOINT=https://hf-mirror.com

# pip 国内镜像（清华，覆盖 pip 主索引）
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

# 可选 fallback 到官方源（清华没同步的包会走这里）
PIP_EXTRA_INDEX_URL=https://pypi.org/simple
```

重启 Cat Café 后重新点击安装即可。这两个 env 通过 `scripts/download-source-overrides.sh` / `download-source-overrides.ps1` 注入到子进程，覆盖 pip 与 huggingface_hub 默认源。

> 其它常用 pip 镜像：阿里 `https://mirrors.aliyun.com/pypi/simple/`、腾讯 `https://mirrors.cloud.tencent.com/pypi/simple/`。

---

## 2. 内网（企业 PyPI / 内部 HF Mirror）

公司有内部 PyPI mirror（如 Artifactory / Nexus / Harbor / devpi）时：

```env
PIP_INDEX_URL=https://pypi.your-corp.com/simple
PIP_EXTRA_INDEX_URL=https://pypi.org/simple   # 若内部源没同步，回落官方
```

内部 HuggingFace 镜像（少见，但有些公司有）：

```env
HF_ENDPOINT=https://hf.your-corp.com
```

---

## 3. 完全离线 / 手动准备模型

如果连镜像都访问不了，可以手动把模型放到 Cat Café 期望的缓存路径里，**重试 install 会自动识别已存在的模型并跳过下载**（`huggingface_hub.snapshot_download` 内建缓存检查 + Cat Café piper 脚本也会查文件存在）。

### 3.1 HuggingFace 模型缓存路径

所有用 `snapshot_download` 拉的模型（whisper MLX / Kokoro TTS / Qwen3-Embedding / Qwen2.5 LLM / Jina / multilingual-e5 …）都缓存在：

```
~/.cache/huggingface/hub/models--<org>--<name>/
```

注意目录名里 `/` 会被替换成 `--`。例如：

| repo ID | 缓存目录 |
|---|---|
| `mlx-community/whisper-large-v3-turbo` | `~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/` |
| `Qwen/Qwen2.5-3B-Instruct` | `~/.cache/huggingface/hub/models--Qwen--Qwen2.5-3B-Instruct/` |
| `jinaai/jina-embeddings-v2-base-zh` | `~/.cache/huggingface/hub/models--jinaai--jina-embeddings-v2-base-zh/` |

最简单的手动准备方法：

```bash
# 在能上网的机器上拉好
pip install huggingface_hub
HF_HUB_ENABLE_HF_TRANSFER=1 \
  huggingface-cli download <repo-id> --local-dir /tmp/<repo-id>

# 也可以从 hf-mirror.com 下载 zip 然后解压
# 把整个 cache 目录拷到内网机器对应位置
tar czf hf-cache.tgz -C ~/.cache/huggingface hub
# 内网机器上：
mkdir -p ~/.cache/huggingface
tar xzf hf-cache.tgz -C ~/.cache/huggingface
```

放好后 Console 点击「重试安装」（或者「安装」），脚本会跑 `snapshot_download`，发现本地已存在就直接返回，不再尝试网络下载。

### 3.2 Piper voice 模型路径

Piper voice 不走 huggingface_hub，是 install 脚本直接 curl 的：

```
~/.cat-cafe/piper-models/<voice>.onnx
~/.cat-cafe/piper-models/<voice>.onnx.json
```

例：

```
~/.cat-cafe/piper-models/zh_CN-huayan-medium.onnx
~/.cat-cafe/piper-models/zh_CN-huayan-medium.onnx.json
```

手动下载：

```bash
mkdir -p ~/.cat-cafe/piper-models
# 直链（国内镜像）：
curl -L -o ~/.cat-cafe/piper-models/zh_CN-huayan-medium.onnx \
  https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx
curl -L -o ~/.cat-cafe/piper-models/zh_CN-huayan-medium.onnx.json \
  https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json
```

放好后重试 install，脚本检测到文件存在就跳过下载（见 `scripts/services/tts-install.sh` 的 `[ ! -f ... ]` 判断）。

### 3.3 venv 依赖离线安装

如果 pip install 也跑不通，可以在能上网的机器先把 wheel 包打包：

```bash
# 在能上网的机器
mkdir wheels && cd wheels
pip download fastembed onnxruntime fastapi uvicorn 'huggingface_hub[hf_xet]'
# 或者按 install 脚本里的包列表全装一遍

# 拷到内网机器后：
pip install --no-index --find-links=./wheels fastembed onnxruntime fastapi uvicorn 'huggingface_hub[hf_xet]'
```

注意：要在跟内网机器**相同平台 + 相同 Python 版本**的能上网机器上 download wheel，否则平台不匹配。最佳实践是用 Docker：`python:3.11-slim-bookworm` / `python:3.11-windowsservercore` 等容器内 download。

---

## 4. 平台兼容性

某些模型 / wheel 在特定平台没有预编译，这不是网络问题，是架构限制：

| 平台 | 限制 |
|---|---|
| **Windows ARM64 原生 Python** | `transformers`/`safetensors`/`tokenizers` 都没有 ARM64 wheel；需装 x86 Python 通过模拟运行（详见 Console LLM 服务的引导） |
| **Linux x86 (musl/Alpine)** | fastembed 有些 ONNX runtime 不兼容 musl glibc，需用 manylinux 镜像 |
| **Intel Mac** | 不支持 MLX；自动 fallback 到 fastembed/sentence-transformers + faster-whisper |

矩阵已经按这些约束自动选模型（见 `scripts/services/recommendation-matrix.yaml`）。

---

## 5. 故障排查

Cat Café Console 安装失败的 toast 现在会包含针对性 hint：识别到 `ConnectionError` 提示配镜像，识别到 `RepositoryNotFoundError` 提示走 HF Mirror，识别到 piper 下载失败提示手动放 voice 文件等。

如果 hint 没指出明显方向，看完整日志：

- Console → 服务卡片 → 点击模型旁查看日志按钮（或 `data/logs/api/<service-id>.log`）
- 安装阶段 stderr / stdout 都会写到该 log

常见 error pattern：

| 错误片段 | 含义 | 解决方法 |
|---|---|---|
| `ConnectionError` / `ProxyError` | 网络不通 | 配 PIP_INDEX_URL / HF_ENDPOINT |
| `Could not find a version` | wheel 找不到 | 走 PIP_EXTRA_INDEX_URL 回落官方源；或换 Python 版本 |
| `RepositoryNotFoundError` | HF 网络问题（不是真的 404） | 配 HF_ENDPOINT 镜像 |
| `Failed to download model: <voice>.onnx` | Piper voice 拉取失败 | 手动放到 ~/.cat-cafe/piper-models/ |
| `is not supported in TextEmbedding` | fastembed 白名单不收 | 换模型名（参考矩阵推荐 + 自定义模型 hint 的 fastembed catalog 链接） |

---

## 6. 永久禁用某项服务

如果一直装不上又用不到，可以在 Console 卸载该服务（删 venv）。卸载后 API server 启动时不会再 autostart 它。
