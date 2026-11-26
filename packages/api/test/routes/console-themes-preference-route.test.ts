import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { configRoutes } from '../../src/routes/config.js';

describe('console custom themes in the owner preferences', () => {
  const owner = 'console-themes-owner';
  const headers = { 'x-cat-cafe-user': owner };
  const url = '/api/config/console-themes';
  let app: FastifyInstance;
  let projectRoot: string;
  const preferencesPath = () => join(projectRoot, '.cat-cafe', 'user-preferences.json');

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'console-themes-preference-'));
    process.env.DEFAULT_OWNER_USER_ID = owner;
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    delete process.env.DEFAULT_OWNER_USER_ID;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('keeps the saved themes across recreation and leaves other preferences alone', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'));
    await writeFile(preferencesPath(), JSON.stringify({ catOrder: ['codex61-sol'] }));
    assert.deepEqual((await app.inject({ method: 'GET', url, headers })).json(), { themes: null });
    const themes = { active: 'c1', customs: [{ id: 'c1', name: '我的主题', full: { slots: {} } }] };
    const saved = await app.inject({ method: 'POST', url, headers, payload: { themes } });
    assert.equal(saved.statusCode, 200, saved.payload);
    await app.close();
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();
    assert.deepEqual((await app.inject({ method: 'GET', url, headers })).json(), { themes });
    const file = JSON.parse(await readFile(preferencesPath(), 'utf-8'));
    assert.deepEqual(file.catOrder, ['codex61-sol']);
    assert.deepEqual(file.consoleThemes, { [owner]: themes });
  });

  it('rejects a body that is not a themes object', async () => {
    const bad = await app.inject({ method: 'POST', url, headers, payload: { themes: 'x' } });
    assert.equal(bad.statusCode, 400);
  });
});
