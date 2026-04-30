# F179 Console Architecture Restructure — Acceptance Table

> Feature: [F170-console-architecture-restructure.md](../../docs/features/F170-console-architecture-restructure.md)
> Branch: `feat/f170-phase-2a`
> Pencil: `docs/design/pencil-new.pen`

---

## Dev Environment Contract

| 项 | 值 |
|---|---|
| Worktree | `/Users/lang/workspace/github-lab/cat-cafe-f170-console/` |
| Port | Frontend `$FRONTEND_PORT` (3200) + API `$API_SERVER_PORT` (3202) |
| Start command | `pnpm dev:direct`（读 .env 端口） |
| HMR | 改完 `.tsx` 浏览器自动刷新，不需 rebuild |

### 禁止操作

- `npx next dev` 或任何绕过 `pnpm dev:direct` / `start-dev.sh` 的裸启动
- 局部启动 (`pnpm --filter api dev` / `pnpm --filter web dev`)
- dev server 运行时执行 `pnpm build`（会污染 `.next` 缓存导致 CSS 报错）

### 如需重启

只在同一 worktree 重新执行 `pnpm dev:direct`。如端口被占用，升级给铲屎官处理。

---

## Role Boundaries

| 角色 | 职责 | 禁止 |
|------|------|------|
| **Opus (执行)** | 改代码 → 自检(test/lint) → commit → 提交 evidence → `READY_FOR_REVIEW` | 标 PASS；自评 screen parity |
| **Codex (审核)** | 逐交付物审核 → `PASS` / `REJECT` + 理由 | 放行未覆盖的交付物；PASS 被当作全局放行 |
| **铲屎官 (产品)** | 设计取舍、愿景级决策、不可逆操作 | 被迫做流程推进 |

### 交付协议

每轮只交 **1-2 个交付物**。交付包含：
1. Commit SHA
2. 交付物名称
3. 运行时证据（截图/命令输出）
4. 自检报告摘要（`pnpm check` + `pnpm lint` + test）

Author 发 `READY_FOR_REVIEW`；Reviewer 只审声明范围内的交付物。

---

## Acceptance Table

### 一级页面

| # | Deliverable | Source (Spec/Pencil Node) | Route/Trigger | Status | Evidence | Reviewer Verdict |
|---|-------------|--------------------------|---------------|--------|----------|------------------|
| 1 | Chat View | AC-1a / `f170r3012_Screen1ChatViewsta` | `/` | TODO | — | — |
| 2 | Mission Hub | AC-1a / `V8AQx` | `/mission` | TODO | — | — |
| 3 | Signals - Inbox | AC-1a / `f170r3077_Screen2SignalsInbo` | `/signals` | TODO | — | — |
| 4 | Signals - Sources | AC-1a / `f170r3142_Screen3SignalsSour` | `/signals/sources` | TODO | — | — |
| 5 | Memory - Feed | AC-1a / `f170r3207_Screen4MemoryFeed` | `/memory` | TODO | — | — |
| 6 | Memory - Search | AC-1a / `f170r3272_Screen5MemorySearc` | `/memory/search` | TODO | — | — |
| 7 | Memory - Status | AC-1a / `f170r3337_Screen6MemoryStatu` | `/memory/status` | TODO | — | — |

### Settings 列表页

| # | Deliverable | Source (Spec/Pencil Node) | Route/Trigger | Status | Evidence | Reviewer Verdict |
|---|-------------|--------------------------|---------------|--------|----------|------------------|
| 8 | 成员管理 | AC-1b,1e / `f170r3402_Screen7Settings` | `/settings?s=members` | TODO | — | — |
| 9 | 账户与密钥 | AC-1b,1e / `f170r3467_Screen8Settings` | `/settings?s=accounts` | TODO | — | — |
| 10 | IM 对接 | AC-1b,1e / `f170r3532_Screen9SettingsIM` | `/settings?s=im` | TODO | — | — |
| 11 | Skill 管理 | AC-1b,1g / `f170r3597_Screen10SettingsSk` | `/settings?s=skills` | TODO | — | — |
| 12 | MCP 管理 | AC-1b,1g / `f170r3662_Screen11SettingsMC` | `/settings?s=mcp` | TODO | — | — |
| 13 | 插件/集成 | AC-1b,1h / `f170r3727_Screen12Settings` | `/settings?s=plugins` | TODO | — | — |
| 14 | 语音管理 | AC-1b / `f170r3792_Screen13Settings` | `/settings?s=voice` | TODO | — | — |
| 15 | 系统配置 | AC-1b,1i / `f170r3857_Screen14Settings` | `/settings?s=system` | TODO | — | — |
| 16 | 通知 | AC-1b / `f170r3922_Screen15Settings` | `/settings?s=notify` | TODO | — | — |
| 17 | 运维监控 | AC-1b / `f170r3987_Screen16Settings` | `/settings?s=ops` | TODO | — | — |
| 18 | 规则与 SOP | AC-1b / `WPK3t` | `/settings?s=rules` | TODO | — | — |

### Settings 弹窗/详情

| # | Deliverable | Source (Spec/Pencil Node) | Route/Trigger | Status | Evidence | Reviewer Verdict |
|---|-------------|--------------------------|---------------|--------|----------|------------------|
| 8B | 成员详情 (inline drill-down) | AC-1e / `WwlbI` | 点击成员卡片 | TODO | — | — |
| 8C | 添加成员 (inline drill-down) | AC-1e / `XX9zR` | + 添加成员按钮 | TODO | — | — |
| 9B | OAuth 认证详情 | AC-1e / `NFEsf` | 点击 OAuth 账户 | TODO | — | — |
| 9C | API Key 认证详情 | AC-1e / `9G3GZ` | 点击 API Key 账户 | TODO | — | — |
| 10B | IM 编辑弹窗 | AC-1e / `eLcr5` | 点击 IM 连接器 | TODO | — | — |
| 11B | Skill 预览弹窗 | AC-1e / `WZxYp` | 点击 Skill 卡片 | TODO | — | — |
| 12B | MCP HTTPStream 弹窗 | AC-1g / `WffHO` | 新增/编辑 HTTP MCP | TODO | — | — |
| 12C | MCP STDIO 弹窗 | AC-1g / `4puiz` | 新增/编辑 STDIO MCP | TODO | — | — |
| 13B | 插件配置弹窗 | AC-1h / `ZMKop` | 点击插件卡片 | TODO | — | — |

### 全局

| # | Deliverable | Source (Spec/Pencil Node) | Route/Trigger | Status | Evidence | Reviewer Verdict |
|---|-------------|--------------------------|---------------|--------|----------|------------------|
| 19 | Hyperfocus Brake | AC-1a / `FkBsS` | 定时触发 | TODO | — | — |

---

## Review History

> 每次 Reviewer verdict 在此追加一行

| Date | Commit | Deliverables Covered | Verdict | Notes |
|------|--------|---------------------|---------|-------|
| — | — | — | — | — |

---

## Decisions Log

- Reading Queue: 待定（是否本轮实现 or 降级）
- Skill 新增/编辑: 待定（前端 disabled 态 or 实现配置弹窗）
