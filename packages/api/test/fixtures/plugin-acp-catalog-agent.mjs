import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const trace = process.argv[2];
const initial = process.argv.includes('--unknown') ? 'unknown' : 'model-a';
const session = (model = initial) => ({
  sessionId: 'probe',
  configOptions: [
    {
      id: 'model',
      category: 'model',
      currentValue: model,
      options: [
        { value: 'model-a', name: 'Model A' },
        { value: 'model-b', name: 'Model B' },
      ],
    },
  ],
});
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  appendFileSync(trace, `${JSON.stringify({ method, params })}\n`);
  const result =
    method === 'initialize'
      ? {
          protocolVersion: 1,
          agentInfo: { name: 'catalog-fixture', version: '1' },
          agentCapabilities: { loadSession: true },
        }
      : method === 'session/set_config_option'
        ? session(process.argv.includes('--ignore-selection') ? initial : params.value)
        : session();
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
