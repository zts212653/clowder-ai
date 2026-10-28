import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { parseSharedInvocationContext, type SharedInvocationContext } from '../shared-invocation-context.js';

export interface InvocationCredentialValues {
  invocationId: string | undefined;
  callbackToken: string | undefined;
  /**
   * Scoped API base URL for in-process carriers (member MCP gateway).
   * Child processes keep reading CAT_CAFE_API_URL from their launch env.
   */
  apiUrl?: string;
  /** Verified member identity for in-process carriers (member MCP gateway). */
  catId?: string;
  /** Verified member identity for in-process carriers (member MCP gateway). */
  userId?: string;
  /** Verified member identity for in-process carriers (member MCP gateway). */
  threadId?: string;
  /** Complete Host projection: presence forbids ambient authority fallbacks. */
  sharedContext?: SharedInvocationContext;
  /** Rechecks current invocation/family/tool authority immediately before protected work. */
  authorizeTool?: (name: string) => Promise<void>;
  requestSignal?: AbortSignal;
}

const requestCredentials = new AsyncLocalStorage<InvocationCredentialValues>();

/** Native carriers bind credentials per runtime turn, never by mutating process.env. */
export function withInvocationCredentials<T>(credentials: InvocationCredentialValues, run: () => T): T {
  return requestCredentials.run(credentials, run);
}

export function resolveSharedInvocationContext(): SharedInvocationContext | undefined {
  const context = requestCredentials.getStore()?.sharedContext;
  return context === undefined ? undefined : parseSharedInvocationContext(context);
}

export async function authorizeInvocationTool(name: string): Promise<void> {
  await requestCredentials.getStore()?.authorizeTool?.(name);
}

export function resolveInvocationRequestSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const bound = requestCredentials.getStore()?.requestSignal;
  return bound && signal ? AbortSignal.any([bound, signal]) : (bound ?? signal ?? undefined);
}

/** Preserve each helper's timeout while cancelling only its admitted request. */
export const invocationFetch: typeof fetch = (input, init) => {
  const signal = resolveInvocationRequestSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined));
  return fetch(input, signal ? { ...init, signal } : init);
};

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
 * True when the current async context is an in-process invocation-bound
 * carrier (member MCP gateway or a native-turn tool call) that bound verified
 * credentials. Those carriers must never fall back to the API host's
 * persistent agent-key material.
 */
export function hasInvocationCredentialScope(): boolean {
  return requestCredentials.getStore() !== undefined;
}

/** A bound invocation must supply its own user; only launcher calls may use the legacy principal. */
export function resolveInvocationUserId(legacyUserId: string): string {
  const scoped = requestCredentials.getStore();
  if (!scoped) return legacyUserId;
  if (!scoped.userId?.trim()) throw new Error('Verified invocation userId is required');
  return scoped.userId;
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
  if (
    process.env.CAT_CAFE_CREDENTIAL_FILE &&
    process.env.CAT_CAFE_MCP_TRANSPORT === 'stdio' &&
    process.env.CAT_CAFE_INVOCATION_ID &&
    fileCreds?.invocationId !== process.env.CAT_CAFE_INVOCATION_ID
  )
    return { invocationId: undefined, callbackToken: undefined };
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

/**
 * API base URL bound to the current turn, when the carrier runs in-process
 * (member gateway). Returns undefined for MCP child processes, which must
 * fall back to CAT_CAFE_API_URL from their launch environment.
 */
export function resolveScopedApiBaseUrl(): string | undefined {
  const store = requestCredentials.getStore();
  if (store?.sharedContext !== undefined && !store.apiUrl?.trim())
    throw new Error('Shared invocation API destination is required');
  return store?.apiUrl;
}

export type ScopedInvocationEnvName =
  | 'CAT_CAFE_API_URL'
  | 'CAT_CAFE_CAT_ID'
  | 'CAT_CAFE_USER_ID'
  | 'CAT_CAFE_THREAD_ID'
  | 'CAT_CAFE_DATA_DIR'
  | 'ALLOWED_WORKSPACE_DIRS'
  | 'CAT_CAFE_DESKTOP_MODE';

const SCOPED_ENV_FIELDS = {
  CAT_CAFE_API_URL: 'apiUrl',
  CAT_CAFE_CAT_ID: 'catId',
  CAT_CAFE_USER_ID: 'userId',
  CAT_CAFE_THREAD_ID: 'threadId',
} as const;

/**
 * Resolve a launcher env value with the per-turn invocation scope taking
 * precedence. MCP child processes have no scope and keep reading their launch
 * env exactly as before; the in-process member gateway binds the verified
 * member identity so handlers never use the API host env by accident.
 */
export function resolveInvocationEnv(name: ScopedInvocationEnvName): string | undefined {
  const store = requestCredentials.getStore();
  if (store?.sharedContext !== undefined) {
    if (name in SCOPED_ENV_FIELDS) {
      const value = store[SCOPED_ENV_FIELDS[name as keyof typeof SCOPED_ENV_FIELDS]];
      if (!value?.trim()) throw new Error(`Shared invocation ${name} is required`);
      return value;
    }
    const context = parseSharedInvocationContext(store.sharedContext);
    if (name === 'CAT_CAFE_DATA_DIR') return context.dataDir;
    if (name === 'ALLOWED_WORKSPACE_DIRS') return context.allowedWorkspaceDirs.join(',');
    if (name === 'CAT_CAFE_DESKTOP_MODE') return context.desktopMode;
    return undefined;
  }
  const scoped =
    name in SCOPED_ENV_FIELDS ? store?.[SCOPED_ENV_FIELDS[name as keyof typeof SCOPED_ENV_FIELDS]] : undefined;
  if (typeof scoped === 'string' && scoped.length > 0) return scoped;
  return process.env[name];
}
