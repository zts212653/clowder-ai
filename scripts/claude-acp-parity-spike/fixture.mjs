import { appendFileSync } from 'node:fs';

const trace = process.argv[2] ?? process.env.CLOWDER_SPIKE_TOOL_TRACE;
if (!trace) throw new Error('Fixture trace required');
const pending = new Map();
const log = (event) => appendFileSync(trace, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...event })}\n`);
log({ event: 'server_started', traceEnvPresent: Boolean(process.env.CLOWDER_SPIKE_TOOL_TRACE) });
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
async function handle(message) {
  const { id, method, params } = message;
  log({ event: 'method', method });
  if (method === 'initialize')
    return send(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'clowder-parity-fixture', version: '1' },
    });
  if (method === 'ping') return send(id, {});
  if (method === 'tools/list')
    return send(id, {
      tools: [
        {
          name: 'wait',
          description: 'Controlled read-only parity fixture; wait exactly 8000 milliseconds.',
          inputSchema: {
            type: 'object',
            properties: {
              phase: { type: 'string', enum: ['append', 'steer'] },
              delayMs: { type: 'integer', const: 8000 },
            },
            required: ['phase', 'delayMs'],
            additionalProperties: false,
          },
        },
      ],
    });
  if (method === 'notifications/cancelled') {
    log({ event: 'cancel_notification', requestId: params.requestId });
    return;
  }
  if (method === 'tools/call') {
    if (
      params.name !== 'wait' ||
      !['append', 'steer'].includes(params.arguments?.phase) ||
      params.arguments?.delayMs !== 8000
    ) {
      return send(id, { isError: true, content: [{ type: 'text', text: 'Fixture scope rejected' }] });
    }
    const phase = params.arguments.phase;
    log({ event: 'started', phase, requestId: id });
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        log({ event: 'completed', phase, requestId: id });
        send(id, { content: [{ type: 'text', text: `FIXTURE-COMPLETED-${phase}` }] });
      }, 8000),
    );
  }
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  for (const timer of pending.values()) clearTimeout(timer);
});
