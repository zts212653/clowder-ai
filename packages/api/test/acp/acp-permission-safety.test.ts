import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpClient } from '../../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../src/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';
import type { AcpAgentRequest } from '../../src/domains/cats/services/agents/providers/acp/types.js';

const request: AcpAgentRequest = {
  jsonrpc: '2.0',
  id: 'permission',
  method: 'session/request_permission',
  params: {
    sessionId: 'session',
    options: [
      { optionId: 'allow', kind: 'allow_always', name: 'Allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  },
};
for (const Client of [AcpClient, AcpHttpStreamClient]) {
  test(`${Client.name} never automatically permits an unwired permission request`, async () => {
    const responses: unknown[] = [];
    const client = new Client({ command: 'test', args: [], cwd: process.cwd() });
    const seam = client as unknown as {
      permissions: { admitSession(sessionId: string): void };
      child: { stdin: { writable: boolean; write(value: string): void } };
      handleAgentRequest(req: AcpAgentRequest): Promise<void> | void;
      sendAgentResponse(response: unknown): Promise<void>;
    };
    seam.permissions.admitSession('session');
    seam.child = {
      stdin: {
        writable: true,
        write(value) {
          responses.push(JSON.parse(value));
        },
      },
    };
    seam.sendAgentResponse = async (response) => {
      responses.push(response);
    };
    await seam.handleAgentRequest(request);
    await new Promise((resolve) => setImmediate(resolve));
    const response = responses[0] as { result: { outcome: { outcome: string; optionId?: string } } };
    assert.equal(response.result.outcome.outcome, 'cancelled');
    assert.equal(response.result.outcome.optionId, undefined);
  });
}
