import { pathToFileURL } from 'node:url';

const denied = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

async function notify(notice) {
  const { recordSecretExposure } = await import('../packages/mcp-server/dist/secret-tool-guard.js');
  await recordSecretExposure(notice);
}

function postToolUseOutput(result) {
  const noticeFailed = result._meta.secretExposure.rotationNotice === 'failed';
  const context = result.content.slice(noticeFailed ? -2 : -1).map((part) => part.text);
  const summary = '原生工具结果包含当前已配置的凭据值，可能已被原生提供方消费，无法撤回；请按原授权轮转对应凭据。';
  context[0] = `${summary}核验记录${noticeFailed ? '未能保存' : '已持久保存'}。`;
  return { hookEventName: 'PostToolUse', additionalContext: context.join('\n') };
}

/** Native post hooks are exposure detection; they cannot undo provider-side consumption. */
export async function secretNativeHook(payload, options = {}) {
  if (
    typeof payload?.tool_name === 'string' &&
    !['bash', 'shell', 'exec_command', 'shell_command', 'run_command', 'run_terminal_cmd', 'execute_command'].includes(
      payload.tool_name.toLowerCase(),
    )
  )
    return null;
  if (!payload || (typeof payload.tool_name !== 'string' && payload.hook_event_name !== 'PostToolUse'))
    return denied('secret_hook_payload_invalid');
  if (payload?.hook_event_name !== 'PostToolUse') {
    const { nativeSecretDenial } = await import('./native-secret-policy.mjs');
    const reason = nativeSecretDenial(payload);
    return reason ? denied(reason) : null;
  }
  const original = payload.tool_response ?? payload.tool_result;
  if (original === undefined) return null;
  const { protectSecretToolResult } = await import('./lib/secret-tool-io.mjs');
  const result = await protectSecretToolResult(original, {
    callId: payload.tool_use_id ?? payload.tool_call_id,
    notify: options.notify ?? notify,
    environment: options.environment,
    knownCredentials: options.knownCredentials,
  });
  if (result === original) return null;
  return {
    hookSpecificOutput: postToolUseOutput(result),
  };
}

async function main() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 64 * 1024 * 1024) throw new Error('secret_hook_size_limit');
    }
    const output = await secretNativeHook(JSON.parse(raw));
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(denied('secret_hook_unavailable'))}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
