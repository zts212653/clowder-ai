// Kimi fails open for exit 1. All controlled pre-hook failures must use exit 2.
let raw = '';
try {
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 64 * 1024 * 1024) throw new Error('secret_hook_size_limit');
  }
  const payload = JSON.parse(raw);
  if (!payload || typeof payload.tool_name !== 'string') throw new Error('secret_hook_payload_invalid');
  const { secretNativeHook } = await import('./secret-native-hook.mjs');
  if (payload.hook_event_name === 'PostToolUse') {
    const result = await secretNativeHook({ ...payload, tool_response: payload.tool_output });
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const result = await secretNativeHook(payload);
    if (result?.hookSpecificOutput.permissionDecision === 'deny') {
      process.stderr.write(`${result.hookSpecificOutput.permissionDecisionReason}\n`);
      process.exitCode = 2;
    }
  }
} catch {
  process.stderr.write('secret_hook_blocked: credential inspection denied this operation or was unavailable.\n');
  process.exitCode = 2;
}
