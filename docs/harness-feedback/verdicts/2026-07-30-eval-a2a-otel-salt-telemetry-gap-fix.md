---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix
source_snapshot: "snapshot:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/snapshot"
---

# Live Verdict — 2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix

- Verdict: `fix`
- Phenomenon: F167 的 counter window 已覆盖 20.38 小时，但运行时明确因 TELEMETRY_HMAC_SALT 未配置而关闭 OTel，metrics、metrics history、traces、grounding samples 四个证据面均不可用；L1、C1、C2、route-serial、grounding-phase-o 五个组件全部为 no-data。Phase O 没有可解释的 mismatch 分布，不能把零样本当作健康。
- Harness: F167/f167-runtime-eval-telemetry (A2A runtime eval telemetry and Phase O grounding evidence)
- Owner ask: 修复 F167 telemetry 的部署/启动契约：由需要的人类配置面注入有效 TELEMETRY_HMAC_SALT，并让启动或 readiness 对缺失盐显式失败；恢复 metrics、metrics history、traces、grounding samples 四端点；同时让 daily f167-runtime-eval source adapter 在唤醒 eval 猫前自动生成 snapshots/attributions raw YAML，避免再次依赖人工重建。
- Re-eval: 下一轮自动生成新的 F167 raw snapshot/attribution；四个 telemetry 端点均返回 200；counter_window.duration_hours >= 2；L1/C1/C2/route-serial/grounding-phase-o 均不再是 no-data；grounding.check_total 与 grounding.verdict_total 可读，若 mismatch_sample_count > 0 则附 recurring-pattern 复核。 at 2026-08-02T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/snapshot
- attribution:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/AR-2026-07-30-001
- metric:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/counterWindow.durationHours
- metric:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/components.noDataCount
- metric:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/attribution.openFindingCount
- metadata:bundle/2026-07-30-eval-a2a-otel-salt-telemetry-gap-fix/provenance#sourceThreadId=thread_eval_a2a

Counterarguments:
- 进程 counter window 已超过 2 小时，说明分母口径修复本身有效；当前问题是计数器和存储根本未初始化，而不是短窗口噪声。
- 新增第 7 个 observability gap 来自 Phase O 组件显式纳入，不能单凭 6→7 判定业务回归，因此趋势定为 flat。
- readiness 的 Redis/SQLite 为 ready 不代表 eval harness 健康；eval:a2a 的证据契约明确依赖 telemetry 四个端点。
