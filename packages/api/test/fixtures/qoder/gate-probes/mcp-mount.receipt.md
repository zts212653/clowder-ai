# MCP mount gate probe — 2026-09-13 L1

## qodercn 挂载机制（哑只读 echo server 扮演 cat-cafe-memory）
- `--mcp-config <json> --strict-mcp-config --allowed-mcp-server-names cat-cafe-memory` →
  `init.mcp_servers == [{name:"cat-cafe-memory", status:"connected"}]`（builtin plugin 被过滤 ✓）
- **headless 下 MCP 工具调用默认被权限系统拒绝**：模型尝试 probe_echo →
  `tool_result is_error:true, "Error: Allow MCP tool cat-cafe-memory/probe_echo?"`（非交互自动拒）
  → 安全利好；Phase 1 运行时需要预授权机制（I-10 新增项：MCP 工具 allowlist 预授权方案）
- 排障记录：MCP server 须从可解析 `@modelcontextprotocol/sdk` 的目录启动（/tmp 下 spawn 即崩 → disconnected）

## cat-cafe-memory 实挂 readonly 断言 —— ✅ 已解除（2026-09-13 修复后复验）

**根因修正**（点点 PR #1454 实证，取代本文下方的初步诊断）：legacy 入口**有**过滤；
66 = `READONLY_ALLOWED_TOOLS(27) ∪ AGENT_KEY_TOOLS(39)` 精确相等（并集外 0 个）——
probe 环境泄漏了 `CAT_CAFE_AGENT_KEY_*` 触发按设计的并集。风险判定仍成立：
readonly 边界不应因环境泄漏扩大。修复契约：`CAT_CAFE_READONLY=true` 严格 27；
并集需显式 `CAT_CAFE_READONLY_AGENT_KEY_UNION=true` + 真实凭证。
**复验（clowder-ai 镜像 e11f72aa8，fresh build）**：strict=27 全在白名单 PASS /
泄漏 agent-key env=27 PASS / 显式 opt-in=66 PASS。

### 初步诊断（已被上方修正取代，保留供追溯）
独立 stdio client（官方 SDK）+ `CAT_CAFE_READONLY=true` 拉 tools/list：
- **实际暴露 66 工具**（含 39 个写操作：cross_post_message / backfill_events / teleport / remove_scheduled_task 等）
- `READONLY_ALLOWED_TOOLS` 白名单仅 27 个
- 根因：`packages/mcp-server/src/server-toolsets.ts` 的 `registerFullToolset`（legacy all-in-one 入口
  `dist/index.js` 使用）**未调用 `applyReadonlyFilter`**，`CAT_CAFE_READONLY` 在该入口形同虚设
- 处置：F317 侧 blocked-on-runtime——cat-cafe-memory 实挂断言推迟到 runtime 修复后补；
  Phase 1 首个产品 invocation 前必须修复（否则 qodercn 若获得预授权将直接拿到写工具面）

## P1-C 实证
`disconnected`（spawn 失败）与 `connected`（成功）均为活词汇 → 方言层 status 映射（disconnected→failed）确认必要
