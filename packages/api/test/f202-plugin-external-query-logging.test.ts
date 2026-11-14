import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('production request logging redacts every query credential before Fastify automatic logs', async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), 'f202-query-log-'));
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const markers = ['F202_ACCEPTED_SECRET', 'F202_DUPLICATE_ONE', 'F202_DUPLICATE_TWO', 'F202_ENCODED_SECRET'];
  const fixture = `
    import assert from 'node:assert/strict';
    import Fastify from 'fastify';
    const { logger } = await import('./src/infrastructure/logger.ts');
    const { pluginExternalRequestRoutes } = await import('./src/routes/plugin/plugin-external-request-routes.ts');
    const app = Fastify({ logger });
    await app.register(pluginExternalRequestRoutes, {
      external: { handle: async () => ({ status: 200, body: { ok: true } }) },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/plugin-runtime/handle?token=F202_ACCEPTED_SECRET',
      payload: {},
    });
    assert.equal(accepted.statusCode, 200);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/plugin-runtime/handle?%74oken=F202_DUPLICATE_ONE&token=F202_DUPLICATE_TWO',
      payload: {},
    });
    assert.equal(duplicate.statusCode, 401);
    const encoded = await app.inject({
      method: 'POST',
      url: '/api/plugin-runtime/handle?token=F202%5FENCODED%5FSECRET',
      payload: {},
    });
    assert.equal(encoded.statusCode, 200);
    await app.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => logger.flush(resolve));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', fixture], {
    cwd: apiRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', LOG_DIR: logDir },
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const disk = await readFile(join(logDir, 'api.log'), 'utf8');
  const logs = `${child.stdout}\n${child.stderr}\n${disk}`;
  for (const marker of markers) assert.equal(logs.includes(marker), false, `${marker} escaped request serialization`);
  assert.match(logs, /token=\[REDACTED\]/u);
});
