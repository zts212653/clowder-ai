/**
 * MCP Prompt Injector
 * 给没有原生 MCP 支持的猫 (Codex/Gemini) 注入 HTTP callback 指令。
 * Claude 通过 --mcp-config 原生支持 MCP，不需要注入。
 *
 * Skills-as-source-of-truth: Full API docs live in
 *   cat-cafe-skills/refs/mcp-callbacks.md
 * Prompt injection is minimal: credentials + tool list + skill reference.
 * HTTP endpoints preserved as fallback only.
 */

export interface McpCallbackOptions {
  /**
   * Example unique handle to show in documentation snippets.
   * Must be routable (e.g. `@codex`, `@opus-45`), not a placeholder like `@catId`.
   */
  exampleHandle?: string;
  /**
   * Current cat id for choosing a non-self @mention example.
   * When present with teammates, we will prefer a teammate handle in examples.
   */
  currentCatId?: string;
  /**
   * Teammate cat ids that are safe to demonstrate in @mention examples.
   * Should NOT include the current cat id; if it does, it will be ignored.
   */
  teammates?: readonly string[];
}

/**
 * Check if a cat needs MCP prompt injection (HTTP callback fallback).
 *
 * F041: Now checks if MCP is *actually available* (config + server path exist),
 * not just the mcpSupport config flag. HTTP callback injection acts as
 * fallback when native MCP is unavailable for any reason.
 *
 * @param mcpAvailable - true when native MCP is configured AND server path exists
 * @param clientId - provider clientId; 'antigravity' skips injection (LS persistent process can't receive callback env)
 */
export function needsMcpInjection(mcpAvailable: boolean, clientId?: string): boolean {
  if (clientId === 'antigravity') return false;
  return !mcpAvailable;
}

function resolveExampleHandle(opts: McpCallbackOptions): string {
  return (
    opts.exampleHandle ??
    (() => {
      const teammate = opts.teammates?.find((id) => id && id !== opts.currentCatId);
      return teammate ? `@${teammate}` : '@opus';
    })()
  );
}

/**
 * Build MCP callback instructions for prompt injection.
 * Minimal: @teammate rules + credentials + tool list + skill reference.
 * Full API docs are in cat-cafe-skills/refs/mcp-callbacks.md.
 */
export function buildMcpCallbackInstructions(opts: McpCallbackOptions): string {
  const exampleHandle = resolveExampleHandle(opts);
  return `## 协作方式

### @队友
另起一行写 \`@猫名\`（行中间无效），并在同一段写动作请求。多只猫各占一行。
动作词示例：\`请确认/请处理/请决策/请看一下\`。
同族多分身时用**唯一句柄**（如 \`${exampleHandle}\`）。
✅ 正确：\`${exampleHandle} 请确认这个安排\`
❌ 错误：为了 @ 队友去调 post-message

### HTTP 回调（异步）
凭证: \`$CAT_CAFE_INVOCATION_ID\` + \`$CAT_CAFE_CALLBACK_TOKEN\`
可用工具: post-message / register-pr-tracking / thread-context / list-threads / feat-index / list-tasks / pending-mentions / create-task / update-task / create-rich-block / search-evidence / reflect / retain-memory / request-permission / submit-game-action
跨 thread: cross-post-message + \`threadId\`
检索消息: thread-context + \`catId\`/\`keyword\`
检索 feature: feat-index + \`featId\`/\`query\`
完整用法: GET \`$CAT_CAFE_API_URL/api/callbacks/instructions\`
富消息规范: GET \`$CAT_CAFE_API_URL/api/callbacks/rich-block-rules\``;
}
