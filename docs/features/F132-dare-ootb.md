---
feature_ids: [F132]
related_features: [F050, F113]
topics: [dare, installation, onboarding, external-agent]
doc_kind: spec
created: 2026-03-23
---

# F132: 狸花猫开箱即用（DARE Out-of-the-Box）

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

当前安装 Clowder AI 后，狸花猫 (@dare) 需要 4 步手动配置才能使用：
1. 单独 clone DARE 仓库
2. 在 `.env` 配置 `DARE_PATH`
3. 手动在 DARE venv 中安装 Python 依赖（openai、httpx[socks] 等）
4. 手动修改 bootstrap binding 从 `skip` 改为 `enabled`

铲屎官原话："我想要安装猫猫就有狸花猫，安装完后，只需要配置 api_key 就能使用了"

## What

### Phase A: 仓库内嵌 + 服务层修复

1. **DARE 仓库作为 git submodule** 引入 `vendor/dare-cli/`
2. **DareAgentService venv python 修复** — 优先使用 DARE repo 的 `.venv/bin/python`（已验证可行）
3. **更新 `DEFAULT_DARE_PATH`** 指向 `vendor/dare-cli/`（相对于项目根目录解析）
4. **smoke test 同步更新** 默认路径

### Phase B: 安装器集成 + 默认启用

1. **installer 显式 setup** — `scripts/install.sh` 中加 DARE venv 创建 + `uv pip install -r requirements.txt` 步骤
2. **默认启用 dare bootstrap** — `provider-profiles.ts` 的 bootstrapBindings 把 dare 从 `skip` 改为 `enabled`（mode: `client-auth`）
3. **安装器接入 client-auth 流程** — 安装时调用 `client-auth set --client dare`，引导用户配置 API Key
4. **文档更新** — 安装指南中说明 DARE/狸花猫的配置方式

## Acceptance Criteria

### Phase A（仓库内嵌 + 服务层修复）
- [ ] AC-A1: DARE 仓库以 git submodule 形式存在于 `vendor/dare-cli/`
- [ ] AC-A2: DareAgentService 优先使用 `vendor/dare-cli/.venv/bin/python`
- [ ] AC-A3: `DEFAULT_DARE_PATH` 指向项目内 vendor 路径
- [ ] AC-A4: dare-smoke.test.js 使用新的默认路径，测试通过

### Phase B（安装器集成 + 默认启用）
- [ ] AC-B1: `scripts/install.sh` 包含 DARE venv 创建和依赖安装步骤
- [ ] AC-B2: 新安装默认启用 dare bootstrap binding
- [ ] AC-B3: 安装器通过 client-auth 流程引导 dare API Key 配置
- [ ] AC-B4: 全新安装后仅配 API Key 即可使用狸花猫（端到端验证）

## Dependencies

- **Related**: F050（External Agent Onboarding — DARE 是首个 F050 契约的实践）
- **Related**: F113（One-Click Deploy — 安装体验优化方向一致）

## Risk

| 风险 | 缓解 |
|------|------|
| git submodule 增加 clone/update 复杂度 | installer 脚本自动 `git submodule update --init` |
| Python/uv 环境差异（Linux/macOS/Windows） | Phase B 安装脚本做平台检测 + 清晰错误提示 |
| DARE 上游更新 submodule 同步 | 定期 bump submodule commit，CI 验证 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | DARE repo 是否需要 fork 到 org 下还是直接引用上游 | ⬜ 未定 |
| OQ-2 | Windows 上 .venv/bin/python → .venv/Scripts/python.exe 的适配 | ⬜ 未定 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 用 git submodule 而非 npm 包或直接复制 | DARE 是独立 Python 项目，submodule 保持上游可追踪 | 2026-03-23 |
| KD-2 | 复用 client-auth/provider-profiles 链路，不造第二套 | 砚砚 review：现有能力已有，避免重复初始化逻辑 | 2026-03-23 |
| KD-3 | Python 依赖安装放在显式 installer，不放 npm postinstall | 砚砚 review：隐式副作用太重，失败面大 | 2026-03-23 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-23 | 立项。铲屎官提出需求，砚砚 review 收敛方案 |

## Review Gate

- Phase A: 缅因猫 review（服务层改动 + 测试覆盖）
- Phase B: 缅因猫 review + 铲屎官验收（端到端安装体验）

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F050-a2a-external-agent-onboarding.md` | DARE 是首个外部 agent 接入实践 |
| **Feature** | `docs/features/F113-one-click-deploy.md` | 安装体验优化 |
| **Thread** | `thread_mn2q199272wucy08` | 立项讨论：狸花猫呼叫 + 方案探索 + 砚砚 review |
