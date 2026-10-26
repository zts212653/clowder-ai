#!/usr/bin/env node
// Managed Claude compaction carrier (Node canonical, #1542 successor of #1456).
// Legacy shell hooks use the same bounded callback operations and file owner.
// Credit: ported from #1456 (.claude/hooks/f24-compaction.mjs by @amazing-fish).
import { readFileSync, statSync } from 'node:fs';

function originalCredentials() {
  const {
    CAT_CAFE_INVOCATION_ID: id,
    CAT_CAFE_CALLBACK_TOKEN: legacySecret,
    CAT_CAFE_CREDENTIAL_FILE: file,
  } = process.env;
  if (!file) return [id, legacySecret];
  try {
    if (statSync(file).size > 16384) throw new Error('invalid');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const { invocationId, callbackToken: secret } = value;
    if (!id || invocationId !== id || typeof secret !== 'string' || !secret.trim()) throw new Error('invalid');
    return [id, secret];
  } catch {
    // Configured original-turn files cannot fall back to stale ambient auth.
    throw new Error('hook_credentials_unavailable');
  }
}

function callbackOrigin(defaultPort) {
  const port = process.env.API_SERVER_PORT ?? String(defaultPort);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('hook_api_port_invalid');
  const origin = new URL(process.env.CAT_CAFE_API_URL ?? `http://127.0.0.1:${port}`);
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('hook_api_origin_invalid');
  return origin;
}

function callbackOperation(phase, input) {
  let requestPath;
  let method = 'GET';
  let body;
  if (phase === 'pre' || phase === 'legacy-pre') {
    requestPath = '/api/sessions/seal';
    method = 'POST';
    body = JSON.stringify({
      cliSessionId: input.session_id,
      reason: `claude-code-compact-${input.trigger === 'manual' ? 'manual' : 'auto'}`,
    });
  } else if (phase === 'post' || phase === 'legacy-digest') {
    requestPath = `/api/sessions/latest-digest?cliSessionId=${encodeURIComponent(input.session_id)}`;
  } else if (phase === 'sop-get') {
    requestPath = `/api/sessions/sop-bookmark?cliSessionId=${encodeURIComponent(input.session_id)}`;
  } else if (phase === 'sop-set') {
    if (
      typeof input.skill !== 'string' ||
      input.skill.length > 200 ||
      typeof input.sopStage !== 'string' ||
      input.sopStage.length > 200
    )
      throw new Error('hook_bookmark_invalid');
    requestPath = '/api/sessions/sop-bookmark';
    method = 'POST';
    body = JSON.stringify({ cliSessionId: input.session_id, skill: input.skill, sopStage: input.sopStage });
  } else {
    throw new Error('hook_phase_invalid');
  }
  return { requestPath, method, body };
}

let productName = '';
function managedOutput(phase, result) {
  if (phase === 'pre') {
    if (result.contextEpoch?.status !== 'observed') throw new Error('hook_compaction_not_observed');
    return { systemMessage: `${productName} recorded this invocation context compaction.` };
  }
  if (result.postCompact?.status !== 'projected' || typeof result.postCompact.contextPacket !== 'string')
    throw new Error('hook_cold_projection_unavailable');
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[F296 Trusted Cold Packet]\n${result.postCompact.contextPacket}`,
    },
  };
}

async function main() {
  const phase = process.argv[2];
  const managed = phase === 'pre' || phase === 'post';
  const [invocationId, secret] = originalCredentials();
  if (!invocationId || !secret) {
    if (managed) return; // Ordinary unmanaged CLI sessions have no callback.
    throw new Error('hook_credentials_unavailable');
  }
  // Installed dependencies resolve from the trusted install, never cwd.
  const { deploymentDefaults } = await import('../../packages/api/dist/agent-hooks/deployment-defaults.js');
  productName = deploymentDefaults.brand.name;
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('hook_input_too_large');
  }
  const input = JSON.parse(raw);
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 500)
    throw new Error('hook_session_id_invalid');
  const headers = Object.fromEntries([
    ['X-Invocation-Id', invocationId],
    ['X-Callback-Token', secret],
    ['Content-Type', 'application/json'],
    // Only the launch-plan managed actions attest this canonical carrier.
    ...(managed ? [['X-Clowder-Compaction-Carrier', 'f296-node-v1']] : []),
  ]);
  const { requestPath, method, body } = callbackOperation(phase, input);
  const response = await fetch(new URL(requestPath, callbackOrigin(deploymentDefaults.apiPort)), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (phase === 'legacy-pre') console.log(String(response.status));
  if (!response.ok) throw new Error(`hook_http_${response.status}`);
  if (phase === 'legacy-pre') {
    await response.body?.cancel();
    return;
  }
  const result = await response.json();
  console.log(JSON.stringify(managed ? managedOutput(phase, result) : result));
}

main().catch((error) => {
  // Never print response bodies, credentials, or user payloads on failure.
  const reason = /^hook_[a-z_0-9]+$/.test(error.message) ? error.message : 'hook_request_failed';
  console.error(`${productName ? `${productName} ` : ''}compaction hook: ${reason}`);
  process.exitCode = 1;
});
