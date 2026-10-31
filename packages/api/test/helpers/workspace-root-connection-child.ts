import {
  connectWorkspaceRoot,
  readRootConnection,
} from '../../src/domains/workspace/roots/workspace-root-connection.js';

const [mode, operationId, root] = process.argv.slice(2);
if (!operationId) throw new Error('operation id required');
if (mode === 'read') process.stdout.write(JSON.stringify(await readRootConnection('operator', operationId)));
else {
  if (!root) throw new Error('fixture root required');
  process.stdout.write('ready\n');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  process.stdout.write(JSON.stringify(await connectWorkspaceRoot('operator', operationId, root, 0)));
}
