import { createHash, randomUUID } from 'node:crypto';
import { type CredentialSources, type ExposureNotice, withSecretToolGuard } from './secret-runtime.js';
import { callbackPost, getCallbackConfig } from './tools/callback-tools.js';

export async function recordSecretExposure(notice: ExposureNotice): Promise<void> {
  const config = getCallbackConfig();
  if (!config) throw new Error('secret_notice_callback_unavailable');
  const opaqueSource = `${config.invocationId ?? 'agent-key'}:${notice.callId ?? randomUUID()}`;
  const id = createHash('sha256')
    .update(`${opaqueSource}:${[...new Set(notice.rules)].sort().join(',')}`)
    .digest('hex');
  const result = await callbackPost(
    '/api/callbacks/post-message',
    {
      clientMessageId: `secret-exposure-${id}`,
      content: `轮转提醒：工具结果中检测到疑似凭据，已在此处隐藏；若已进入原生工具/模型上下文，请轮转相关凭据。规则：${notice.rules.join(', ')}。本提醒不含凭据值。来源：tool-result:${createHash('sha256').update(opaqueSource).digest('hex')}`,
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
  cwd: string = process.cwd(),
  credentialSources?: CredentialSources,
): Promise<T> {
  return withSecretToolGuard(name, args, execute, {
    callId: `${name}:${callId}`,
    cwd,
    credentialSources,
    notify: recordSecretExposure,
  }) as Promise<T>;
}
