import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { configStore } from '../dist/config/ConfigStore.js';
import { _clearRuntimeOverrides } from '../dist/config/session-strategy-overrides.js';
import { configRoutes } from '../dist/routes/config.js';
import { sessionStrategyConfigRoutes } from '../dist/routes/session-strategy-config.js';

const headers = { 'x-cat-cafe-user': 'member-cas-test' };

describe('formal settings write preconditions', () => {
  const apps = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    configStore.reset();
    _clearRuntimeOverrides();
  });

  async function appForSettings() {
    const app = Fastify();
    apps.push(app);
    await app.register(configRoutes, {
      projectRoot: mkdtempSync(join(tmpdir(), 'member-config-cas-')),
      auditLog: { append: async () => {} },
    });
    await app.register(sessionStrategyConfigRoutes);
    return app;
  }

  it('refuses old blind Codex setting writes', async () => {
    const app = await appForSettings();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers,
      payload: { key: 'cli.codexSandboxMode', value: 'workspace-write' },
    });
    assert.equal(response.statusCode, 428);
  });

  it('returns a Codex resource revision and refuses a stale editor', async () => {
    const app = await appForSettings();
    const read = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    const payload = {
      key: 'cli.codexSandboxMode',
      value: 'workspace-write',
      expectedRevision: read.revisions['cli.codexSandboxMode'],
    };
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/config', headers, payload })).statusCode, 200);
    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers,
      payload: { ...payload, value: 'danger-full-access' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(configStore.get('cli.codexSandboxMode'), 'workspace-write');
  });

  it('refuses old blind strategy writes and deletes', async () => {
    const app = await appForSettings();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/config/session-strategy/codex',
      headers,
      payload: { strategy: 'compress' },
    });
    assert.equal(patch.statusCode, 428);
    const deletion = await app.inject({ method: 'DELETE', url: '/api/config/session-strategy/codex', headers });
    assert.equal(deletion.statusCode, 428);
  });

  it('fences two strategy editors through the real HTTP route', async () => {
    const app = await appForSettings();
    const read = (await app.inject({ method: 'GET', url: '/api/config/session-strategy' })).json();
    const entry = read.cats.find((cat) => cat.catId === 'codex');
    assert.equal(typeof entry.overrideRevision, 'string');
    const expectedRevision = entry.overrideRevision;
    const writes = await Promise.all(
      ['compress', 'hybrid'].map((strategy) =>
        app.inject({
          method: 'PATCH',
          url: '/api/config/session-strategy/codex',
          headers,
          payload: { strategy, expectedRevision },
        }),
      ),
    );
    assert.deepEqual(writes.map((response) => response.statusCode).sort(), [200, 409]);
  });
});
