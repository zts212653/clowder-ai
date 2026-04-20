const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

test('run-with-node-env-test forces NODE_ENV=test for vitest-invoked workspace tree actions', () => {
  const webRoot = resolve(__dirname, '..');
  const script = resolve(webRoot, 'scripts', 'run-with-node-env-test.mjs');
  const result = spawnSync(
    'node',
    [script, 'pnpm', 'exec', 'vitest', 'run', 'src/components/workspace/__tests__/WorkspaceTree-actions.test.ts'],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /4 passed/);
});

test('run-with-node-env-test forces NODE_ENV=test for next-config node tests', () => {
  const webRoot = resolve(__dirname, '..');
  const script = resolve(webRoot, 'scripts', 'run-with-node-env-test.mjs');
  const result = spawnSync('node', [script, 'node', '--test', 'test/next-config.test.cjs'], {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass 4/);
});
