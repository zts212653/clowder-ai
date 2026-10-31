import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { ProfileMemoryLifecycleService } from '../dist/domains/memory/profile/ProfileMemoryLifecycleService.js';
import { ProfileMemoryLifecycleStore } from '../dist/domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { profileMemoryOwnerRoutes } from '../dist/routes/profile-memory-owner.js';

const ownerUserId = 'profile-owner';
const origin = 'http://localhost:3003';

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

describe('F321 Profile owner lifecycle', () => {
  let app;
  let db;
  let dataDir;
  let repository;
  let profileDir;
  let session;
  let invalidations;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'f321-profile-owner-'));
    repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'maine-coon' });
    profileDir = repository.profileDir(ownerUserId);
    mkdirSync(join(profileDir, 'relationship'), { recursive: true });
    mkdirSync(join(profileDir, 'provenance'), { recursive: true });
    mkdirSync(dirname(repository.corpusPath(ownerUserId)), { recursive: true });
    writeFileSync(repository.corpusPath(ownerUserId), '先给结果，再按需展开过程。', 'utf8');
    writeFileSync(join(profileDir, 'relationship', 'maine-coon-primer.md'), '我们会一起把复杂问题讲成人话。', 'utf8');
    writeFileSync(
      join(profileDir, 'provenance', 'proposal-profile-corpus.md'),
      [
        '# Provenance: profile-update proposal-profile',
        '',
        '- cat: codex-sol',
        '- layer: corpus',
        '- target: corpus/shared-facts.md',
        '- thread: thread-profile-source',
        '- signalSourceThread: thread-profile-source',
        '- signalSourceMessage: message-profile-source',
        '',
        '## Before (pinned at propose)',
        '',
        '旧画像',
        '',
        '## After',
        '',
        '先给结果，再按需展开过程。',
        '',
      ].join('\n'),
      'utf8',
    );
    db = new Database(':memory:');
    applyMigrations(db);
    const store = new ProfileMemoryLifecycleStore({ db, repository });
    invalidations = [];
    const lifecycle = new ProfileMemoryLifecycleService({
      store,
      coordinator: new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      }),
      targetLock: new SessionMutex(),
      invalidateDerived: async (input) => invalidations.push(input),
    });
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    await app.register(profileMemoryOwnerRoutes, {
      ownerUserId,
      store,
      lifecycle,
      proposalStore: { listByTarget: async () => [] },
      sourceReaders: {
        threadStore: {
          get: async (id) =>
            id === 'thread-profile-source'
              ? { id, title: '画像来源', createdBy: ownerUserId, visibility: 'private' }
              : null,
          list: async () => [],
        },
        messageStore: {
          getById: async (id) =>
            id === 'message-profile-source'
              ? {
                  id,
                  threadId: 'thread-profile-source',
                  userId: ownerUserId,
                  catId: null,
                  content: '原始画像来源',
                  timestamp: 100,
                  deliveryStatus: 'delivered',
                }
              : null,
        },
      },
    });
    await app.ready();
    const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
    session = { cookie: cookieHeader(login), csrf: login.json().csrfToken };
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const readHeaders = () => ({ cookie: session.cookie });
  const actionHeaders = () => ({
    cookie: session.cookie,
    origin,
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  });

  it('opens selected relationship sources through the same owner visibility checks', async () => {
    const content = `---
opening:
  asOf: '2026-10-03'
  excerpts:
    - kind: relationship
      text: 一起完成示例合奏。
      source: {threadId: thread-profile-source, messageId: message-profile-source}
    - kind: model_capability
      model: example-model-v1
      text: 当时模型的历史判断。
      source: {threadId: private-other-owner, messageId: hidden-message}
---
原关系正文。`;
    writeFileSync(join(profileDir, 'relationship', 'maine-coon-primer.md'), content);
    const list = await app.inject({ method: 'GET', url: '/api/memory/profile', headers: readHeaders() });
    const primer = list.json().entries.find((entry) => entry.layer === 'primer');
    const source = await app.inject({
      method: 'GET',
      url: `/api/memory/profile/${encodeURIComponent(primer.id)}/source?revision=${primer.revision}`,
      headers: readHeaders(),
    });
    assert.equal(source.statusCode, 200);
    assert.equal(source.json().status, 'ready');
    assert.equal(source.json().sources.length, 1);
    assert.equal(source.json().sources[0].messageId, 'message-profile-source');
    assert.doesNotMatch(source.body, /private-other-owner|hidden-message/);
  });

  async function postAction(memoryId, payload) {
    return app.inject({
      method: 'POST',
      url: `/api/memory/profile/${encodeURIComponent(memoryId)}/actions`,
      headers: actionHeaders(),
      payload,
    });
  }

  it('lists corpus and relationship primers, fences detail/source reads, and replaces content idempotently', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/memory/profile', headers: readHeaders() });
    assert.equal(list.statusCode, 200, list.body);
    const entries = list.json().entries;
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['corpus', 'primer:maine-coon'],
    );
    const corpus = entries[0];
    assert.match(corpus.revision, /^sha256:[a-f0-9]{64}$/);

    const staleDetail = await app.inject({
      method: 'GET',
      url: `/api/memory/profile/corpus?revision=sha256:${'f'.repeat(64)}`,
      headers: readHeaders(),
    });
    assert.equal(staleDetail.statusCode, 409);

    const source = await app.inject({
      method: 'GET',
      url: `/api/memory/profile/corpus/source?revision=${corpus.revision}`,
      headers: readHeaders(),
    });
    assert.deepEqual(source.json(), {
      status: 'ready',
      sources: [
        {
          label: '画像来源',
          occurredAt: 100,
          canOpen: true,
          threadId: 'thread-profile-source',
          messageId: 'message-profile-source',
        },
      ],
    });

    const command = {
      action: 'replace_content',
      requestId: 'profile-replace:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: corpus.revision,
      content: '先给清楚的结论，再展开必要过程。',
    };
    const replaced = await postAction('corpus', command);
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.equal(readFileSync(repository.corpusPath(ownerUserId), 'utf8'), command.content);
    assert.equal((await postAction('corpus', command)).json().outcome, 'replayed');
    assert.deepEqual(invalidations, [{ ownerUserId, memoryId: 'corpus', action: 'replace_content' }]);
  });

  it('hard-forgets canonical content and indexed provenance while honestly retaining proposal audit', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/memory/profile', headers: readHeaders() });
    const corpus = list.json().entries.find((entry) => entry.id === 'corpus');
    const forgotten = await postAction('corpus', {
      action: 'hard_forget',
      requestId: 'profile-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: corpus.revision,
      confirmed: true,
    });
    assert.equal(forgotten.statusCode, 200, forgotten.body);
    assert.deepEqual(forgotten.json().forgetScope, {
      canonicalMemory: 'deleted',
      derivedProjections: 'invalidated',
      originalSource: 'preserved',
      immutableAudit: 'retained',
    });
    assert.equal(repository.readCorpus(ownerUserId), null);
    assert.equal(existsSync(repository.corpusPath(ownerUserId)), false);
    assert.equal(existsSync(join(profileDir, 'provenance', 'proposal-profile-corpus.md')), false);
    assert.deepEqual(invalidations, [{ ownerUserId, memoryId: 'corpus', action: 'hard_forget' }]);
  });
});
