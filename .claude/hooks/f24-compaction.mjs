#!/usr/bin/env node
// Managed Claude compaction carrier (Node canonical, #1542 successor of #1456).
// No shell utilities, no persistent local state, no project writes.
// Credit: ported from #1456 (.claude/hooks/f24-compaction.mjs by @amazing-fish).
let productName = '';
async function main() {
  const invocationId = process.env.CAT_CAFE_INVOCATION_ID;
  const callbackToken = process.env.CAT_CAFE_CALLBACK_TOKEN;
  // Project settings also apply to ordinary Claude CLI sessions.
  if (!invocationId || !callbackToken) return;
  // Installed carrier dependencies are rooted at the trusted install, never cwd.
  const { deploymentDefaults } = await import('../../packages/api/dist/agent-hooks/deployment-defaults.js');
  productName = deploymentDefaults.brand.name;
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('hook_input_too_large');
  }
  const input = JSON.parse(raw);
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 500) {
    throw new Error('hook_session_id_invalid');
  }
  const port = process.env.API_SERVER_PORT ?? String(deploymentDefaults.apiPort);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('hook_api_port_invalid');
  const headers = {
    'X-Invocation-Id': invocationId,
    'X-Callback-Token': callbackToken,
    // #1542: typed carrier identity — the seal boundary counts at most one
    // logical observation per invocation by accepting only the identity the
    // launch plan actually handed to this spawn.
    'X-Clowder-Compaction-Carrier': 'f296-node-v1',
    'Content-Type': 'application/json',
  };
  const base = `http://127.0.0.1:${port}`;
  const phase = process.argv[2];
  let response;
  if (phase === 'pre') {
    response = await fetch(`${base}/api/sessions/seal`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        cliSessionId: input.session_id,
        reason: `claude-code-compact-${input.trigger === 'manual' ? 'manual' : 'auto'}`,
      }),
    });
  } else if (phase === 'post') {
    response = await fetch(`${base}/api/sessions/latest-digest?cliSessionId=${encodeURIComponent(input.session_id)}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } else {
    throw new Error('hook_phase_invalid');
  }
  if (!response.ok) throw new Error(`hook_http_${response.status}`);
  const result = await response.json();
  if (phase === 'pre') {
    if (result.contextEpoch?.status !== 'observed') throw new Error('hook_compaction_not_observed');
    console.log(JSON.stringify({ systemMessage: `${productName} recorded this invocation context compaction.` }));
  } else {
    if (result.postCompact?.status !== 'projected' || typeof result.postCompact.contextPacket !== 'string') {
      throw new Error('hook_cold_projection_unavailable');
    }
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `[F296 Trusted Cold Packet]\n${result.postCompact.contextPacket}`,
        },
      }),
    );
  }
}

main().catch((error) => {
  // Never print response bodies, callback credentials, or user payloads.
  const reason = /^hook_[a-z_0-9]+$/.test(error.message) ? error.message : 'hook_request_failed';
  console.error(`${productName ? `${productName} ` : ''}compaction hook: ${reason}`);
  process.exitCode = 1;
});
