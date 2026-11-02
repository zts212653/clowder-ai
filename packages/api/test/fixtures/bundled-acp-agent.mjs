// Explicit protocol fixture. It never reads credentials or calls a model/network.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const write = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const permissions = new Map();
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    permissions.get(request.id)?.(request.result);
    permissions.delete(request.id);
    return;
  }
  const { id, method, params = {} } = request;
  if (method === 'initialize')
    write({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'bundled-acp-fixture', version: '1' },
        agentCapabilities: { loadSession: true },
      },
    });
  else if (method === 'session/new' || method === 'session/load')
    write({
      id,
      result: {
        sessionId: params.sessionId ?? randomUUID(),
        models: {
          currentModelId: 'fixture-model',
          availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }],
        },
      },
    });
  else if (method === 'session/prompt') {
    const permissionId = `permission-${id}`;
    const decision = new Promise((resolve) => permissions.set(permissionId, resolve));
    write({
      id: permissionId,
      method: 'session/request_permission',
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'fixture-tool', title: 'Fixture permission' },
        options: [
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
        ],
      },
    });
    const response = await decision;
    const text = `fixture:${params.sessionId}:${params.prompt.map((block) => block.text ?? '').join('')}:permission=${response.outcome.optionId}`;
    write({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
    write({ id, result: { stopReason: 'end_turn' } });
  } else if (id !== undefined) write({ id, result: {} });
});
