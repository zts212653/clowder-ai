import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareEnvironment } from './environment.mjs';
import { directTransport } from './transports.mjs';

const state = await prepareEnvironment(process.argv[2]);
const events = [];
const record = (event) => events.push(state.redact({ t: Date.now(), ...event }));
const transport = await directTransport(state, 'sdk-original', record, async () => ({}));
try {
  let status = await transport.probe();
  const start = Date.now();
  while (status.some((entry) => entry.status === 'pending') && Date.now() - start < 30000) {
    await new Promise((done) => setTimeout(done, 250));
    status = await transport.probe();
  }
  console.log(JSON.stringify({ modelPrompts: 0, status }));
  await writeFile(join(state.dir, 'probe-status.json'), JSON.stringify(status, null, 2));
} finally {
  await transport.close();
  await writeFile(join(state.dir, 'events.json'), JSON.stringify(events, null, 2));
}
