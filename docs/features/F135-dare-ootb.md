---
feature_ids: [F135]
related_features: [F050, F113]
topics: [dare, installation, onboarding, external-agent, cli-integration]
doc_kind: spec
created: 2026-03-23
---

# F135: 狸花猫开箱即用（DARE Out-of-the-Box）

> **Status**: spec | **Owner**: bouillipx (社区) | **Priority**: P2
>
> **来源**：社区 PR [clowder-ai#192](https://github.com/zts212653/clowder-ai/pull/192) / [clowder-ai#194](https://github.com/zts212653/clowder-ai/pull/194)
> **Issue**: [clowder-ai#195](https://github.com/zts212653/clowder-ai/issues/195)

## Why

当前安装 Clowder AI 后，狸花猫 (@dare) 需要 4 步手动配置才能使用：
1. 单独 clone DARE 仓库
2. 在 `.env` 配置 `DARE_PATH`
3. 手动在 DARE venv 中安装 Python 依赖（openai、httpx[socks] 等）
4. 手动修改 bootstrap binding 从 `skip` 改为 `enabled`

team experience："我想要安装猫猫就有狸花猫，安装完后，只需要配置 api_key 就能使用了"

## What

### Phase A: 服务层修复 + 路径解析

1. **`DEFAULT_DARE_PATH` 从项目根解析** — 使用 `import.meta.url` 从 API 包路径向上找到项目根再拼 `vendor/dare-cli/`，不绑定 `process.cwd`
2. **DareAgentService venv python 修复** — 优先使用 DARE repo 的 `.venv/bin/python`（macOS），接口预留 Windows
3. **smoke test 同步更新** 默认路径

### Phase B: 安装器集成 + 默认启用

1. **installer clone-if-missing** — `scripts/install.sh` 中 `git clone` DARE 到 `vendor/dare-cli/`；已存在时 skip（幂等）
2. **installer venv setup** — clone 后创建 `.venv` + 安装依赖
3. **默认启用 dare bootstrap** — 把 dare 从 `{enabled: false, mode: 'skip'}` 改为启用
4. **安装器接入 auth 流程** — 引导用户配置 API Key

## Dependencies

- **Parent**: F050（External Agent Onboarding — DARE 是首个 F050 L1 CLI 接入实践）
- **Related**: F113（One-Click Deploy — 安装体验优化方向一致）

## Acceptance Criteria

### Phase A（服务层修复 + 路径解析）
- [ ] AC-A1: `DEFAULT_DARE_PATH` 从项目根稳定解析到 `vendor/dare-cli/`
- [ ] AC-A2: DareAgentService 优先使用 `vendor/dare-cli/.venv/bin/python`
- [ ] AC-A3: `dare-smoke.test.js` 使用 vendor 路径并保留 legacy fallback
- [ ] AC-A4: headless 模式下 DARE 不再因 write/run 工具审批卡死

### Phase B（安装器集成 + 默认启用）
- [ ] AC-B1: `scripts/install.sh` 支持 clone DARE CLI、固定 ref、创建 venv 并安装依赖
- [ ] AC-B2: 新安装默认启用 dare bootstrap binding
- [ ] AC-B3: 安装器通过 `client-auth set --client dare` 引导 API Key 配置
- [ ] AC-B4: fresh install 后只需补 API Key 即可使用狸花猫

## Risk

| 风险 | 缓解 |
|------|------|
| DARE 上游漂移 | installer pin `DARE_CLI_REF` 到已验证 commit，升级通过 PR bump |
| Python/uv 环境差异（Linux/macOS/Windows） | 安装脚本做平台检测 + 优雅降级（warn 不中断） |
| clone 或 pip 失败 | warn-only，不阻塞主安装流程 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | Windows 上 `.venv/bin/python` 到 `.venv/Scripts/python.exe` 的适配何时补齐 | ⬜ 未定 |
| OQ-2 | 后续是否需要把 DARE CLI mirror 到 org 下统一维护 | ⬜ 未定 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 用 git clone + pinned ref 而非 submodule | 降低用户维护复杂度，同时保证安装可复现 | 2026-03-23 |
| KD-2 | 复用 client-auth/provider-profiles 链路 | 避免为 dare 单独造初始化通道 | 2026-03-23 |
| KD-3 | Python 依赖安装放在显式 installer，不放 npm postinstall | 隐式副作用太重，失败面大 | 2026-03-23 |
| KD-4 | headless 模式补全 write/run 工具白名单 | 否则 DARE 在无人值守集成里会卡 120 秒后失败 | 2026-03-24 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-23 | 立项。社区 issue #195 明确目标：安装完后只需配 API Key 即可使用狸花猫 |
| 2026-03-24 | PR 211 合入 playground，完成服务层、安装器和 headless auto-approve 收口 |

## Review Gate

- Phase A: 缅因猫 review（服务层改动 + 测试覆盖）
- Phase B: 缅因猫 review + 铲屎官验收（端到端安装体验）

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F050-a2a-external-agent-onboarding.md` | DARE 是首个外部 agent 接入实践 |
| **Feature** | `docs/features/F113-multi-platform-one-click-deploy.md` | 安装体验优化 |
| **Issue** | `clowder-ai#195` | 社区需求来源 |
