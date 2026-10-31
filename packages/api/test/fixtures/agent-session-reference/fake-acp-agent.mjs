import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const history = new Map();
const pending = new Map();
const http = process.argv.indexOf('--http');
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
async function request(message) {
  const { method, id, params = {} } = message;
  const sessionId = params.sessionId;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: true, close: true },
          promptCapabilities: {},
        },
        agentInfo: { name: 'fixture', version: '1' },
      });
      break;
    case 'session/new': {
      const next = randomUUID();
      history.set(next, '');
      reply(id, { sessionId: next });
      break;
    }
    case 'session/load':
    case 'session/resume':
      if (!history.has(sessionId)) history.set(sessionId, '');
      reply(id, { sessionId });
      break;
    case 'session/prompt': {
      const text = params.prompt
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      if (text.includes('#tool'))
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read', status: 'pending' });
      const controller = new AbortController();
      pending.set(sessionId, { id, controller });
      const finish = async () => {
        let answer = `previous=${history.get(sessionId) ?? ''}; current=${text}`;
        if (http >= 0)
          answer = (
            await (
              await fetch(process.argv[http + 1], {
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, text }),
              })
            ).json()
          ).text;
        if (controller.signal.aborted) return;
        history.set(sessionId, text);
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } });
        reply(id, { stopReason: 'end_turn' });
        pending.delete(sessionId);
      };
      if (text.includes('#wait')) {
        pending.set(sessionId, { id, controller });
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting' } });
      } else await finish();
      break;
    }
    case 'session/cancel': {
      const turn = pending.get(sessionId);
      if (turn) {
        turn.controller.abort();
        reply(turn.id, { stopReason: 'cancelled' });
        pending.delete(sessionId);
      }
      if (id !== undefined) reply(id, {});
      break;
    }
    case 'session/close':
      reply(id, {});
      break;
    default:
      if (id !== undefined) reply(id, {});
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  void request(message).catch((error) => {
    if (error.name !== 'AbortError') send({ id: message.id, error: { code: -32603, message: error.message } });
  });
}
