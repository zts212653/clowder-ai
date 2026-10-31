import { randomUUID } from 'node:crypto';
import { configuredCredentialValues, inspectSecretValue } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { recordSecretExposure } from '@cat-cafe/mcp-server/dist/secret-tool-guard.js';
import { withInvocationCredentials } from '@cat-cafe/mcp-server/dist/tools/invocation-auth.js';
import type { AgentMessage, AgentServiceOptions } from '../../types.js';

/** Native providers may already have consumed the result. This protects host consumers and records exposure. */
export async function protectNativeProviderResult(
  message: AgentMessage,
  options: AgentServiceOptions,
): Promise<AgentMessage> {
  if (message.type !== 'tool_result') return message;
  const inspectionOptions = {
    knownCredentials: configuredCredentialValues({ ...process.env, ...options.callbackEnv }),
  };
  let inspected: { value: AgentMessage; rules: string[] };
  try {
    // ACP retains the rejected input and an input-derived title on its final
    // event. Redact those fields too, but only output is evidence of exposure.
    const safe = inspectSecretValue(message, inspectionOptions);
    const output = inspectSecretValue(
      {
        content: message.content,
        rawOutput: message.toolRawPayload?.rawOutput,
        rawContent: message.toolRawPayload?.content,
      },
      inspectionOptions,
    );
    inspected = { value: safe.value, rules: output.rules };
  } catch {
    return message;
  }
  if (!inspected.rules.length) return inspected.value;
  let recorded = false;
  try {
    const env = options.callbackEnv;
    if (!env?.CAT_CAFE_INVOCATION_ID || !env.CAT_CAFE_CALLBACK_TOKEN || !env.CAT_CAFE_API_URL)
      throw new Error('notice_auth_unavailable');
    await withInvocationCredentials(
      {
        invocationId: env.CAT_CAFE_INVOCATION_ID,
        callbackToken: env.CAT_CAFE_CALLBACK_TOKEN,
        apiUrl: env.CAT_CAFE_API_URL,
      },
      () =>
        recordSecretExposure({
          state: 'exposed_or_suspected',
          callId: message.toolUseId ?? randomUUID(),
          rules: inspected.rules,
        }),
    );
    recorded = true;
  } catch {
    /* Preserve a visible reminder even when its persistent sink is unavailable. */
  }
  const summary =
    '工具结果包含当前已配置的凭据值，匹配内容已在返回家里前隐藏；原生提供方可能已经消费结果，请按原授权轮转对应凭据。';
  return {
    ...inspected.value,
    content: `${inspected.value.content ?? ''}\n\n${summary}核验记录${recorded ? '已持久保存' : '未能保存'}。`,
  };
}
