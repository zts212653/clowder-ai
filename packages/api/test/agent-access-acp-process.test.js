import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { launchAcpChild } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { createNativeAcpRequests } from '../dist/domains/plugin/agent-access/acp-native-requests.js';
import { createAcpWriteApprovalPort } from '../dist/domains/plugin/agent-access/acp-write-approval.js';

test('ACP pipe failures reject the delegated write without an unhandled stream error', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      write(_chunk, _encoding, finish) {
        finish(Object.assign(new Error('fixture ACP writer closed'), { code: 'EPIPE' }));
      },
    }),
  });
  const connection = launchAcpChild(
    {
      command: 'fixture-acp',
      cwd: tmpdir(),
      args: [],
      spawnFn: () => child,
    },
    () => {},
  );
  await assert.rejects(connection.writeLine('{}\n'), { code: 'EPIPE' });
  await immediate();
  await assert.rejects(connection.writeLine('{}\n'), { code: 'EPIPE' });
});

test('ACP writes consume only the approved session, prompt reference and permission scope', async () => {
  const writes = [];
  const gate = createAcpWriteApprovalPort(async (line) => writes.push(JSON.parse(line)));
  const send = (params) =>
    gate.writeApprovedLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fixture',
        method: 'session/prompt',
        params,
      }),
    );
  gate.approve({
    method: 'session/prompt',
    params: { sessionId: 'approved' },
    prompt: { ref: 'opaque-prompt', content: [{ type: 'text', text: 'approved fixture prompt' }] },
  });
  const valid = { sessionId: 'approved', prompt: [{ type: 'text', text: 'opaque-prompt' }] };
  await assert.rejects(send({ ...valid, sessionId: 'other' }), /acp_worker_write_unapproved/);
  await assert.rejects(send({ ...valid, prompt: [{ type: 'text', text: 'other' }] }), /acp_worker_write_unapproved/);
  await send(valid);
  await assert.rejects(send(valid), /acp_worker_write_unapproved/);
  await assert.rejects(gate.writeApprovedLine(JSON.stringify({ jsonrpc: '2.0', id: 'fixture', result: {} })));
  assert.deepEqual(writes[0].params, {
    sessionId: 'approved',
    prompt: [{ type: 'text', text: 'approved fixture prompt' }],
  });
  assert.equal(writes.length, 1);
});

test('ACP expands only distinct MCP references in approved order', async () => {
  const writes = [];
  const gate = createAcpWriteApprovalPort(async (line) => writes.push(JSON.parse(line)));
  const cwd = tmpdir();
  const first = { name: 'first', command: 'fixture-first', args: [], env: [] };
  const second = { name: 'second', command: 'fixture-second', args: [], env: [] };
  gate.approve({
    method: 'session/new',
    params: { cwd },
    mcp: new Map([
      ['ref-one', first],
      ['ref-two', second],
    ]),
  });
  const send = (...names) =>
    gate.writeApprovedLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fixture',
        method: 'session/new',
        params: { cwd, mcpServers: names.map((name) => ({ name })) },
      }),
    );
  await assert.rejects(send('ref-one', 'ref-one'), /acp_worker_write_unapproved/);
  await assert.rejects(send('ref-two', 'ref-one'), /acp_worker_write_unapproved/);
  await send('ref-two');
  assert.deepEqual(
    writes.map(({ params }) => params.mcpServers),
    [[second]],
  );
});

test('native ACP permissions retain the Host session scope and never block another response', async () => {
  const actions = new AsyncLocalStorage();
  const expected = Promise.withResolvers();
  const replies = [];
  const failures = [];
  const router = createNativeAcpRequests({
    defaultDecision: 'reject',
    knownCredentials: [],
    async write(line) {
      replies.push(JSON.parse(line));
    },
    onWriteError(error) {
      failures.push(error);
    },
  });
  actions.run('role-one-authority', () =>
    router.setSessionPermissionHandler('one', async (request, respond) => {
      assert.equal(actions.getStore(), 'role-one-authority');
      assert.equal(request.id, 0);
      await expected.promise;
      respond({ optionId: 'allowed' });
    }),
  );
  const input = [
    { method: 'session/request_permission', id: 0, params: { sessionId: 'one' } },
    { id: 'unrelated', result: { native: true } },
    { method: 'session/request_permission', params: { sessionId: 'two' } },
    { method: 'fs/read_text_file', id: 2, params: {} },
  ].map((value) => JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const observed = [];
  for await (const frame of router.project(Readable.from(input))) observed.push(JSON.parse(frame.line));
  await immediate();
  assert.deepEqual(
    observed.map(({ id, params }) => id ?? params.update.sessionUpdate),
    ['unrelated', 'permission_pending'],
  );
  assert.ok(replies.some(({ id, error }) => id === 2 && error.code === -32601));
  assert.ok(
    replies.some(({ id, result }) => String(id).startsWith('synth-perm-') && result.outcome.outcome === 'cancelled'),
  );
  assert.equal(
    replies.some(({ id }) => id === 0),
    false,
  );
  expected.resolve();
  await immediate();
  assert.deepEqual(replies.find(({ id }) => id === 0).result.outcome, { outcome: 'selected', optionId: 'allowed' });
  assert.deepEqual(failures, []);
});
