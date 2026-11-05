import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PiAcpBridge } from '../../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js';
import { encodePiAcpRecord } from '../../dist/domains/cats/services/agents/providers/pi/pi-bridge-contract.js';

const root = process.argv[2];
const bridge = new PiAcpBridge(
  process.execPath,
  [fileURLToPath(new URL('./pi-rpc-fixture.mjs', import.meta.url)), root],
  (value) => process.stdout.write(encodePiAcpRecord(value)),
  { root, scope: 'd'.repeat(64) },
);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  void bridge.handle(JSON.parse(line));
});
lines.once('close', () => {
  void bridge.close();
});
