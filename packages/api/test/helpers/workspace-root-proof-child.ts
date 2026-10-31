import { verifyRootConnectionProof } from '../../src/domains/workspace/roots/workspace-root-proof.js';

process.stdin.setEncoding('utf8');
let token = '';
for await (const chunk of process.stdin) token += chunk;
process.stdout.write(JSON.stringify(verifyRootConnectionProof(token)));
