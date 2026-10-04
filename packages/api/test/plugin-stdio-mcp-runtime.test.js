import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StdioMcpContributionRuntime } from '../dist/domains/plugin/manager/builtin-contribution-supervisor.js';
import { trackLongRequestTimers } from './helpers/track-long-request-timers.js';

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-mcp-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, 'entrypoint.cjs');
  await writeFile(
    entrypoint,
    `
const readline = require('node:readline');
const fs = require('node:fs');
const mode = process.argv[2];
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'initialize-exit') process.exit(17);
    if (mode === 'initialize-hang') {
      fs.writeFileSync(mode + '.started', '');
      return;
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' }
    }}));
  } else if (message.method === 'tools/list') {
    if (mode === 'list-exit') process.exit(17);
    if (mode === 'list-hang') {
      fs.writeFileSync(mode + '.started', '');
      return;
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      tools: [{ name: 'hang', inputSchema: { type: 'object' } }]
    }}));
  }
});
`,
  );
  return {
    pluginInstanceId: 'pi_test',
    pluginId: 'dev.clowder.test',
    contributionId: 'test-toolset',
    command: process.execPath,
    args: [entrypoint, mode],
    cwd: root,
    env: {},
  };
}

test('initialize child exit rejects as ConnectionClosed and retires the SDK timer', async (t) => {
  const assertNoPendingTimers = trackLongRequestTimers(t);
  const runtime = new StdioMcpContributionRuntime();
  await assert.rejects(runtime.start(await fixture(t, 'initialize-exit')), (error) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.ConnectionClosed);
    return true;
  });
  assertNoPendingTimers();
});

test('tools/list child exit rejects as ConnectionClosed and retires the SDK timer', async (t) => {
  const assertNoPendingTimers = trackLongRequestTimers(t);
  const runtime = new StdioMcpContributionRuntime();
  await assert.rejects(runtime.start(await fixture(t, 'list-exit')), (error) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.ConnectionClosed);
    return true;
  });
  assertNoPendingTimers();
});

for (const [mode, label] of [
  ['initialize-hang', 'connect'],
  ['list-hang', 'tools/list'],
]) {
  test(`${label} short startup timeout cancels the SDK request`, async (t) => {
    const assertNoPendingTimers = trackLongRequestTimers(t);
    const runtime = new StdioMcpContributionRuntime({ startTimeoutMs: 1_500 });
    const spec = await fixture(t, mode);
    await assert.rejects(runtime.start(spec), /timed out after 1500ms/);
    await access(join(spec.cwd, `${mode}.started`));
    assertNoPendingTimers();
  });
}

test('short tools/call timeout cancels the SDK request before close', async (t) => {
  const assertNoPendingTimers = trackLongRequestTimers(t);
  const runtime = new StdioMcpContributionRuntime({ callTimeoutMs: 20 });
  const handle = await runtime.start(await fixture(t, 'hang-call'));
  t.after(() => handle.close());
  await assert.rejects(handle.callTool('hang', {}), /timed out after 20ms/);
  assertNoPendingTimers();
  await handle.close();
  assertNoPendingTimers();
});
