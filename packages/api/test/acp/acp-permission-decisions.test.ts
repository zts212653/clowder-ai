import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { AcpClient } from '../../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../src/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';
import type {
  AcpPermissionDecision,
  AcpPermissionHandler,
} from '../../src/domains/cats/services/agents/providers/acp/acp-permission-dispatcher.js';
import type { AcpAgentRequest } from '../../src/domains/cats/services/agents/providers/acp/types.js';

const request: AcpAgentRequest = {
  jsonrpc: '2.0',
  id: 7,
  method: 'session/request_permission',
  params: {
    sessionId: 'session',
    options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  },
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
for (const Client of [AcpClient, AcpHttpStreamClient]) {
  const cases: Array<[string, AcpPermissionHandler, string, string?]> = [
    ['allow requires explicit valid decision', (_req, respond) => respond({ optionId: 'allow' }), 'selected', 'allow'],
    ['reject is preserved', (_req, respond) => respond({ optionId: 'reject' }), 'selected', 'reject'],
    ['unknown option cancels', (_req, respond) => respond({ optionId: 'invented' }), 'cancelled'],
    [
      'handler throw cancels',
      () => {
        throw new Error('secret must not be sent');
      },
      'cancelled',
    ],
    [
      'handler rejected promise cancels',
      async () => {
        throw new Error('secret');
      },
      'cancelled',
    ],
    ['handler timeout cancels', () => {}, 'cancelled'],
    ['explicit cancellation', (_req, respond) => respond({ cancelled: true }), 'cancelled'],
    [
      'async platform decision is awaited',
      async (_req, respond) => {
        await new Promise((resolve) => setImmediate(resolve));
        respond({ optionId: 'allow' });
      },
      'selected',
      'allow',
    ],
    [
      'second callback cannot change first decision',
      (_req, respond) => {
        respond({ optionId: 'reject' });
        respond({ optionId: 'allow' });
      },
      'selected',
      'reject',
    ],
  ];
  function setup(handler: AcpPermissionHandler) {
    const responses: Array<{ id: string | number; result?: { outcome: { outcome: string; optionId?: string } } }> = [];
    const client = new Client({
      command: 'test',
      args: [],
      cwd: process.cwd(),
      permissionHandler: handler,
      permissionTimeoutMs: 10,
    });
    const events = new EventEmitter();
    const child = {
      killed: false,
      stdin: {
        writable: true,
        write(value: string) {
          responses.push(JSON.parse(value));
        },
      },
      once: events.once.bind(events),
      kill() {
        child.killed = true;
        events.emit('exit');
      },
    };
    const seam = client as unknown as {
      permissions: { admitSession(sessionId: string): void };
      child: typeof child;
      handleAgentRequest(req: AcpAgentRequest): void | Promise<void>;
      sendAgentResponse(value: (typeof responses)[number]): Promise<void>;
    };
    seam.permissions.admitSession('session');
    seam.child = child;
    seam.sendAgentResponse = async (value) => {
      responses.push(value);
    };
    return { client, seam, responses };
  }
  for (const [name, handler, outcome, optionId] of cases)
    test(`${Client.name}: ${name}`, async () => {
      const { client, seam, responses } = setup(handler);
      await seam.handleAgentRequest(request);
      await pause();
      assert.equal(responses.length, 1);
      assert.equal(responses[0].id, 7);
      assert.equal(responses[0].result?.outcome.outcome, outcome);
      assert.equal(responses[0].result?.outcome.optionId, optionId);
      await client.close();
    });
  for (const action of ['cancel', 'close'] as const)
    test(`${Client.name}: ${action} retires pending authority and ignores late approval`, async () => {
      let respond: ((decision: AcpPermissionDecision) => void) | undefined;
      const { client, seam, responses } = setup((_req, reply) => {
        respond = reply;
      });
      const pending = seam.handleAgentRequest(request);
      if (action === 'close') await client.close();
      else client.cancelSession('session');
      respond?.({ optionId: 'allow' });
      await pending;
      await pause();
      const permissions = responses.filter((r) => r.id === request.id);
      assert.equal(permissions.length, action === 'close' ? 0 : 1);
      assert.equal(permissions[0]?.result?.outcome.outcome, action === 'close' ? undefined : 'cancelled');
      await client.close();
    });
  test(`${Client.name}: duplicate option IDs and missing session cannot acquire authority`, async () => {
    let called = false;
    const { client, seam, responses } = setup((_req, reply) => {
      called = true;
      reply({ optionId: 'allow' });
    });
    await seam.handleAgentRequest({ ...request, params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    await pause();
    assert.equal(called, false);
    assert.equal(responses[0].result?.outcome.outcome, 'cancelled');
    await client.close();
  });
  test(`${Client.name}: malformed JSON schema cannot throw or acquire authority`, async () => {
    let called = false;
    const { client, seam, responses } = setup((_req, reply) => {
      called = true;
      reply({ optionId: 'allow' });
    });
    await seam.handleAgentRequest({
      ...request,
      params: { sessionId: 'session', options: [{ optionId: 'allow', kind: { toString: null } }] },
    });
    await pause();
    assert.equal(called, false);
    assert.equal(responses[0].result?.outcome.outcome, 'cancelled');
    await client.close();
  });
  test(`${Client.name}: asynchronous primitive callback cancels safely`, async () => {
    const { client, seam, responses } = setup(async (_req, reply) => {
      await new Promise((resolve) => setImmediate(resolve));
      (reply as unknown as (value: unknown) => void)('allow');
    });
    await seam.handleAgentRequest(request);
    await pause();
    assert.equal(responses[0].result?.outcome.outcome, 'cancelled');
    await client.close();
  });
}
