import { createHash, randomUUID } from 'node:crypto';
import { type CredentialSources, type ExposureNotice, withSecretToolGuard } from './secret-runtime.js';
import { resolveSharedInvocationContext } from './tools/invocation-auth.js';

export async function recordSecretExposure(notice: ExposureNotice): Promise<void> {
  // Clean transport relays do not need to construct the callback tool schemas.
  // Load the existing notice path only when there is an exposure to record.
  const { callbackPost, getCallbackConfig } = await import('./tools/callback-tools.js');
  const config = getCallbackConfig();
  if (!config) throw new Error('secret_notice_callback_unavailable');
  const opaqueSource = `${config.invocationId ?? 'agent-key'}:${notice.callId ?? randomUUID()}`;
  const id = createHash('sha256')
    .update(`${opaqueSource}:${[...new Set(notice.rules)].sort().join(',')}`)
    .digest('hex');
  const summary = notice.rules.includes('uninspectable-result')
    ? '工具结果的安全检查未完成，未据此确认凭据泄露。'
    : '工具结果命中疑似凭据格式，尚未核实真实凭据；仅在确认真实凭据已暴露后按原授权轮转。';
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
): Promise<T> {
  return withSecretToolGuard(name, args, execute, {
    callId: `${name}:${callId}`,
    cwd: cwd ?? resolveSharedInvocationContext()?.workspaceRoot ?? process.cwd(),
    credentialSources,
    notify: recordSecretExposure,
  }) as Promise<T>;
}
