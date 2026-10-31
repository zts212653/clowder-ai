import { createHash, randomUUID } from 'node:crypto';
import {
  type CredentialSources,
  configuredCredentialValues,
  type ExposureNotice,
  withSecretToolGuard,
} from './secret-runtime.js';
import { resolveInvocationCredentials, resolveSharedInvocationContext } from './tools/invocation-auth.js';

export async function recordSecretExposure(notice: ExposureNotice): Promise<void> {
  if (!notice.rules.includes('known-credential')) return;
  // Clean transport relays do not need to construct the callback tool schemas.
  // Load the existing notice path only when there is an exposure to record.
  const { callbackPost, getCallbackConfig } = await import('./tools/callback-tools.js');
  const config = getCallbackConfig();
  if (!config) throw new Error('secret_notice_callback_unavailable');
  const opaqueSource = `${config.invocationId ?? 'agent-key'}:${notice.callId ?? randomUUID()}`;
  const id = createHash('sha256')
    .update(`${opaqueSource}:${[...new Set(notice.rules)].sort().join(',')}`)
    .digest('hex');
  const summary = '工具结果包含当前已配置的凭据值；请按原授权轮转对应凭据。';
  const result = await callbackPost(
    '/api/callbacks/post-message',
    {
      clientMessageId: `secret-exposure-${id}`,
      content: `安全核验记录：${summary}规则：${notice.rules.join(', ')}。本记录不含凭据值。来源：tool-result:${createHash('sha256').update(opaqueSource).digest('hex')}`,
    },
    { retryDelaysMs: [], fetchTimeoutMs: 3000 },
  );
  if (result.isError) throw new Error('secret_notice_not_persisted');
}

/** This wrapper is inside the invocation-auth scope, before any handler effect. */
export async function guardSecretToolCall<T>(
  name: string,
  args: unknown,
  execute: (args: unknown) => Promise<T>,
  callId: string = randomUUID(),
  cwd?: string,
  credentialSources?: CredentialSources,
  options: { outbound?: boolean; knownCredentials?: string[] } = {},
): Promise<T> {
  const knownCredentials = [...(options.knownCredentials ?? configuredCredentialValues())];
  // Reuse this request's authenticated principal, without searching provider key stores.
  try {
    const token = resolveInvocationCredentials().callbackToken;
    if (token && token.length >= 24) knownCredentials.push(token);
  } catch {
    // Missing observation authority must not become another tool execution stop.
  }
  return withSecretToolGuard(name, args, execute, {
    callId: `${name}:${callId}`,
    cwd: cwd ?? resolveSharedInvocationContext()?.workspaceRoot ?? process.cwd(),
    credentialSources,
    outbound: options.outbound,
    knownCredentials,
    notify: recordSecretExposure,
  }) as Promise<T>;
}
