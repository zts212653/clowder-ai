import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspectOwnedProcessCredentials, projectProcessCensus } from './mcp-process-census.mjs';

test('labels the verified F193 inline SDK probe without archiving its source or treating arbitrary eval as retired', () => {
  const code = readFileSync(
    new URL('../packages/api/test/fixtures/f193-retired-probe-source.txt', import.meta.url),
    'utf8',
  );
  // Test input only: verify this exact fixture transformation against the
  // immutable published bytes; production recognizes complete hashes only.
  const publicCode = code.replace(
    /process\.chdir\("[^"\n]+"\);$/u,
    'process.chdir("/home/user/cat-cafe/packages/api");',
  );
  assert.equal(
    createHash('sha256').update(publicCode).digest('hex'),
    '8ba14ed1c7bb943df1757fbb4bf6dc4dbddfe3cbbafb60dec691017c7c9d409d',
  );
  const thirdCwd = publicCode.replace('/home/user/cat-cafe/packages/api', '/opt/unrecognized-probe-api');
  const row = (pid, source) => ({
    pid,
    ppid: 1,
    rssKiB: 10,
    cpuPercent: 0,
    elapsed: '00:10',
    command: `node --input-type=module --eval ${source}`,
  });
  const census = projectProcessCensus([
    row(2, code),
    row(3, `${code} // user customization`),
    row(4, publicCode),
    row(5, thirdCwd),
  ]);
  assert.equal(census.processes[0].family, 'f193-retired-probe');
  assert.notEqual(census.processes[1].family, 'f193-retired-probe');
  assert.equal(census.processes[2].family, 'f193-retired-probe');
  assert.notEqual(census.processes[3].family, 'f193-retired-probe');
  assert.ok(!JSON.stringify(census).includes(code));
});

test('attributes hashed managed packages by metadata and separates API descendants from independent clients', () => {
  const root = '/work/.cat-cafe/plugins/resources/opaque-plugin/opaque-package/mcp-package-v3';
  const row = (pid, ppid, command) => ({ pid, ppid, command, rssKiB: 90, cpuPercent: 0, elapsed: '00:10' });
  const census = projectProcessCensus(
    [
      row(10, 1, 'node /work/packages/api/dist/index.js'),
      row(11, 10, '/opt/bin/claude'),
      row(12, 11, `node ${root}/dist/work-mcp-entrypoint.js --token private-value`),
      row(13, 1, `node ${root}/dist/work-mcp-entrypoint.js`),
      row(14, 10, 'node /tools/pinchtab/dist/index.js'),
      row(15, 10, 'node /unknown/mcp-package-v3/dist/mcp-entrypoint.js'),
    ],
    { apiPids: [10], managedPackages: [{ root, pluginId: 'collective-connector', packageDigest: 'sha256:known' }] },
  );
  const plugin = census.processes.find((p) => p.pid === 12);
  assert.equal(plugin.category, 'plugin_mcp');
  assert.equal(plugin.pluginId, 'collective-connector');
  assert.equal(plugin.family, 'dist/work-mcp-entrypoint.js');
  assert.equal(plugin.scope, 'api_tree');
  assert.equal(census.processes.find((p) => p.pid === 13).scope, 'outside_api_tree');
  assert.equal(census.processes.find((p) => p.pid === 14).family, 'pinchtab');
  assert.equal(census.processes.find((p) => p.pid === 15).category, 'unverified_plugin_mcp');
  assert.equal(census.groups.filter((g) => g.category === 'plugin_mcp').length, 2);
  assert.ok(!JSON.stringify(census).includes('private-value'));
  assert.ok(!JSON.stringify(census).includes('opaque-plugin'), 'hash directories never become plugin IDs');
});

test('accounts for protection proxies separately and preserves carrier ancestry without archiving argv', () => {
  const census = projectProcessCensus([
    { pid: 10, ppid: 1, rssKiB: 100, cpuPercent: 1, elapsed: '01:00', command: '/opt/bin/codex app-server' },
    {
      pid: 11,
      ppid: 10,
      rssKiB: 80,
      cpuPercent: 0,
      elapsed: '00:50',
      command: 'node /work/runtime/packages/mcp-server/dist/secret-mcp-proxy.js --token fixture-private-value',
    },
    {
      pid: 12,
      ppid: 11,
      rssKiB: 90,
      cpuPercent: 0,
      elapsed: '00:50',
      command: 'node /work/runtime/packages/mcp-server/dist/memory.js',
    },
    {
      pid: 13,
      ppid: 1,
      rssKiB: 150,
      cpuPercent: 0,
      elapsed: '02:00',
      command: 'node /vendor/unknown-server.js --password fixture-private-value',
    },
    {
      pid: 14,
      ppid: 1,
      rssKiB: 200,
      cpuPercent: 0,
      elapsed: '02:00',
      command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=1234',
    },
  ]);
  assert.equal(census.processes.find((p) => p.pid === 11).category, 'protection_proxy');
  assert.equal(census.processes.find((p) => p.pid === 11).carrier, 'codex');
  assert.equal(census.processes.find((p) => p.pid === 12).family, 'memory');
  assert.equal(census.processes.find((p) => p.pid === 13).category, 'unknown_node');
  assert.equal(census.totals.rssKiB, 620);
  assert.equal(census.totals.count, 5);
  assert.equal(
    census.groups.reduce((n, group) => n + group.count, 0),
    5,
  );
  assert.ok(!JSON.stringify(census).includes('fixture-private-value'));
  assert.ok(!JSON.stringify(census).includes('command'));
  assert.equal(census.processes.find((p) => p.pid === 14).category, 'browser');
  assert.equal(census.processes.find((p) => p.pid === 12).activity, 'unobserved');
});

test('browser helpers and unrelated processes are mutually exclusive', () => {
  const census = projectProcessCensus([
    { pid: 1, ppid: 0, rssKiB: 10, cpuPercent: 0, elapsed: '00:01', command: '/usr/sbin/launchd' },
    {
      pid: 2,
      ppid: 1,
      rssKiB: 20,
      cpuPercent: 0,
      elapsed: '00:01',
      command: 'node /vendor/playwright/cli.js run-driver',
    },
    {
      pid: 3,
      ppid: 2,
      rssKiB: 30,
      cpuPercent: 0,
      elapsed: '00:01',
      command: '/vendor/chrome-headless-shell --type=renderer',
    },
  ]);
  assert.deepEqual(
    census.processes.map((p) => p.category),
    ['other', 'external_mcp', 'browser'],
  );
  assert.equal(census.totals.rssKiB, 60);
});

test('existing shared Cloud Pro and dot entrypoints remain first-party MCP resources', () => {
  const census = projectProcessCensus(
    ['remote-spike', 'dot-remote-proxy'].map((entry, index) => ({
      pid: index + 1,
      ppid: 0,
      rssKiB: 100,
      cpuPercent: 0,
      elapsed: '00:05',
      command: `node /work/runtime/packages/mcp-server/dist/${entry}.js`,
    })),
  );
  assert.deepEqual(
    census.processes.map((process) => process.category),
    ['self_mcp', 'self_mcp'],
  );
  assert.deepEqual(
    census.processes.map((process) => process.family),
    ['remote-spike', 'dot-remote-proxy'],
  );
  assert.equal(
    census.groups.reduce((sum, group) => sum + group.count, 0),
    2,
  );
});

test(
  'native observation detects an owned environment leak without returning the value',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = 'fixture-private-observation-56382840';
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");process.stdin.resume()'], {
      env: { ...process.env, F333_TEST_AUTH: fixture },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    try {
      await once(child.stdout, 'data');
      const scan = inspectOwnedProcessCredentials(process.pid, new Set([fixture]));
      assert.equal(scan.complete, true);
      assert.equal(scan.credentialValueDetected, true, 'the negative control must detect actual environment values');
      assert.ok(!JSON.stringify(scan).includes(fixture));
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  },
);
