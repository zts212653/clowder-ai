// Kimi fails open for exit 1. All controlled pre-hook failures must use exit 2.
let raw = '';
try {
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 64 * 1024 * 1024) throw new Error('secret_hook_size_limit');
  }
  const payload = JSON.parse(raw);
  if (!payload || typeof payload.tool_name !== 'string') throw new Error('secret_hook_payload_invalid');
  if (payload.hook_event_name === 'PostToolUse') {
    const { secretNativeHook } = await import('./secret-native-hook.mjs');
    const result = await secretNativeHook({ ...payload, tool_response: payload.tool_output });
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const { nativeSecretDenial } = await import('./native-secret-policy.mjs');
    const reason = nativeSecretDenial(payload);
    if (reason) throw new Error(reason);
  }
} catch {
  process.stderr.write('secret_hook_blocked: credential inspection denied this operation or was unavailable.\n');
  process.exitCode = 2;
}
