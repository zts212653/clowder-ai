import { readFile, writeFile } from 'node:fs/promises';
import { AGENT_ACCESS_PROTOCOL_VERSION, OFFICIAL_AGENT_ACCESS_OPERATIONS } from '@clowder-ai/agent-contract';
import { tarArchive } from '../../api/scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../../api/scripts/canonical-gzip.mjs';

const output = new URL('../dist/plugin/', import.meta.url);
const manifest = await readFile(new URL('../manifest.json', import.meta.url));
const { version } = JSON.parse(manifest);
const declarations = {
  protocolVersion: AGENT_ACCESS_PROTOCOL_VERSION,
  operations: OFFICIAL_AGENT_ACCESS_OPERATIONS,
  transports: ['a2a'],
};
const files = [
  { name: 'package/manifest.json', bytes: manifest },
  {
    name: 'package/package.json',
    bytes: Buffer.from(JSON.stringify({ name: '@clowder-ai/agent-access', version, type: 'module' })),
  },
  { name: 'package/agent-access.json', bytes: Buffer.from(JSON.stringify(declarations)) },
  { name: 'package/entrypoint.mjs', bytes: await readFile(new URL('entrypoint.mjs', output)) },
];
await writeFile(new URL('package.tgz', output), canonicalGzip(tarArchive(files)));
