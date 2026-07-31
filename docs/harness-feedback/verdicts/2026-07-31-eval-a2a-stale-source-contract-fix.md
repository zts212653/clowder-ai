---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-07-31-eval-a2a-stale-source-contract-fix
source_snapshot: "snapshot:bundle/2026-07-31-eval-a2a-stale-source-contract-fix/snapshot"
---

# Live Verdict — 2026-07-31-eval-a2a-stale-source-contract-fix

- Verdict: `fix`
- Phenomenon: 截至 2026-07-31 03:10 UTC，daily eval:a2a 没有生成 7/31 source pair；最新 snapshot 已约 24.06 小时，虽有 20.38 小时的 counter window，L1 仍为 no-data。昨日 maintainer 在另一运行时核验到 OTel/Prometheus 正常，因此当前证据支持的是 source capture 与目标 runtime 身份/认证未闭合，而不是再次断言 TELEMETRY_HMAC_SALT 未配置。
- Harness: F167/f167-runtime-eval-source-adapter (A2A daily runtime evidence capture)
- Owner ask: 修复 eval:a2a source-capture 契约：在唤醒 eval 猫前完成当日 snapshot/attribution 生成并附带 sourceRefs；artifact 记录目标 runtime identity、baseUrl 与 auth mode；精确区分 401/503/盐缺失/盐无效；Phase O 明确区分零 stateful 调用与采集失败。补回归测试覆盖“无当日 source pair 仍唤醒”和跨 runtime 状态误归因。
- Re-eval: 下一次 daily eval 在唤醒时已附带生成时间不超过 1 小时的成对 sourceRefs，artifact 可定位唯一 runtime/auth 边界；L1 可读取两个计数字段或给出可验证的零值，grounding-phase-o 能报告 check/verdict/mismatch 分布或明确记录零 stateful 调用，不再返回不可归因 no-data。 at 2026-08-01T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-31-eval-a2a-stale-source-contract-fix/snapshot
- attribution:bundle/2026-07-31-eval-a2a-stale-source-contract-fix/AR-2026-07-30-001
- metric:source_age_hours
- metric:new_source_pairs
- metric:l1_counter_fields_present
- metric:counter_window_hours
- metric:grounding_phase_o_no_data
- L1/streak_warn_count

Counterarguments:
- 旧 source 在业务无活动时未必失真，但 daily verdict 的新鲜度与 runtime identity 必须可验证；当前两者都不满足。
- 昨日 maintainer 证明某个 runtime 的 telemetry 健康，这不否定本 finding，反而证明 eval source 与被核验 runtime 之间存在身份分歧。
- counter_window 超过 2 小时，只能说明计数分母稳定；当计数读取失败时不能据此推断 harness 健康或不健康。
