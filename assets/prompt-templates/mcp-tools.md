<!-- @segment S13 — MCP tool index for carriers that have native MCP but do NOT inject native L0. -->
<!-- Route layer: hasNativeL0 ? buildStaticIdentityPackOnly : buildStaticIdentity; S13 fires when mcpAvailable = mcpSupport && mcpServerPath. -->
<!-- Body is the SAME index as native L0 §7 (l5-mcp-tools-index.md): one tool index, two MCP planes, no drift. -->
<!-- Carriers without native MCP get C1 (c1-mcp-callback.md): the HTTP-callback surface published at /api/callbacks/instructions — a different contract, not derived from L5. -->
<!-- Variable: {{L5_MCP_TOOLS_INDEX}} — l5 body, injected by loadMcpToolsSection. -->
<!-- The rich-block primer is the L5 富块 clause + cat_cafe_get_rich_block_rules (F-BLOAT short reference); -->
<!-- {{RICH_BLOCK_SHORT}} remains an available variable for mcp-tools.local.md overlays. -->

MCP 工具（异步汇报；token 有效期有限）：

{{L5_MCP_TOOLS_INDEX}}
