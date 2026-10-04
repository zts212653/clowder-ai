import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';

export interface InvocationCredentialValues {
  invocationId: string | undefined;
  callbackToken: string | undefined;
}

const requestCredentials = new AsyncLocalStorage<InvocationCredentialValues>();

/** Native carriers bind credentials per runtime turn, never by mutating process.env. */
export function withInvocationCredentials<T>(credentials: InvocationCredentialValues, run: () => T): T {
  return requestCredentials.run(credentials, run);
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
  const scoped = requestCredentials.getStore();
  if (scoped) return scoped;
  if (process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
    return { invocationId: undefined, callbackToken: undefined };
  }
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
