/** Explicit installed-CLI contract probe; no account, network, server launch or model invocation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexMcpConfigArgs } from '../packages/api/dist/domains/cats/services/agents/providers/codex-config-overrides.js';

const cli = process.argv[2] || 'codex';
const home = mkdtempSync(join(tmpdir(), 'codex-mcp-cli-contract-'));
mkdirSync(join(home, '.codex'), { mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), NO_COLOR: '1' };
const name = 'plugin__dev.clowder.xiangqi__xiangqi-analysis';
const plugin = [
  `mcp_servers."${name}".command="echo"`,
  `mcp_servers."${name}".args=["fixture"]`,
  `mcp_servers."${name}".enabled=false`,
];
try {
  const version = spawnSync(cli, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(version.status, 0, version.stderr || version.error?.message);
  for (const [mode, values, expectedNames] of [
    [
      'owner',
      ['mcp_servers.cat-cafe.command="echo"', 'mcp_servers.cat-cafe.enabled=false', ...plugin],
      ['cat-cafe', name],
    ],
    ['native', ['mcp_servers={}', ...plugin], [name]],
  ]) {
    const args = codexMcpConfigArgs(values.flatMap((value) => ['--config', value]));
    const result = spawnSync(cli, [...args, 'mcp', 'list', '--json'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const servers = JSON.parse(result.stdout);
    assert.deepEqual(servers.map((server) => server.name).sort(), [...expectedNames].sort());
    assert.equal(servers.find((server) => server.name === name).enabled, false);
    console.log(
      JSON.stringify({ mode, cliVersion: version.stdout.trim(), exitCode: result.status, names: expectedNames }),
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
