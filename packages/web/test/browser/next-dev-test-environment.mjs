import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function createNextDevTestEnvironment(label, overrides = {}) {
  assert.match(label, /^[a-z0-9-]+$/, 'Next dev test isolation label must be filesystem-safe');

  const distDirPath = await mkdtemp(path.join(WEB_ROOT, `.next-test-${label}-`));
  const distDir = path.basename(distDirPath);
  const tsconfigPath = path.join(WEB_ROOT, `tsconfig.${distDir.slice(1)}.json`);
  let cleaned = false;
  let missingBackend;

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (missingBackend?.listening) {
      missingBackend.closeAllConnections();
      await new Promise((resolve, reject) => missingBackend.close((error) => (error ? reject(error) : resolve())));
    }
    await Promise.all([rm(distDirPath, { recursive: true, force: true }), rm(tsconfigPath, { force: true })]);
  }

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
    // Shell ports/URLs name the live runtime. Absence is not isolation: next.config.js then uses
    // the deployment default. Unstubbed requests must reach a fixture-owned rejecting backend.
    const inherited = { ...process.env };
    for (const key of ['API_SERVER_PORT', 'FRONTEND_PORT', 'NEXT_PUBLIC_API_URL']) delete inherited[key];
    const env = {
      ...inherited,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'development',
      ...overrides,
      CAT_CAFE_WEB_TEST_DIST_DIR: distDir,
      CAT_CAFE_WEB_TEST_TSCONFIG: path.basename(tsconfigPath),
    };
    const hasBackend =
      [overrides.API_SERVER_PORT, overrides.FRONTEND_PORT].some(
        (port) => Number.isInteger(Number(port)) && Number(port) > 0,
      ) || overrides.NEXT_PUBLIC_API_URL?.trim();
    if (!hasBackend) {
      missingBackend = createServer((_request, response) => {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'test_backend_not_configured' }));
      });
      missingBackend.listen(0, '127.0.0.1');
      await once(missingBackend, 'listening');
      env.API_SERVER_PORT = String(missingBackend.address().port);
      env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${env.API_SERVER_PORT}`;
    }
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST_')) delete env[key];
    }
    return { distDirPath, env, tsconfigPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
