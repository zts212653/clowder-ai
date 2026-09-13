# cancel gate probe — 2026-09-13 L1

命令要点: `qodercn -p "Count slowly from 1 to 200..." -o stream-json --config-dir <clone> --strict-mcp-config --allowed-mcp-server-names nothing --tools "" --setting-sources user`，sandbox-exec allowlist 内运行，8s 后 SIGINT。
- exit: 130（SIGINT）
- **修正（2026-09-13 复核落盘文件）**：SIGINT 后 qodercn 仍发出终态 `result`（优雅取消）——
  首次检查时读到的"无 result"是 kill -9 前的时序竞态（半截流）。cancel 签名 = exit 130 +
  终态 result 正常收尾；与 CLI failure 的分测点在 exit code 与 stderr，而非流末形状
- 与首采失败原因对照：首采任务太短（count to 50 在 6s 内完成），本次 count to 200 + 8s 中断
- 与首采失败原因对照：首采任务太短（count to 50 在 6s 内完成），本次 count to 200 + 8s 中断
