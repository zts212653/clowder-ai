import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexConfigObjectFromArgs,
  codexMcpConfigArgs,
} from '../dist/domains/cats/services/agents/providers/codex-config-overrides.js';

const server = 'plugin__dev.clowder.xiangqi__xiangqi-analysis';

function assignments(...values) {
  return values.flatMap((value) => ['--config', value]);
}

test('quoted plugin MCP identities survive as literal keys alongside existing servers', () => {
  const input = assignments(
    'mcp_servers.cat-cafe.command="echo"',
    'mcp_servers.cat-cafe.enabled=false',
    `mcp_servers."${server}".command="node"`,
    `mcp_servers."${server}".args=["/fixture/server.mjs","line\\nquote\\""]`,
    `mcp_servers."${server}".enabled=true`,
    'features.shell_tool=false',
  );
  const output = codexMcpConfigArgs(input);
  const config = codexConfigObjectFromArgs(output);
  assert.deepEqual(config.mcp_servers['cat-cafe'], { command: 'echo', enabled: false });
  assert.match(config.mcp_servers[server].args[0], /secret-mcp-proxy\.js$/);
  assert.deepEqual(JSON.parse(config.mcp_servers[server].env.CAT_CAFE_SECRET_MCP_PROXY_SPEC), {
    command: 'node',
    args: ['/fixture/server.mjs', 'line\nquote"'],
    env: {},
    source: server,
  });
  assert.equal(config.mcp_servers[server].enabled, true);
  assert.equal(config.features.shell_tool, false);
  assert.equal(output.filter((argument) => argument.startsWith('mcp_servers=')).length, 1);
  assert.equal(
    output.some((argument) => argument.startsWith('mcp_servers.')),
    false,
  );
});

test('native root reset removes ambient servers without removing the admitted server', () => {
  const config = codexConfigObjectFromArgs(
    codexMcpConfigArgs(
      assignments(
        'mcp_servers.ambient.command="ambient"',
        'mcp_servers={}',
        `mcp_servers."${server}".command="node"`,
        `mcp_servers."${server}".enabled=true`,
        'apps._default.enabled=false',
      ),
    ),
  );
  assert.deepEqual(Object.keys(config.mcp_servers), [server]);
  assert.equal(config.apps._default.enabled, false);
});

test('a later explicit root reset remains authoritative', () => {
  const output = codexMcpConfigArgs(assignments(`mcp_servers."${server}".command="node"`, 'mcp_servers={}'));
  assert.deepEqual(codexConfigObjectFromArgs(output).mcp_servers, {});
});

test('HTTP transport, bearer environment reference and quoted identities retain their values', () => {
  const literalName = 'remote.with.dots';
  const output = codexMcpConfigArgs(
    assignments(
      `mcp_servers."${literalName}".url="https://example.invalid/mcp"`,
      `mcp_servers."${literalName}".bearer_token_env_var="MCP_FIXTURE_BEARER"`,
      `mcp_servers."${literalName}".enabled=false`,
      'mcp_servers.remote__with__dots.command="echo"',
    ),
  );
  const servers = codexConfigObjectFromArgs(output).mcp_servers;
  assert.deepEqual(servers[literalName], {
    url: 'https://example.invalid/mcp',
    bearer_token_env_var: 'MCP_FIXTURE_BEARER',
    enabled: false,
  });
  assert.equal(JSON.parse(servers.remote__with__dots.env.CAT_CAFE_SECRET_MCP_PROXY_SPEC).command, 'echo');
});

test('bare-only generated overrides keep their existing precedence and form', () => {
  const args = assignments('mcp_servers.cat-cafe.command="node"', 'mcp_servers.cat-cafe.enabled=false');
  assert.deepEqual(codexMcpConfigArgs(args), args);
});

test('malformed MCP table values fail closed', () => {
  assert.throws(
    () => codexMcpConfigArgs(assignments(`mcp_servers."${server}".enabled=true`, 'mcp_servers="invalid"')),
    /codex_mcp_config_invalid/,
  );
});
