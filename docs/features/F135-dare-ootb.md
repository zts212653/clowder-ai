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
