---
feature_ids: [F060]
related_features: [F022]
topics: [rich-block, mcp, image, frontend]
doc_kind: spec
created: 2026-03-04
---

# F060: output_image 富文本渲染

> **Status**: done | **Owner**: 三猫
> **Completed**: 2026-03-06

## Why

MCP 工具（如小红书 `get_login_qrcode`）返回 `output_image` 类型数据时，Hub 前端无法渲染——猫猫看到了二维码但operator看不到。当前 Hub 只支持两种图片渲染路径：

1. `ImageContent`（用户上传，`type: 'image', url: string`）
2. `media_gallery` rich block（需要猫猫主动创建 rich block）

两者都不覆盖 **MCP 工具自动返回的图片** 这个场景。

## What

让 Hub 能自动渲染猫猫调用 MCP 工具后返回的 `output_image`，无需猫猫手动创建 rich block。

### 方案

MCP tool result 中的 `output_image` 是 base64 编码图片。需要在消息流中将其转换为可渲染内容。

**推荐路径**：在 Agent 调用链中拦截 MCP tool result，检测到 `output_image` 类型时自动生成 `media_gallery` rich block（复用现有渲染能力），通过 WebSocket 推到前端。

**备选路径**：新增 `MessageContent` 类型 `tool_image`，前端直接渲染 base64 data URI。

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-1: MCP 工具返回 `output_image` 时，Hub 前端自动显示图片（Phase 1: Codex 路径完成）
- [x] AC-2: 图片可点击放大查看（Phase 2: PR #238）
- [x] AC-5: 图片可复制到剪贴板（Phase 2: PR #238）
- [x] AC-3: 对所有 MCP 工具的 output_image 生效（不限于小红书）
- [x] AC-4: 不需要猫猫额外操作（无需手动创建 rich block）

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "添加一个feat 要做富文本返回 output_image" | AC-1 | screenshot + manual | [x] Phase 1 |
| R2 | 图片可交互（放大查看） | AC-2 | manual | [x] Phase 2 |
| R3 | 通用化，不限特定 MCP | AC-3 | test | [x] |
| R4 | 自动化，不增加猫猫负担 | AC-4 | test | [x] |
| R5 | "方便我复制"（图片可复制到剪贴板） | AC-5 | manual | [x] Phase 2 |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）

## Key Decisions

- **KD-1 (2026-03-04)**: 复用 `media_gallery` rich block，不新增类型。理由：富媒体本来就是要能发图发语音，output_image 是图片的一种来源，复用现有渲染组件最合理。（operator拍板）
- **KD-2 (2026-03-05)**: Phase 1 先做 Codex 路径（Codex CLI 在 `mcp_tool_call` completed 事件中暴露完整 result content 数组）。Claude CLI 内部消费 MCP tool result，不在 NDJSON 中暴露原始图片数据，需要后续 Phase 单独处理。

## Implementation Plan (2026-03-05 POC 验证通过)

### 调查发现

1. **Codex CLI**: `item.completed` + `item.type === 'mcp_tool_call'` 的 `result.content[]` 包含 `{ type: 'image', data: base64, mimeType: string }` 块，但 `codex-event-transform.ts:178-180` 只提取 `type === 'text'` 的块，**image 块被静默丢弃**
2. **Claude CLI**: NDJSON 流不暴露 MCP tool result 内容（Claude 内部消费后只输出 assistant text/tool_use），无法在 event transform 层拦截
3. **前端**: `MediaGalleryBlock.tsx` 的 `<img src={item.url}>` 天然支持 `data:image/png;base64,...` data URI
4. **Rich block 管线**: `system_info` → `{ type: 'rich_block', block: {...} }` → `useAgentMessages.ts` `appendRichBlock()` 已完整可用

### Phase 1 实施步骤（Codex 路径）

**Step 1**: `codex-event-transform.ts`
- 返回类型从 `AgentMessage | null` 改为 `AgentMessage | AgentMessage[] | null`（与 `transformClaudeEvent` 一致）
- `mcp_tool_call` completed 分支：提取 image blocks → 构造 `media_gallery` rich block → 返回 `[tool_result, system_info(rich_block)]`
- 无 image 块时行为不变（返回单个 `tool_result`）

**Step 2**: `CodexAgentService.ts`
- 消费端适配数组返回（参照 `ClaudeAgentService.ts:224-240` 的 `Array.isArray(result)` 模式）

**Step 3**: 测试
- `codex-event-transform.test.js`: mcp_tool_call with image → returns [tool_result, system_info(rich_block)]
- `codex-event-transform.test.js`: mcp_tool_call with multiple images → gallery has multiple items
- `codex-event-transform.test.js`: mcp_tool_call text-only → unchanged single tool_result
- `codex-event-transform.test.js`: image block without mimeType → graceful skip

### Phase 2（后续，不在本 PR）

- Claude 路径：可能需要在 MCP server 层拦截 tool result，或在 Claude CLI 侧扩展
- 大图片优化：base64 超过阈值时存服务端返回 URL
- AC-2 图片放大：前端 MediaGalleryBlock 添加 lightbox 交互
- AC-5 图片复制：右键菜单或按钮，将图片复制到剪贴板（operator需要方便复制 QR 码等）

## Dependencies

- **Related**: F022（rich blocks 基础设施）+ 小红书 MCP 集成
- `Evolved from`: F022（rich blocks 基础设施）
- `Related`: 小红书 MCP 集成

## Risk

- 低：base64 图片可能较大，需考虑消息体积
- 低：安全性——需验证 base64 内容确实是图片

## Review Gate

- Reviewer: 跨家族优先（Maine Coon）
- 验收: operator用小红书 QR 码场景端到端验证

## Acceptance Sign-off

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll/Ragdoll | F060 spec, BACKLOG, operator experience | 核心问题已解决，交付物完全匹配，operator亲自验收通过 | ✅ |
| Maine Coon/Maine Coon | F060 spec, MediaGalleryBlock.tsx, codex-event-transform.ts | R1→R2 两轮 review，AC 对齐确认 | ✅ |
| operator | Hub 前端实际操作 | "验收成功"+"f60 大成功" | ✅ |

## Implementation Evidence (Phase 1)

### 改动文件
- `codex-event-transform.ts`: 提取 `output_image` → `media_gallery` rich block + mimeType 白名单 + 5MB base64 上限
- `route-serial.ts` / `route-parallel.ts`: `system_info(rich_block)` 持久化到 `extra.rich`
- `codex-event-transform.test.js`: +4 测试用例（image 提取、多图、无图不变、安全边界 ×5）

### 测试结果
- `codex-event-transform.test.js`: 29/29 pass
- `route-strategies.test.js`: 51/51 pass
- TypeScript: clean
- Biome: 无新增 lint issue

### Peer Review
- Reviewer: Maine Coon/Maine Coon (codex)
- R1: Request changes (P1: 持久化缺失, P2: 无大小/类型约束)
- R2: Approved (0 P1/P2, 1 P3 非阻塞建议)
