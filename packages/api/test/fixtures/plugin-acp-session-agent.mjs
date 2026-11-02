import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Protocol fixture, deliberately not a CodeAgent implementation or a model.
const sessions = new Map();
const responses = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const configuration = (sessionId) => ({
  sessionId,
  configOptions: [
    {
      id: 'model',
      category: 'model',
      currentValue: sessions.get(sessionId).model,
      options: [
        { value: 'model-a', name: 'Model A' },
        { value: 'model-b', name: 'Model B' },
      ],
    },
  ],
});
async function handle({ id, method, params = {}, result }) {
  if (!method) {
    responses.get(id)?.(result);
    responses.delete(id);
    return;
  }
  if (method === 'initialize')
    return reply(id, {
      protocolVersion: 1,
      agentInfo: { name: 'acp-fixture', version: '1' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
    });
  const sessionId = params.sessionId;
  if (method === 'session/new') {
    const next = randomUUID();
    sessions.set(next, { model: 'model-a', previous: '' });
    return reply(id, configuration(next));
  }
  if (method === 'session/load' || method === 'session/resume') {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { model: 'model-a', previous: '' });
    return reply(id, configuration(sessionId));
  }
  if (method === 'session/set_config_option') {
    sessions.get(sessionId).model = params.value;
    return reply(id, configuration(sessionId));
  }
  if (method === 'session/prompt') {
    const state = sessions.get(sessionId);
    const text = params.prompt
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    let permission = '';
    if (text.includes('#permission')) {
      const requestId = randomUUID();
      const response = new Promise((resolve) => responses.set(requestId, resolve));
      send({
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'permission', title: 'Fixture action' },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      permission = JSON.stringify(await response);
    }
    if (text.includes('#tool'))
      send({
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Fixture event', status: 'pending' },
        },
      });
    const answer = `previous=${state.previous}; current=${text}; model=${state.model}; permission=${permission}`;
    state.previous = text;
    send({
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } },
    });
    return reply(id, { stopReason: 'end_turn' });
  }
  if (id !== undefined) reply(id, {});
}
for await (const line of createInterface({ input: process.stdin })) {
  void handle(JSON.parse(line)).catch((error) => {
    send({ error: { code: -32603, message: error.message } });
  });
}
