import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { linkedRootConfigPath } from '../../src/domains/workspace/roots/workspace-linked-root-store.js';
import { issueRootConnectionProof } from '../../src/domains/workspace/roots/workspace-root-proof.js';

process.stdout.write('ready\n');
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
const root = process.argv[2];
if (!root) throw new Error('fixture root required');
const proof = issueRootConnectionProof({
  userId: 'operator',
  root,
  expectedEpoch: 0,
  source: { kind: 'directory-selection' },
});
const key = readFileSync(join(dirname(linkedRootConfigPath()), 'secrets', 'root-preparation.key'));
// Private pipe to the parent test, never a CI log. Public assertions use hashes/claims.
process.stdout.write(JSON.stringify({ proof, keyDigest: createHash('sha256').update(key).digest('hex') }));
