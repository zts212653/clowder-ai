import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secretMcpProxyPath } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { codexConfigObjectFromArgs } from '../../dist/domains/cats/services/agents/providers/codex-config-overrides.js';

/** Check the real launch envelope before inspecting the original transport contract. */
export function secretMcpContract(server) {
  assert.equal(server.command, process.execPath, 'the inspected relay must use the host Node executable');
  assert.deepEqual(server.args, [secretMcpProxyPath()], 'the relay must belong to the installed MCP package');
  const env = Array.isArray(server.env)
    ? Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
    : server.env;
  assert.equal(typeof env?.CAT_CAFE_SECRET_MCP_PROXY_SPEC, 'string', 'relay must have an upstream specification');
  const spec = JSON.parse(env.CAT_CAFE_SECRET_MCP_PROXY_SPEC);
  assert.ok(spec.command || spec.url, 'upstream must retain a complete transport');
  assert.equal(spec.env?.CAT_CAFE_SECRET_MCP_PROXY_SPEC, undefined, 'do not recursively inject the relay spec');
  const { CAT_CAFE_SECRET_MCP_PROXY_SPEC: _spec, ...proxyEnv } = env;
  return { proxyEnv, upstream: spec };
}

/** OpenCode uses a command vector and calls its environment field `environment`. */
export function openCodeSecretMcpContract(server) {
  assert.equal(server.type, 'local');
  return secretMcpContract({ command: server.command[0], args: server.command.slice(1), env: server.environment });
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

/** Parse both dotted and root-value TOML, including literal plugin IDs with dots. */
export function upstreamMcpServersFromArgs(args) {
  const servers = codexConfigObjectFromArgs(args).mcp_servers ?? {};
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.enabled === false) return [name, server];
      const { upstream } = secretMcpContract(server);
      assert.equal(upstream.source, name, 'relay source must preserve server identity');
      return [
        name,
        {
          enabled: server.enabled,
          default_tools_approval_mode: server.default_tools_approval_mode,
          command: upstream.command,
          args: upstream.args,
          cwd: upstream.cwd,
          env: upstream.env,
          url: upstream.url,
          bearer_token_env_var: upstream.bearerTokenEnvVar,
        },
      ];
    }),
  );
}
