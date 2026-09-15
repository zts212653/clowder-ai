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
    const body = JSON.parse(response.body);
    assert.equal(body.layer, 'primer');
    assert.equal(body.uri, 'cat-cafe-profile://relationship/current');
    assert.equal(body.relationshipKey, 'maine-coon');
    assert.equal(body.content, 'MAINE COON RELATIONSHIP');
    assert.ok(body.revision?.startsWith('sha256:'), 'revision included in primer read');
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

  // --- T7: Phase E read-side layer + revision + no leakage ---

  it('primer response includes revision (sha256)', async () => {
    const scope = repository.scope('alice', 'opus');
    const path = repository.primerPath(scope);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'RAGDOLL PRIMER', 'utf8');

    const response = await getProfile('alice', 'opus');
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.layer, 'primer');
    assert.equal(body.content, 'RAGDOLL PRIMER');
    assert.ok(body.revision?.startsWith('sha256:'), 'must include sha256 revision');
  });

  it('layer=corpus → reads corpus content with revision', async () => {
    const corpusDir = join(repository.profileDir('alice'), 'corpus');
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(join(corpusDir, 'shared-facts.md'), 'SHARED FACT', 'utf8');

    const { invocationId, callbackToken } = await registry.create('alice', 'opus', 'thread_1');
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/profile?layer=corpus',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.layer, 'corpus');
    assert.equal(body.uri, 'cat-cafe-profile://corpus/current');
    assert.equal(body.content, 'SHARED FACT');
    assert.ok(body.revision?.startsWith('sha256:'));
  });

  it('layer=corpus → 404 when no corpus exists (no scope leakage)', async () => {
    const { invocationId, callbackToken } = await registry.create('alice', 'opus', 'thread_1');
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/profile?layer=corpus',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'no_corpus', 'typed error for missing corpus');
    assert.equal(body.uri, 'cat-cafe-profile://corpus/current', 'uri included even on 404');
    // INV-6: error body must not reveal whether *primer* exists for this user
    assert.doesNotMatch(response.body, /relationship/);
    assert.doesNotMatch(response.body, /primer/);
  });

  it('primer 404 returns typed no_primer error with uri', async () => {
    // No primer written for alice/opus → 404 with typed error
    const response = await getProfile('alice', 'opus');
    assert.equal(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'no_primer', 'typed error code for missing primer');
    assert.equal(body.uri, 'cat-cafe-profile://relationship/current', 'uri included on primer 404');
  });

  it('unknown layer → 400', async () => {
    const { invocationId, callbackToken } = await registry.create('alice', 'opus', 'thread_1');
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/profile?layer=capsule',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'invalid_target_layer', 'typed error for unknown layer');
    assert.ok(body.detail, 'detail explains valid layers');
  });

  it('corpus repository error returns corpus_target_unavailable', async () => {
    // Simulate repository throwing on readCorpus
    const origReadCorpus = repository.readCorpus;
    repository.readCorpus = () => {
      throw new Error('disk I/O');
    };
    try {
      const { invocationId, callbackToken } = await registry.create('alice', 'opus', 'thread_1');
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/profile?layer=corpus',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });
      assert.equal(response.statusCode, 503, 'returns 503 on repository error');
      const body = JSON.parse(response.body);
      assert.equal(body.error, 'corpus_target_unavailable', 'typed error for unavailable corpus');
      assert.equal(body.uri, 'cat-cafe-profile://corpus/current', 'uri still included on error');
    } finally {
      repository.readCorpus = origReadCorpus;
    }
  });
});
