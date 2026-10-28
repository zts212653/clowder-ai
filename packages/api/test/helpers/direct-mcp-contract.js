import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codexConfigObjectFromArgs } from '../../dist/domains/cats/services/agents/providers/codex-config-overrides.js';

/** External servers retain their exact transport; no resident wrapper exists. */
export function directMcpContract(server) {
  const env = Array.isArray(server.env)
    ? Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
    : (server.env ?? {});
  assert.equal(env.CAT_CAFE_SECRET_MCP_PROXY_SPEC, undefined);
  assert.ok(!(server.args ?? []).some((arg) => /secret-mcp-proxy/.test(arg)));
  return { launchEnv: env, upstream: { ...server, env } };
}

export function openCodeDirectMcpContract(server) {
  assert.equal(server.type, 'local');
  return directMcpContract({ command: server.command[0], args: server.command.slice(1), env: server.environment });
}

export function readNativeMcpConfig(value) {
  return JSON.parse(value.startsWith('{') ? value : readFileSync(value, 'utf8'));
}

/** A pooled MCP may refresh auth through its existing private credential file. */
export function assertCurrentCallback(env, expected) {
  const { CAT_CAFE_INVOCATION_ID: invocationId, CAT_CAFE_CALLBACK_TOKEN: callbackToken, ...metadata } = expected;
  if (env.CAT_CAFE_CREDENTIAL_FILE) {
    const { invocationId: actualInvocation, callbackToken: actualToken } = JSON.parse(
      readFileSync(env.CAT_CAFE_CREDENTIAL_FILE, 'utf8'),
    );
    assert.equal(actualInvocation, invocationId);
    assert.equal(actualToken, callbackToken);
    assert.equal(env.CAT_CAFE_INVOCATION_ID, undefined, 'a refreshable transport must not freeze the old invocation');
    assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined, 'a refreshable transport must not freeze the old token');
    assert.deepEqual(env, { ...metadata, CAT_CAFE_CREDENTIAL_FILE: env.CAT_CAFE_CREDENTIAL_FILE });
  } else assert.deepEqual(env, expected);
}

/** Inspect the real direct native configuration, including literal plugin IDs. */
export function upstreamMcpServersFromArgs(args) {
  const servers = codexConfigObjectFromArgs(args).mcp_servers ?? {};
  for (const server of Object.values(servers)) if (server.enabled !== false) directMcpContract(server);
  return servers;
}
