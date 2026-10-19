import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both persistence owners (CAT_CAFE_DATA_DIR and legacy cwd) are isolated before
// test modules load. Portable entry for the target-owned Windows smoke workflow.
const root = mkdtempSync(join(tmpdir(), 'workspace-roots-suite-'));
const tests = [
  'workspace-root-durability',
  'workspace-root-write-failure',
  'workspace-root-cold-store',
  'workspace-root-http',
  'workspace-root-proof',
  'workspace-root-connection',
  'workspace-root-connection-origin',
  'workspace-root-connection-process',
  'workspace-root-connection-env',
];
try {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--test',
      '--test-concurrency=1',
      '--test-timeout=60000',
      ...tests.map((name) => fileURLToPath(new URL(`../test/${name}.test.ts`, import.meta.url))),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      timeout: 180000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CAT_CAFE_DATA_DIR: join(root, 'data'),
        CAT_CAFE_WORKSPACE_ROOT: root,
        WORKSPACE_LINKED_ROOTS: '',
        LOG_DIR: join(root, 'logs'),
        REDIS_URL: 'redis://127.0.0.1:6398',
      },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
