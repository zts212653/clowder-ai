---
feature_ids: [F115]
related_features: [F059]
topics: [runtime, startup, devex, infrastructure]
doc_kind: spec
created: 2026-03-14
---

# F115: Runtime 启动链优化

> **Status**: done | **Owner**: Maine Coon/gpt52 | **Priority**: P1 | **Completed**: 2026-03-16

## Why

2026-03-13 clowder-ai 同步验收中发生一连串 runtime 事故（proxy 被杀、sidecar 假阳性、529 透传、依赖缺失），暴露了 `start-dev.sh` 在跨仓共享时的脆弱性。两猫（opus + gpt52）独立复盘后收敛了 4 个优化方向（见 ADR-016）。本 feature 将这些优化落地为可交付的代码改动。

## What

### Phase A: start-dev.sh Profile 化

将 `start-dev.sh` 改为 `--profile=dev|opensource` 模式：
- 不同 profile 决定默认值（proxy、sidecar、端口等）
- `.env` 只做显式 override，不负责定义环境身份
- 启动摘要标注每个值来源（`profile default` vs `.env override`）

### Phase B: Sidecar 状态分层

- 状态机：`disabled → launching → ready → failed`
- `wait_for_port` + 合理超时（ASR/TTS 30s, LLM 60s）
- 启动失败明确报告，不静默跳过
- summary 只列实际 `ready` 的服务

### Phase C: Proxy 弹性

- upstream 529/503 实现 retry with exponential backoff（最多 3 次）
- thinking/signature 相关事件特殊保护，避免 JSON round-trip 破坏签名
- 非流式非事件路径可做最薄错误包装

### Phase D: 交互式 Setup 脚本

- 提供交互式 setup 脚本让用户选择可选依赖（mlx-lm、TTS/ASR 等）
- `start-dev.sh` 只检查、报错、给下一步命令
- 可选显式 `--install-missing` 触发安装，默认不安装

### Phase E: Proxy Upstream Hardening（community manual-port）

- 保留 Phase C 的 connect-only timeout，不能回退到“整个 fetch 生命周期都限时”的实现
- 为网络级瞬时错误补有限 retry 和结构化 `causeCode` / `retryable` 诊断
- 在 request body 经 thinking-strip 改写后，移除错误的 `content-length` / `transfer-encoding`

## Acceptance Criteria

### Phase A（Profile 化） ✅
- [x] AC-A1: `start-dev.sh --profile=opensource` 使用开源仓默认值（proxy OFF 等）
- [x] AC-A2: `start-dev.sh --profile=dev` 使用家里默认值（proxy ON 等）
- [x] AC-A3: 启动摘要标注每个配置值来源
- [x] AC-A4: `.env` override 正确覆盖 profile 默认值

### Phase B（Sidecar 状态分层） ✅
- [x] AC-B1: sidecar 状态机 `disabled/launching/ready/failed` 正确流转
- [x] AC-B2: ASR/TTS 超时 30s、LLM 超时 60s（可配置）
- [x] AC-B3: summary 只报 `ready` 状态的服务

### Phase C（Proxy 弹性） ✅
- [x] AC-C1: upstream 529/503 自动 retry（最多 3 次，exponential backoff）
- [x] AC-C2: thinking/signature 事件不做 JSON round-trip
- [x] AC-C3: proxy 进程不可达时 fallback 直连 upstream（TCP 探活 + 结构化告警）
- [x] AC-C4: upstream fetch 增加超时（60s），避免无限等待返回 502（clowder-ai#52）

### Phase D（交互式 Setup） ✅
- [x] AC-D1: setup 脚本检测缺失依赖并提示安装命令
- [x] AC-D2: `--install-missing` 可自动安装到 venv
- [x] AC-D3: `start-dev.sh` 检测到 ENABLED=1 但依赖缺失时报错而非静默跳过

### Phase E（Proxy Upstream Hardening） ✅
- [x] AC-E1: request body 经 `stripThinkingFromRequest()` 改写后，转发不再因 `content-length` / `transfer-encoding` 错配而失败
- [x] AC-E2: 网络级瞬时 upstream 错误在 proxy 内有限重试，且不影响现有 429/529 retry
- [x] AC-E3: proxy 错误响应包含 `causeCode` / `retryable`，同时保留 slow-SSE 不截断保护

## Dependencies

- **Evolved from**: F059（同步验收中发现的 runtime 问题）
- **Related**: ADR-016（否决决策：不分叉脚本/不静默安装等）
- **Community input**: clowder-ai#46（proxy 不可达无 fallback）、clowder-ai#52（upstream fetch 无超时/诊断不足）、clowder-ai#107（manual-port 线索）

## Risk

| 风险 | 缓解 |
|------|------|
| Profile 化改动影响家里现有 runtime | 改动同 commit 补家里 `.env` 显式值 + 真实启动验收（LL-030） |
| Proxy retry 可能与 thinking block 签名冲突 | Phase C 明确保护 thinking/signature 事件不做 round-trip |
| Phase E network retry 回退 slow-SSE 保护 | 明确禁止把 `AbortSignal.timeout(...)` 包回整个 `fetch()`；保留 connect-only timeout 测试 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Profile 化而非分叉脚本 | 两份真相源会漂移（ADR-016 N3） | 2026-03-13 |
| KD-2 | 交互式 setup 而非启动时静默安装 | 启动脚本必须可预测（ADR-016 N4） | 2026-03-13 |
