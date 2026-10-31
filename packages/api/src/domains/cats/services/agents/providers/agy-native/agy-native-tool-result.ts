/** Keep stdout and the native failure reason; neither one is a substitute for the other. */
export function agyNativeToolResultContent(output: string | null, error: string | null, complete = true): string {
  const parts = output ? [output] : [];
  if (error && !output?.includes(error)) parts.push(error);
  if (!complete) parts.push('Native tool result unconfirmed: the carrier ended before reporting a terminal result.');
  return parts.join('\n\n');
}
/** Unwrap the MCP envelope before host custody, memory telemetry and UI consume it. */
export function agyNativeToolIdentity(name: string, parameters: Record<string, unknown>) {
  const server = parameters.ServerName;
  const tool = parameters.ToolName;
  const args = parameters.Arguments;
  if (name === 'call_mcp_tool' && typeof server === 'string' && typeof tool === 'string' && server && tool) {
    return {
      toolName: `mcp:${server}/${tool}`,
      toolInput:
        args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : parameters,
      toolSource: 'mcp' as const,
    };
  }
  return {
    toolName: name,
    toolInput: parameters,
    toolSource: name === 'call_mcp_tool' ? ('mcp' as const) : ('host_cli' as const),
  };
}
