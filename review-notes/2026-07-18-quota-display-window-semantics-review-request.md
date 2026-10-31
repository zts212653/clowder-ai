# Review Request: 配额统一显示剩余百分比，并按 Wham 窗口时长命名

Review-Target-ID: fix-1027-quota-codex-auth
Branch: fix/1027-quota-codex-auth
Original implementation commit: `1af0318b28de3a50c8de17a5a8d63ae82c3df3c9` (pre-rebase)

## Review Status

**CHANGES ADDRESSED — exact rebased HEAD review pending.**

The earlier independent approval covered the pre-rebase branch through `429630b8` only. PR #1172 subsequently received two blocking authority/isolation findings, so that approval does not cover the corrected code recorded below and must not be cited as approval of the current HEAD.

The correction commit containing this note:

- keeps an explicit `CODEX_CREDENTIALS_PATH` authoritative for both native and legacy file shapes;
- fails closed when that explicit file is missing, malformed, or incomplete instead of selecting an ambient account;
- limits missing-credential and disabled-refresh cache/error writes to the requested providers;
- adds symmetric regression coverage proving a Codex-only failure preserves Claude state and a Claude-only failure preserves Codex state.

After this correction is pushed, the rebased exact diff still requires an independent verdict.

## What

- Web 配额行统一显示 `X% 剩余`，进度条也统一表达剩余额度；内部风险判断仍使用已用比例。
- Codex Wham parser 读取 `limit_window_seconds`：七天窗口显示“每周使用限额”，其他整天/整小时窗口按实际时长命名。
- legacy Codex 凭证测试强制使用临时 `CODEX_HOME`，避免测试读取或展开真实登录凭证。

## Why

runtime 当次 `GET /api/quota` 为 `27% 已用`，但用户希望看板口径统一为剩余量；Wham 实际返回的 primary window 是 `604800` 秒且没有 secondary window，旧 parser 却把 primary 永久写死为“5小时使用限额”。

## Original Requirements（必填）

> “请统一修改一下显示的方式，当前是27%已用，能否展示为74%剩余？”
> “我记得现在2026年7月18号，codex coding plan已经不再有5h使用限额的概念了，统一都是每周的使用限额，请帮忙确认一下。”

- 来源：`docs/bug-report/quota-display-window-semantics/bug-report.md`
- 请对照上面的摘录判断交付物是否解决了 operator 的问题；特别核对数学口径应为 27% 已用 → 73% 剩余。

## Tradeoff

没有把所有 Codex 套餐无条件硬编码成周限额。OpenAI 当前公开文档说明 Codex 使用 token/credit rate card 和共享用量池，但没有承诺所有账号只有同一种重置窗口；因此采用实时 Wham `limit_window_seconds` 作为账号级真相源。旧响应缺少时长时沿用旧标签，保持兼容。

## Architecture Ownership（必填）

Architecture cell: existing quota API parser + quota-cards projection（当前 ownership map 无独立 quota cell）
Map delta: none
Why: 只修正既有 parser 字段解释和既有展示口径，没有新增 Store / Queue / Router / Adapter / Dispatcher / Binding 或改变边界。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- 是否意外引入并行基础设施抽象；
- duration → label 的 fallback 是否会误报窗口类型。

## Open Questions

### 技术 OQ（给 reviewer）

1. `percentKind=used/remaining` 两种输入是否都严格转换为同一“剩余”显示和进度条宽度？
2. 七天 primary window + `secondary_window=null` 是否稳定渲染为单一“每周使用限额”？
3. legacy 测试的临时 `CODEX_HOME` 是否足以阻断 ambient live auth 被读取和进入断言差异？

### 价值 OQ（给 operator，如有）

无。

## Next Action

请独立复跑定向测试，并在隔离浏览器中用 27% used / 604800-second window 验证“每周使用限额 / 73% 剩余”。若无 P1/P2，请明确 APPROVE；若有 finding，请给严重级别和精确证据。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/fix-1027-quota-codex-auth/cat-zwe1nf05`
- Start Command: `pnpm review:start --web-port=3221 --api-port=3222`
- Ports: `web=3221`, `api=3222`（3003/3004 不得访问）
- 安全要求：显式取消 `CAT_CAFE_RUNTIME_RESTART_OK`，使用临时 `CODEX_HOME` 和 `CAT_CAFE_GLOBAL_CONFIG_ROOT`，不得刷新真实 OAuth 用量。

## 自检证据

### Spec 合规

- 27% used → 73% remaining，口径统一。
- 604800 秒 → 每周使用限额；不把官方公开套餐描述臆测成所有账号的固定接口契约。
- 不改缓存/风险语义，仅改展示投影和窗口标签推导。
- 真实凭证测试污染已用临时 `CODEX_HOME` 修复。

### 测试结果

- 原始显示语义实现：API 65 passed，Web 21 passed；详见下列既有证据。
- PR #1172 review 修正的 Red 阶段：API 64 passed, 5 failed；失败精确覆盖显式凭证权威/失败关闭、双向 provider cache 隔离及 disabled 分支隔离。
- PR #1172 review 修正的 Green 阶段：API build + `node --test test/quota-api.test.js`: 69 passed, 0 failed（isolated `CODEX_HOME`）。
- Web `vitest ...hub-quota-board-v2.test.ts`: 21 passed, 0 failed。
- Web `tsc --noEmit`: passed。
- Web production build: passed。
- Biome targeted check: exit 0，12 个既有 warning，无 error。
- `git diff --check`: passed。
- 根目录媒体/设计工件闸门：空。

### 浏览器证据

- 作者隔离实例：Web 3221 / API 3222 / memory store / 临时 config root。
- 注入账号 `my-codex-account` 和样本 `每周使用限额, usedPercent=27`；`/settings` 返回 200，Hub Browser Preview 已打开。
- 组件层 SSR 回归断言精确验证 `73% 剩余` 且不存在 `27% 已用`；请 reviewer 做独立视觉复核。

### 相关文档

- Bug report: `docs/bug-report/quota-display-window-semantics/bug-report.md`
- Original implementation commit: `1af0318b28de3a50c8de17a5a8d63ae82c3df3c9` (pre-rebase)
- Review correction: the commit containing this updated note; independent exact-HEAD verdict pending

[清明/gpt-5.6-sol🐾]
