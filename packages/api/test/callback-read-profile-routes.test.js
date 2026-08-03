import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('callback read-profile route', () => {
  let app;
  let dataDir;
  let registry;
  let repository;

  async function getProfile(userId, catId) {
    const { invocationId, callbackToken } = await registry.create(userId, catId, 'thread_1');
    return app.inject({
      method: 'GET',
      url: '/api/callbacks/profile',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'f231-read-profile-'));
    const { FileProfileRepository } = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    const { registerCallbackReadProfileRoutes } = await import('../dist/routes/callback-read-profile-routes.js');

    repository = new FileProfileRepository({
      dataDir,
      relationshipKeyForCat: (catId) => ({ codex: 'maine-coon', 'codex-sol': 'maine-coon', opus: 'ragdoll' })[catId],
    });
    registry = new InvocationRegistry();
    app = Fastify();
    registerCallbackAuthHook(app, registry);
    registerCallbackReadProfileRoutes(app, { repository });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the current authenticated user/persona without target identity input', async () => {
    const scope = repository.scope('alice', 'codex-sol');
    const path = repository.primerPath(scope);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'MAINE COON RELATIONSHIP', 'utf8');

    const response = await getProfile('alice', 'codex-sol');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      uri: 'cat-cafe-profile://relationship/current',
      relationshipKey: 'maine-coon',
      content: 'MAINE COON RELATIONSHIP',
    });
  });

  it('does not cross user roots for the same cat', async () => {
    const alice = repository.scope('alice', 'codex');
    const path = repository.primerPath(alice);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'ALICE ONLY', 'utf8');

    const response = await getProfile('bob', 'codex');
    assert.equal(response.statusCode, 404);
    assert.doesNotMatch(response.body, /ALICE ONLY/);
  });

  it('fails closed without callback principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/callbacks/profile' });
    assert.equal(response.statusCode, 401);
  });
});
