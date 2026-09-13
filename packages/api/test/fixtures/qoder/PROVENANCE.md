# Provenance ledger（事后台账，非原始 receipt）— 2026-09-13 首采会话，谱谱本机

> 定位声明：本文件是**事后追记的 provenance ledger**，只陈述仓内工件可证事实与采集者记录；无法从仓内工件回证的字段一律标 `unknown`。完整复现与**新的结构化 receipt**（分轨 stdout/stderr/exit + 副作用断言）以重跑 `collect.sh` 为准，其输出为 `generation.json`（schema `qoder-f317-generation/2`，含 artifacts/side-effects 全量 sha256）+ 每 fixture 的 `.jsonl/.stderr.txt/.exit/.assert`，读方用 `verify.py` fail-closed 校验。

环境（采集者记录，仓内可由 init 事件部分回证）：`~/.local/bin/qodercn`（`@qodercn-ai/qoderclicn@1.1.51`，init 带 `qodercli_version`），protocol_version 1.4.0（init 可证），macOS arm64；`QODER_CONFIG_DIR=~/.qoder-cn`（已登录）。

| fixture | exit（采集者记录） | 仓内可证 | 不可回证（unknown） |
|---|---|---|---|
| first-capture/success.jsonl | 0 | 11 行、init/result 字段、hook 先于 init | stderr 原件（未分轨保存） |
| first-capture/tool-use.jsonl | 0（点点点采） | tool_use/tool_result 形状 | 点点的完整命令参数与 prompt 原文（见其 review 记录）；stderr |
| first-capture/permission-denial.jsonl | 0 | `user.tool_result{is_error:true,"Error: Allow ..."}`；终态 `is_error:false, permission_denials:[]`；`result.result` 自由文本含 "was denied"（不得作分类依据） | `/tmp/pwned.txt` 不存在的副作用检查当时未脚本化（采集者目视记录）；stderr |
| first-capture/auth-error.jsonl | 1 | 末行 `result.is_error:true` 且 `subtype:"success"` | stderr（当时为空） |
| first-capture/silent-model-fallback.jsonl | 0（点点点采） | `init.model=Auto`、`result.is_error:false` | 点点报告的 stderr 回落警告（属其会话，本仓无工件）；完整命令 |
| first-capture/resume.jsonl | 0 | 同 session_id、回忆上文内容 | stderr |
| first-capture/hook-red.jsonl | 0 | 流中 `hook_started` 的 hook_name 为 `touch /tmp/s5-marker`（**首采真实值**，与 collect.sh 的 `marker` 占位不同） | marker 落盘的副作用检查当时未脚本化（采集者目视记录）；stderr |
| first-capture/hook-green-project.jsonl | 0 | 流中无恶意 hook；builtin plugin hook 仍在 | 同上 |
| first-capture/hook-green-local.jsonl | 0 | 同上 | 同上 |

cancel：无工件、无 receipt（首采失败：SIGINT 未能中断该 invocation，transcript 以成功 result 收尾，已废弃）。重采要求：signal / exit / 流末事件三样齐全，与 silent_completion、CLI failure 分测。
