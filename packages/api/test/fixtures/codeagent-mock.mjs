// Deterministic ACP contract fixture. This is not an enterprise CodeAgent implementation.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.argv[process.argv.indexOf('--state-dir') + 1];
if (!process.argv.includes('--state-dir') || !root) throw new Error('--state-dir is required');
mkdirSync(root, { recursive: true });
const sessions = new Map();
const active = new Map();
const permissions = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const statePath = (id) => join(root, `${id}.json`);

function finish(sessionId, requestId, text, stopReason = 'end_turn') {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  reply(requestId, { stopReason });
  active.delete(sessionId);
}

function handle(message) {
  const { id, method, params = {} } = message;
  const sessionId = params.sessionId;
  if (!method) {
    const pending = permissions.get(id);
    if (!pending) return;
    permissions.delete(id);
    if (!active.has(pending.sessionId)) return;
    const option = message.result?.outcome;
    const allowed = option?.outcome === 'selected' && ['allow', 'always'].includes(option.optionId);
    if (allowed) writeFileSync(join(root, 'mock-output.txt'), 'authorized mock tool result\n');
    update(pending.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mock-write',
      status: allowed ? 'completed' : 'failed',
      rawOutput: { allowed },
      content: [{ type: 'content', content: { type: 'text', text: allowed ? 'written' : 'denied' } }],
    });
    finish(pending.sessionId, pending.requestId, `permission=${allowed ? 'allowed' : 'denied'}`);
    return;
  }
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'codeagent-mock', version: '0.1.0' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
          promptCapabilities: {},
        },
      });
      return;
    case 'session/new': {
      const next = randomUUID();
      sessions.set(next, []);
      writeFileSync(statePath(next), '[]');
      reply(id, { sessionId: next });
      return;
    }
    case 'session/load':
    case 'session/resume':
      if (!/^[a-f0-9-]{36}$/.test(sessionId) || !existsSync(statePath(sessionId))) {
        send({ id, error: { code: -32001, message: 'Mock session does not exist in this state root' } });
        return;
      }
      sessions.set(sessionId, JSON.parse(readFileSync(statePath(sessionId), 'utf8')));
      reply(id, { sessionId });
      return;
    case 'session/prompt': {
      if (!sessions.has(sessionId)) {
        send({ id, error: { code: -32001, message: 'Open or resume the mock session first' } });
        return;
      }
      const text = params.prompt
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      const history = sessions.get(sessionId);
      const previous = history.at(-1) ?? '';
      history.push(text);
      writeFileSync(statePath(sessionId), JSON.stringify(history));
      active.set(sessionId, id);
      if (text.includes('#disconnect')) process.exit(23);
      if (text.includes('#wait')) {
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting' } });
        return;
      }
      if (text.includes('#tool')) {
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'mock-write',
          title: 'mock write',
          status: 'pending',
          rawInput: { file: 'mock-output.txt' },
        });
        const permissionId = `permission:${randomUUID()}`;
        permissions.set(permissionId, { sessionId, requestId: id });
        send({
          id: permissionId,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'mock-write', title: 'Write isolated fixture output' },
            options: [
              { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
              ...(text.includes('#allow-only')
                ? []
                : [{ optionId: 'reject', kind: 'reject_once', name: 'Reject once' }]),
            ],
          },
        });
        return;
      }
      finish(sessionId, id, `previous=${previous}; current=${text}`);
      return;
    }
    case 'session/cancel': {
      const requestId = active.get(sessionId);
      if (requestId !== undefined) finish(sessionId, requestId, 'cancelled', 'cancelled');
      if (id !== undefined) reply(id, {});
      return;
    }
    case 'session/close':
      sessions.delete(sessionId);
      if (id !== undefined) reply(id, {});
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Unsupported mock method: ${method}` } });
  }
}

for await (const line of createInterface({ input: process.stdin })) handle(JSON.parse(line));
