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

import { renderSegment } from '../../context/prompt-template-loader.js';

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
 * Template: assets/prompt-templates/c1-mcp-callback.md
 * Full API docs are in cat-cafe-skills/refs/mcp-callbacks.md.
 */
/* @segment C1 — MCP Callback Instructions */
export function buildMcpCallbackInstructions(opts: McpCallbackOptions): string {
  const exampleHandle = resolveExampleHandle(opts);
  return renderSegment('C1', { EXAMPLE_HANDLE: exampleHandle }) ?? '';
}
