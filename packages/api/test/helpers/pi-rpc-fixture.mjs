import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
writeFileSync(path.join(root, 'started'), String(process.pid));
const extension = process.argv.indexOf('--extension');
if (extension !== -1) {
  const module = await import(pathToFileURL(process.argv[extension + 1]).href);
  module.default({
    registerMcpServer(name, config) {
      writeFileSync(
        path.join(root, 'mcp-seen.json'),
        JSON.stringify({ name, config, entry: process.argv[extension + 1] }),
      );
    },
  });
}
const unknownModel = existsSync(path.join(root, 'unknown-model'));
let model = unknownModel
  ? { provider: 'unknown', id: 'unknown', name: 'unknown' }
  : { provider: 'fixture', id: 'native', name: 'Native fixture' };
let thinkingLevel = 'medium',
  buffer = '',
  timer;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (command, data = {}) =>
  send({ type: 'response', command: command.type, id: command.id, success: true, data });
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    switch (command.type) {
      case 'get_state':
        response(command, { model, thinkingLevel });
        break;
      case 'get_available_models':
        response(command, {
          models: unknownModel
            ? []
            : [model, { provider: 'fixture', id: 'other', name: 'Other', secret: 'catalog-sensitive-sentinel' }],
        });
        break;
      case 'get_available_thinking_levels':
        response(command, { levels: ['low', 'medium', 'high'] });
        break;
      case 'set_model':
        model = { provider: command.provider, id: command.modelId };
        response(command, model);
        break;
      case 'set_thinking_level':
        thinkingLevel = command.level;
        response(command);
        break;
      case 'abort':
        clearInterval(timer);
        send({ type: 'agent_settled', aborted: true });
        response(command);
        break;
      case 'extension_ui_response':
        writeFileSync(path.join(root, 'ui-response.json'), JSON.stringify(command));
        send({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'blocked' }], stopReason: 'stop' },
        });
        send({ type: 'agent_settled', aborted: false });
        break;
      case 'prompt': {
        if (command.message === 'rejected') {
          send({ type: 'response', command: 'prompt', id: command.id, success: false });
          break;
        }
        if (command.message === 'handled') {
          response(command, { disposition: 'handled' });
          break;
        }
        response(command, { disposition: 'started' });
        if (command.message === 'exit') {
          process.exit(2);
          break;
        }
        send({ type: 'message_start', message: { role: 'assistant' } });
        if (command.message === 'ui') {
          send({ type: 'extension_ui_request', id: 'permission-1', method: 'confirm', title: 'Allow command?' });
          break;
        }
        if (command.message === 'error') {
          send({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider denied' },
          });
          send({ type: 'agent_settled', aborted: false });
          break;
        }
        send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Thinking' } });
        send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'fixture' } });
        send({
          type: 'tool_execution_end',
          toolCallId: 'tool-1',
          result: { content: [{ type: 'text', text: 'fixture result' }] },
          isError: false,
        });
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: '42\u2028still one record' },
        });
        send({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '42\u2028still one record' }],
            stopReason: 'stop',
          },
        });
        send({ type: 'agent_end', willRetry: true });
        timer = setInterval(() => {
          if (command.message === 'hold' && !existsSync(path.join(root, 'release'))) return;
          clearInterval(timer);
          send({ type: 'agent_settled', aborted: false });
        }, 10);
        break;
      }
      default:
        send({ type: 'response', id: command.id, command: command.type, success: false });
    }
  }
});
process.stdin.once('end', () => {
  clearInterval(timer);
  process.exit(0);
});
