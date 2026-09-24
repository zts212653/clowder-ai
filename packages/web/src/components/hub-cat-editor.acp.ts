/**
 * F161: ACP transport configuration helpers for the Hub Cat Editor.
 *
 * Extracted from hub-cat-editor.model.ts to stay within the 500-line limit.
 * NOTE: Does NOT import from hub-cat-editor.model.ts to avoid circular dependency.
 */

export function defaultAcpCommandForClient(client: string): string {
  switch (client) {
    case 'opencode':
      return 'opencode';
    case 'google':
      return 'gemini';
    case 'kimi':
      return 'kimi';
    default:
      return '';
  }
}

/**
 * Default startup args for a given client.
 * The transport parameter is kept for programmatic use (backend httpstream support
 * is retained — F161 followup), but the UI currently only exposes stdio.
 */
export function defaultAcpStartupArgsForClient(client: string, transport: 'stdio' | 'httpstream' = 'stdio'): string {
  let base: string;
  switch (client) {
    case 'opencode':
      base = 'acp';
      break;
    case 'google':
      base = '--acp --approval-mode yolo';
      break;
    case 'kimi':
      base = 'acp';
      break;
    default:
      base = '';
      break;
  }
  if (transport === 'httpstream') {
    return base ? `${base} --port 0` : '--port 0';
  }
  return base;
}

/**
 * Placeholder hint for the startup args input.
 */
export function acpStartupArgsPlaceholder(client: string): string {
  if (client === 'opencode') return 'acp --pure ...';
  return '';
}

/**
 * Returns a warning message when the selected client + ACP combo has known limitations.
 * Currently: kimi ACP requires `kimi login` (managed auth); api_key config won't work.
 */
export function getAcpWarning(client: string, carrier: string): string | null {
  if (carrier !== 'acp') return null;
  if (client === 'kimi') {
    return 'kimi 的 ACP 模式需要先运行 kimi login 登录，apikey 配置不可用';
  }
  return null;
}
