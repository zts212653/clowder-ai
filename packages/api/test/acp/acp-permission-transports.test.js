import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';

const options = [
  { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'no', kind: 'reject_once', name: 'Reject' },
];
const request = (sessionId = 'session-a', choices = options) => ({
  jsonrpc: '2.0',
  id: `permission-${sessionId}`,
  method: 'session/request_permission',
  params: { sessionId, options: choices, toolCall: { toolCallId: 'call', title: 'Write a file' } },
});

// Exercise the real wire handlers without launching a process or HTTP listener.
function wire(Client, config = {}) {
  const client = new Client({
    command: 'unused',
    args: [],
    cwd: process.cwd(),
    defaultPermissionDecision: 'allow',
    ...config,
  });
  const replies = [];
  if (Client === AcpClient) client.child = { stdin: { write: (line) => replies.push(JSON.parse(line)) } };
  else
    client.sendAgentResponse = async (value) => {
      replies.push(value);
    };
  return {
    client,
    replies,
    async send(input = request()) {
      await client.handleAgentRequest(input);
      await new Promise(setImmediate);
      return replies.at(-1);
    },
  };
}

for (const Client of [AcpClient, AcpHttpStreamClient]) {
  test(`${Client.name}: no configured permission policy rejects the offered operation`, async () => {
    const f = wire(Client, { defaultPermissionDecision: undefined });
    assert.deepEqual((await f.send()).result, { outcome: { outcome: 'selected', optionId: 'no' } });
  });
  test(`${Client.name}: explicit reject selects the offered reject option`, async () => {
    const f = wire(Client, { defaultPermissionDecision: 'reject' });
    assert.deepEqual((await f.send()).result, { outcome: { outcome: 'selected', optionId: 'no' } });
  });
  test(`${Client.name}: explicit reject never falls through to allow`, async () => {
    const f = wire(Client, { defaultPermissionDecision: 'reject' });
    assert.deepEqual((await f.send(request('session-a', [options[0]]))).result, { outcome: { outcome: 'cancelled' } });
  });
  test(`${Client.name}: auto selects offered allow and cancels when none is offered`, async () => {
    const f = wire(Client);
    assert.equal((await f.send()).result.outcome.optionId, 'yes');
    assert.deepEqual((await f.send(request('session-b', [options[1]]))).result, { outcome: { outcome: 'cancelled' } });
  });
  test(`${Client.name}: a session decision is isolated and revocable`, async () => {
    const f = wire(Client);
    f.client.setSessionPermissionHandler('session-a', async (_req, respond) => respond({ optionId: 'no' }));
    assert.equal((await f.send()).result.outcome.optionId, 'no');
    assert.equal((await f.send(request('session-b'))).result.outcome.optionId, 'yes');
    f.client.setSessionPermissionHandler('session-a');
    assert.equal((await f.send()).result.outcome.optionId, 'yes');
  });
  test(`${Client.name}: cancellation and duplicate user replies never approve twice`, async () => {
    const f = wire(Client, {
      permissionHandler: async (_req, respond) => {
        respond({ cancelled: true });
        respond({ optionId: 'yes' });
      },
    });
    assert.deepEqual((await f.send()).result, { outcome: { outcome: 'cancelled' } });
    assert.equal(f.replies.length, 1);
  });
  test(`${Client.name}: async handler failure returns a protocol error`, async () => {
    const f = wire(Client, {
      permissionHandler: async () => {
        throw new Error('confirmation unavailable');
      },
    });
    assert.equal((await f.send()).error?.code, -32603);
    assert.equal(f.replies.length, 1);
  });
}
