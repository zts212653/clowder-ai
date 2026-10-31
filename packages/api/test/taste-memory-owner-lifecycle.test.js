import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleService } from '../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { tasteMemoryId } from '../dist/domains/memory/taste/taste-memory-identity.js';
import { InMemoryTasteProposalStore } from '../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { tasteBrowseRoutes } from '../dist/routes/taste-browse.js';

const ownerUserId = 'taste-owner';
const origin = 'http://localhost:3003';
const sourcePath = 'private/taste/owner-lifecycle.md';

function vignette(overrides = {}) {
  return [
    '---',
    'when: 2026-10-06',
    'quotes: ["先把真相摆出来"]',
    'scene: "Owner lifecycle test"',
    'tags: ["truth", "owner"]',
    'dimension: cognitive-honesty',
    'privacy: sensitive',
    ...(overrides.status ? [`status: ${overrides.status}`] : []),
    'catId: codex-sol',
    'proposalId: proposal-original',
    '---',
    '',
  ].join('\n');
}

function revisionOf(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

describe('F321 Taste owner lifecycle', () => {
  let app;
  let db;
  let root;
  let store;
  let lifecycle;
  let session;
  let invalidations;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'f321-taste-owner-'));
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    mkdirSync(join(root, 'private/taste'), { recursive: true });
    writeFileSync(join(root, 'docs/taste/index.md'), '# Taste Index\n', 'utf8');
    writeFileSync(join(root, sourcePath), vignette(), 'utf8');
    db = new Database(':memory:');
    applyMigrations(db);
    store = new TasteMemoryLifecycleStore(db);
    invalidations = [];
    const targetLock = new SessionMutex();
    const repository = {
      canonicalRoot: () => root,
      gitCheckoutRoot: () => root,
      approvalLockKey: () => 'taste-owner-test',
    };
    lifecycle = new TasteMemoryLifecycleService({
      store,
      writer: new TasteMemoryProjectionWriter(repository),
      coordinator: new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      }),
      targetLock,
      lockKey: () => 'taste-owner-test',
      invalidateDerived: async (input) => invalidations.push(input),
    });
    const proposalStore = new InMemoryTasteProposalStore();
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    await app.register(tasteBrowseRoutes, {
      ownerUserId,
      tasteRepository: repository,
      lifecycleStore: store,
      lifecycleService: lifecycle,
      readObservatory: async () => ({
        entries: [],
        constellations: [],
        coverage: { totalUnverified: 0 },
      }),
      proposalStore,
      threadStore: { get: async () => null, list: async () => [] },
      messageStore: { getById: async () => null },
    });
    await app.ready();
    const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
    session = { cookie: cookieHeader(login), csrf: login.json().csrfToken };
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const readHeaders = () => ({ cookie: session.cookie });
  const actionHeaders = () => ({
    cookie: session.cookie,
    origin,
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  });

  async function postAction(memoryId, payload) {
    return app.inject({
      method: 'POST',
      url: `/api/memory/taste/${memoryId}/actions`,
      headers: actionHeaders(),
      payload,
    });
  }

  it('confirms a revision-bound takeaway, corrects, retires, and truly forgets with exact replay', async () => {
    const initialRevision = revisionOf(readFileSync(join(root, sourcePath)));
    const candidate = store.importCandidate({
      ownerUserId,
      sourcePath,
      sourceRevision: initialRevision,
      takeaway: '我们以为 You 偏好先把真相摆出来。',
      sourceRef: 'private/f321/takeaway-drafts.json',
    });
    assert.ok(candidate);

    const list = await app.inject({ method: 'GET', url: '/api/memory/taste', headers: readHeaders() });
    assert.equal(list.statusCode, 200, list.body);
    const initial = list.json().entries[0];
    assert.equal(initial.status, 'active');
    assert.deepEqual(initial.takeawayCandidate, candidate);
    assert.equal(initial.pendingCorrectionCount, 0);

    const confirm = {
      action: 'confirm_takeaway',
      requestId: 'taste-confirm:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: initial.revision,
      candidateRevision: candidate.candidateRevision,
      takeaway: 'You 偏好先把真相摆出来，再一起判断。',
    };
    const missingBrowserBoundary = await app.inject({
      method: 'POST',
      url: `/api/memory/taste/${initial.id}/actions`,
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      payload: confirm,
    });
    assert.equal(missingBrowserBoundary.statusCode, 403, missingBrowserBoundary.body);
    const wrongCandidate = await postAction(initial.id, {
      ...confirm,
      requestId: 'taste-wrong-candidate:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      candidateRevision: `sha256:${'f'.repeat(64)}`,
    });
    assert.equal(wrongCandidate.statusCode, 409, wrongCandidate.body);
    assert.equal(wrongCandidate.json().error, 'candidate_unavailable');
    const confirmed = await postAction(initial.id, confirm);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().outcome, 'applied');
    assert.match(readFileSync(join(root, sourcePath), 'utf8'), /takeaway: You 偏好先把真相摆出来，再一起判断。/u);
    assert.equal((await postAction(initial.id, confirm)).json().outcome, 'replayed');

    const corrected = await postAction(initial.id, {
      action: 'correct',
      requestId: 'taste-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: confirmed.json().revision,
      patch: { scene: 'Owner corrected scene', tags: ['truth', 'corrected'] },
    });
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.match(readFileSync(join(root, sourcePath), 'utf8'), /Owner corrected scene/u);

    const retired = await postAction(initial.id, {
      action: 'retire',
      requestId: 'taste-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: corrected.json().revision,
    });
    assert.equal(retired.statusCode, 200, retired.body);
    assert.equal(retired.json().status, 'retired');

    const forgetCommand = {
      action: 'hard_forget',
      requestId: 'taste-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: retired.json().revision,
      confirmed: true,
    };
    const forgotten = await postAction(initial.id, forgetCommand);
    assert.equal(forgotten.statusCode, 200, forgotten.body);
    assert.deepEqual(forgotten.json().forgetScope, {
      canonicalMemory: 'deleted',
      derivedProjections: 'invalidated',
      originalSource: 'preserved',
      immutableAudit: 'retained',
    });
    assert.equal(existsSync(join(root, sourcePath)), false);
    assert.equal((await postAction(initial.id, forgetCommand)).json().outcome, 'replayed');
    assert.deepEqual(invalidations, [
      { ownerUserId, sourcePath },
      { ownerUserId, sourcePath },
      { ownerUserId, sourcePath },
      { ownerUserId, sourcePath },
    ]);

    writeFileSync(join(root, sourcePath), vignette(), 'utf8');
    const hidden = await app.inject({ method: 'GET', url: '/api/memory/taste', headers: readHeaders() });
    assert.deepEqual(hidden.json().entries, []);
    const resurrect = await postAction(initial.id, {
      action: 'correct',
      requestId: 'taste-resurrect:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: revisionOf(readFileSync(join(root, sourcePath))),
      patch: { scene: 'must stay forgotten' },
    });
    assert.equal(resurrect.statusCode, 404, resurrect.body);
  });

  it('never infers a completed hard forget from an absent file without exact mutation evidence', async () => {
    const currentRevision = revisionOf(readFileSync(join(root, sourcePath)));
    const command = {
      action: 'hard_forget',
      requestId: 'taste-absence:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: currentRevision,
      confirmed: true,
    };
    store.prepareAction({
      ownerUserId,
      sourcePath,
      memoryId: tasteMemoryId(sourcePath),
      command,
      currentStatus: 'active',
      currentRevision,
    });
    rmSync(join(root, sourcePath));

    const result = await lifecycle.executeOwnerAction(ownerUserId, tasteMemoryId(sourcePath), sourcePath, command);
    assert.deepEqual(result, { error: 'not_available' });
  });
});
