import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Local configuration evidence only; never validates a key over the network or
 * starts Claude (even `auth status` can migrate the user's settings file).
 */
export function hasNativeClaudeApiConfig(): boolean {
  let configured: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8'),
    );
    if (value && typeof value === 'object' && 'env' in value && value.env && typeof value.env === 'object') {
      configured = value.env as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable settings still permit shell-provided API credentials.
  }
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((key) => {
    const value = configured[key] ?? process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}
