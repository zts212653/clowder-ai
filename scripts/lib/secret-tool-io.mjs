import { nativeSecretDenial } from '../native-secret-policy.mjs';
import { configuredCredentialValues } from './secret-credential-paths.mjs';
import { createPayloadSnapshot, readSecretPayload } from './secret-payload-files.mjs';
import { inspectSecretValue } from './secret-value-inspection.mjs';

const FILE_KEYS = /^(?:path|paths|file|files|file_?path|file_?paths|filename|attachment|attachments)$/i;
const FILE_SENDERS = /upload|attach|send_file|publish|post_file/;
export const PENDING_EXPOSURE_NOTICE = '[cat-cafe:secret-' + 'exposure:notice-pending]';
const failure = (code) => ({
  isError: true,
  content: [
    { type: 'text', text: `${code}: this operation was blocked before execution; no credential value is included.` },
  ],
});

export async function withSecretToolGuard(name, args, execute, options = {}) {
  let prepared;
  try {
    prepared = prepareSecretToolInput(name, args, options);
  } catch (error) {
    return failure(error.code ?? 'secret_payload_uninspectable');
  }
  let result;
  try {
    result = await execute(prepared.input);
  } catch {
    return failure('tool_execution_failed');
  } finally {
    prepared.dispose();
  }
  return protectSecretToolResult(result, options);
}

/** Providers with before/after hooks own this bounded lease until completion. */
export function prepareSecretToolInput(name, args, options = {}) {
  const snapshot = createPayloadSnapshot();
  try {
    const outbound = options.outbound === true;
    const denial = nativeSecretDenial({ tool_name: name, tool_input: args, cwd: options.cwd });
    if (denial || (outbound && inspectSecretValue(args).rules.length))
      throw Object.assign(new Error('Secret tool input blocked'), {
        code: denial ?? 'secret_content_blocked_before_send',
      });
    return {
      input:
        outbound && FILE_SENDERS.test(name)
          ? freezeToolFiles(args, snapshot, options.cwd, options.credentialSources)
          : args,
      dispose: () => snapshot.dispose(),
    };
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

export async function protectSecretToolResult(result, options = {}) {
  let inspected;
  try {
    inspected = inspectSecretValue(result, {
      knownCredentials: options.knownCredentials ?? configuredCredentialValues(options.environment ?? process.env),
    });
  } catch {
    // Incomplete local observation is not evidence of a credential exposure.
    return result;
  }
  if (!inspected.rules.length) return result;
  let rotationNotice = 'failed';
  try {
    if (!options.notify) throw new Error('notice_sink_unavailable');
    await options.notify({ state: 'exposed_or_suspected', callId: options.callId, rules: inspected.rules });
    rotationNotice = 'recorded';
  } catch {
    /* The safe result reports this gap; do not expose the original again. */
  }
  const summary = '工具结果包含当前已配置的凭据值，匹配内容已隐藏；请按原授权轮转对应凭据。';
  return {
    ...inspected.value,
    _meta: {
      ...inspected.value?._meta,
      secretExposure: { state: 'exposed_or_suspected', rules: inspected.rules, rotationNotice },
    },
    content: [
      ...(Array.isArray(inspected.value?.content) ? inspected.value.content : []),
      {
        type: 'text',
        text: `${summary}核验记录${rotationNotice === 'recorded' ? '已持久保存' : '未能保存'}。`,
      },
      ...(rotationNotice === 'failed' ? [{ type: 'text', text: PENDING_EXPOSURE_NOTICE }] : []),
    ],
  };
}

function freezeToolFiles(value, snapshot, cwd, credentialSources, key = '') {
  if (typeof value === 'string' && FILE_KEYS.test(key))
    return snapshot.freeze(readSecretPayload(value, cwd, credentialSources), value);
  if (Array.isArray(value)) return value.map((child) => freezeToolFiles(child, snapshot, cwd, credentialSources, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        freezeToolFiles(child, snapshot, cwd, credentialSources, name),
      ]),
    );
  return value;
}
