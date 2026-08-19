import { readFileSync } from 'node:fs';

export interface InvocationCredentialValues {
  invocationId: string | undefined;
  callbackToken: string | undefined;
}

function readCredentialFile(): { invocationId: string; callbackToken: string } | null {
  const filePath = process.env.CAT_CAFE_CREDENTIAL_FILE;
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const invocationId = typeof parsed.invocationId === 'string' ? parsed.invocationId : '';
    const callbackToken = typeof parsed.callbackToken === 'string' ? parsed.callbackToken : '';
    return invocationId && callbackToken ? { invocationId, callbackToken } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current invocation credential pair. Long-lived MCP subprocesses
 * prefer the owner-only refresh file; legacy one-shot subprocesses fall back
 * to their launch environment.
 */
export function resolveInvocationCredentials(): InvocationCredentialValues {
  const fileCreds = readCredentialFile();
  return {
    invocationId: fileCreds?.invocationId ?? process.env.CAT_CAFE_INVOCATION_ID,
    callbackToken: fileCreds?.callbackToken ?? process.env.CAT_CAFE_CALLBACK_TOKEN,
  };
}

/**
 * Non-secret signal for MCP-side principal guards and correlation paths.
 * Callback tokens remain inside the HTTP authentication boundary.
 */
export function getInvocationAuthSignal(): {
  invocationId: string | undefined;
  hasFullCredentials: boolean;
} {
  const { invocationId, callbackToken } = resolveInvocationCredentials();
  return {
    invocationId,
    hasFullCredentials: Boolean(invocationId && callbackToken),
  };
}
