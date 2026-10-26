import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { inspectOwnedProcessCredentials, projectProcessCensus } from './mcp-process-census.mjs';

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
