import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function createNextDevTestEnvironment(label, overrides = {}) {
  assert.match(label, /^[a-z0-9-]+$/, 'Next dev test isolation label must be filesystem-safe');

  const distDirPath = await mkdtemp(path.join(WEB_ROOT, `.next-test-${label}-`));
  const distDir = path.basename(distDirPath);
  const tsconfigPath = path.join(WEB_ROOT, `tsconfig.${distDir.slice(1)}.json`);
  let cleaned = false;

  try {
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          extends: './tsconfig.json',
          compilerOptions: { noEmit: true },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${distDir}/types/**/*.ts`],
          exclude: ['node_modules', 'worker'],
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    await rm(distDirPath, { recursive: true, force: true });
    throw error;
  }

  // The test server proxies /api and /socket.io to the port these name (next.config.mjs). Inherited
  // from a cat's shell they name the running runtime, so a fixture with stubbed APIs joined real thread
  // rooms there (PR-3a2: that join opens a recovery round the fixture's empty History then decides).
  // A test that needs a backend passes its own port in `overrides`.
  const inherited = { ...process.env };
  delete inherited.API_SERVER_PORT;
  delete inherited.FRONTEND_PORT;
  const env = {
    ...inherited,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'development',
    ...overrides,
    CAT_CAFE_WEB_TEST_DIST_DIR: distDir,
    CAT_CAFE_WEB_TEST_TSCONFIG: path.basename(tsconfigPath),
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }

  return {
    distDirPath,
    env,
    tsconfigPath,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.all([rm(distDirPath, { recursive: true, force: true }), rm(tsconfigPath, { force: true })]);
    },
  };
}
