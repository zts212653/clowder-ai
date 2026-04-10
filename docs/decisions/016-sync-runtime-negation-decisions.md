---
feature_ids: [F059, F115]
topics: [sync, runtime, startup, architecture]
doc_kind: decision
created: 2026-03-13
participants: [opus, gpt52]
status: accepted
---

# ADR-016: 同步 & Runtime 否决决策

> 来源：2026-03-13 F059 同步 Runtime 事故复盘 + 两猫收敛讨论

## 背景

3/13 下午在 clowder-ai 同步验收中发生一连串 runtime 事故（proxy 被杀、sidecar 假阳性、529 透传、依赖缺失）。复盘后两猫独立分析并收敛了 4 个优化方向，同时明确否决了 4 条替代方案。

## 否决决策

### N1: 不做双向自动 sync

**否决理由**：当前 22 个出站 transform 中多个是有损的（README/CONTRIBUTING/ROADMAP 等完全生成替换），公共产物无法无歧义还原回源仓真相源。镜像式回流会重现覆盖事故。

**替代方案**：单向出站 + intake assistant（`intake-from-opensource.sh`），入站按 PR 逐个审阅，三类分拣（safe-cherry-pick / manual-port / public-only）。

### N2: 不做通用 reverse transform

**否决理由**：出站 transform 包含有损操作（猫名替换、端口 remap、文档生成、内部路径擦除），通用反 transform 需要维护 22 个逆映射且无法保证无损。

**替代方案**：默认不反 transform，仅对极小 allowlist 做显式逆映射，其余进入 manual-port 人工审阅。

### N3: 不分叉 `start-dev.sh` 成两份真相源

**否决理由**：方案 B（clowder-ai 有自己的 start-dev.sh）会创造两份启动链真相源，未来必然漂移，且 sync transform 需要额外维护这个分叉点。

**采纳方案**：Profile 化 `start-dev.sh --profile=dev|opensource`，一份脚本、不同 profile 决定默认值和 sidecar/proxy 策略。`.env` 只做显式 override，不负责定义环境身份。

### N4: 不在 `start-dev.sh` 默认自动安装可选依赖

**否决理由**：启动脚本必须可预测，不能一边拉服务一边偷偷改环境（pip install）。静默自动安装会引入不可控的网络依赖和环境变化。

**采纳方案**：交互式 setup 脚本负责安装可选依赖；`start-dev.sh` 只检查、报错、给下一步命令。可选显式 `--install-missing` 触发，但默认不安装。

## 配套操作规则

1. **启动摘要必须标注值来源**：每个配置值标注 `profile default` 还是 `.env override`，让行为漂移可被一眼看出
2. **sidecar 状态分层**：`disabled / launching / ready / failed`，禁止用"尝试启动过"冒充"已启动"
3. **共享脚本改默认值**：同 commit 必须补家里 `.env` 显式值 + 真实启动验收

## 关联

- 复盘文档：*(internal reference removed)*
- Intake 脚本：`scripts/intake-from-opensource.sh`
- Intake ledger：`docs/ops/opensource-intake-ledger.json`
- LL-030: 共享脚本改默认值教训
