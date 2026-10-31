import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createTasteProposalWriter } from '../dist/domains/memory/taste/createTasteProposalWriter.js';
import { TasteMemoryLifecycleService } from '../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { InMemoryTasteProposalStore } from '../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { callbackProposeTasteRoutes } from '../dist/routes/callback-propose-taste-routes.js';
import { tasteBrowseRoutes } from '../dist/routes/taste-browse.js';
import { registerTasteProposalDecisionRoutes } from '../dist/routes/taste-proposal-decision-routes.js';

const ownerUserId = 'taste-correction-owner';
const origin = 'http://localhost:3003';
const sourcePath = 'private/taste/correction-target.md';
const sourceAnchor = `taste-vignette:${sourcePath}`;

const vignette = (scene = 'Original scene') =>
  `---\nwhen: 2026-10-06\nquotes: ["Original quote"]\nscene: "${scene}"\ntags: ["truth"]\ndimension: cognitive-honesty\nprivacy: sensitive\ncatId: codex-sol\nproposalId: proposal-original\n---\n`;

const revisionOf = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

function correctionInput(expectedRevision) {
  return {
    userId: ownerUserId,
    catId: 'codex-sol',
    threadId: 'thread-correction',
    scene: 'Corrected scene',
    quote: 'Original quote',
    tags: ['truth'],
    dimension: 'cognitive-honesty',
    privacy: 'sensitive',
    clientRequestId: 'taste-correction:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
    correctionTarget: {
      sourceAnchor,
      expectedRevision,
      reason: 'unsupported_by_source',
      suggestedPatch: { scene: 'Corrected scene' },
    },
  };
}

describe('F321 Taste source-bound correction proposal', () => {
  let app;
  let db;
  let root;
  let repository;
  let proposalStore;
  let lifecycleStore;
  let lifecycle;
  let proposal;
  let session;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'f321-taste-correction-'));
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    mkdirSync(join(root, 'private/taste'), { recursive: true });
    writeFileSync(join(root, 'docs/taste/index.md'), '# Taste Index\n', 'utf8');
    writeFileSync(join(root, sourcePath), vignette(), 'utf8');
    repository = {
      canonicalRoot: () => root,
      gitCheckoutRoot: () => root,
      approvalLockKey: () => 'taste-correction-test',
    };
    db = new Database(':memory:');
    applyMigrations(db);
    lifecycleStore = new TasteMemoryLifecycleStore(db);
    const approvalLock = new SessionMutex();
    lifecycle = new TasteMemoryLifecycleService({
      store: lifecycleStore,
      writer: new TasteMemoryProjectionWriter(repository),
      coordinator: new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      }),
      targetLock: approvalLock,
      lockKey: repository.approvalLockKey,
      invalidateDerived: async () => {},
    });
    proposalStore = new InMemoryTasteProposalStore();
    const initialRevision = revisionOf(readFileSync(join(root, sourcePath)));
    proposal = proposalStore.create(correctionInput(initialRevision));
    await proposalStore.commitEnvelope(proposal.id, {
      canonicalProposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId,
      requesterCatId: proposal.catId,
      originRef: { kind: 'message', threadId: proposal.threadId, messageId: 'message-correction' },
      approvalCardRef: { threadId: proposal.threadId, messageId: 'message-card' },
      createdAt: proposal.createdAt,
    });

    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    registerTasteProposalDecisionRoutes(app, {
      tasteProposalStore: proposalStore,
      socketManager: { emitToUser: () => {} },
      writeVignette: createTasteProposalWriter(async () => {
        throw new Error('create writer must not run for correction proposals');
      }, lifecycle),
      approvalCoordinator: { lock: approvalLock, lockKey: repository.approvalLockKey },
    });
    await app.register(tasteBrowseRoutes, {
      ownerUserId,
      tasteRepository: repository,
      lifecycleStore,
      lifecycleService: lifecycle,
      readObservatory: async () => ({ entries: [], constellations: [], coverage: { totalUnverified: 0 } }),
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

  const browserHeaders = () => ({ cookie: session.cookie, origin, 'x-csrf-token': session.csrf });

  it('attaches the pending suggestion to its original memory and applies only after browser-owner approval', async () => {
    const list = await app.inject({ url: '/api/memory/taste', headers: { cookie: session.cookie } });
    const memory = list.json().entries[0];
    assert.equal(memory.pendingCorrectionCount, 1);
    const detail = await app.inject({
      url: `/api/memory/taste/${memory.id}?revision=${encodeURIComponent(memory.revision)}`,
      headers: { cookie: session.cookie },
    });
    assert.deepEqual(detail.json().correctionProposals, [
      {
        proposalId: proposal.id,
        status: 'pending',
        expectedRevision: proposal.correctionTarget.expectedRevision,
        reason: 'unsupported_by_source',
        suggestedPatch: { scene: 'Corrected scene' },
        sourceCatId: 'codex-sol',
        sourceThreadId: 'thread-correction',
        createdAt: proposal.createdAt,
      },
    ]);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/taste-proposals/${proposal.id}/approve`,
      headers: browserHeaders(),
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, 'approved');
    assert.match(readFileSync(join(root, sourcePath), 'utf8'), /Corrected scene/u);
    assert.equal(proposalStore.get(proposal.id).status, 'approved');

    const after = await app.inject({ url: '/api/memory/taste', headers: { cookie: session.cookie } });
    assert.equal(after.json().entries[0].pendingCorrectionCount, 0);
  });

  it('rejects header-only reads and decisions without the browser Origin/CSRF boundary', async () => {
    const leaked = await app.inject({
      url: `/api/taste-proposals/${proposal.id}/decision-preview`,
      headers: { 'x-cat-cafe-user': ownerUserId },
    });
    assert.ok([401, 403].includes(leaked.statusCode), leaked.body);
    assert.equal(leaked.body.includes('Corrected scene'), false);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: `/api/taste-proposals/${proposal.id}/approve`,
      headers: { cookie: session.cookie },
    });
    assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);
    assert.equal(proposalStore.get(proposal.id).status, 'pending');
  });

  it('returns a conflict and leaves the suggestion pending when its source revision changed', async () => {
    writeFileSync(join(root, sourcePath), vignette('Changed before approval'), 'utf8');
    const response = await app.inject({
      method: 'POST',
      url: `/api/taste-proposals/${proposal.id}/approve`,
      headers: browserHeaders(),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'stale_revision');
    assert.equal(proposalStore.get(proposal.id).status, 'pending');
  });

  it('serializes a direct owner action and proposal approval without lock inversion', async () => {
    const list = await app.inject({ url: '/api/memory/taste', headers: { cookie: session.cookie } });
    const memory = list.json().entries[0];
    const [direct, approved] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/memory/taste/${memory.id}/actions`,
        headers: browserHeaders(),
        payload: {
          action: 'correct',
          requestId: 'taste-direct-race:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
          expectedRevision: memory.revision,
          patch: { scene: 'Direct owner correction won' },
        },
      }),
      app.inject({
        method: 'POST',
        url: `/api/taste-proposals/${proposal.id}/approve`,
        headers: browserHeaders(),
      }),
    ]);
    assert.deepEqual([direct.statusCode, approved.statusCode].sort(), [200, 409]);
    assert.match(readFileSync(join(root, sourcePath), 'utf8'), /(?:Direct owner correction won|Corrected scene)/u);
  });
});

describe('F321 Taste correction callback', () => {
  let app;
  let root;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'f321-taste-callback-'));
    mkdirSync(join(root, 'private/taste'), { recursive: true });
    writeFileSync(join(root, sourcePath), vignette(), 'utf8');
    const store = new InMemoryTasteProposalStore();
    app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'invocation-taste-correction',
        callbackToken: 'token',
        catId: 'codex-sol',
        threadId: 'thread-correction',
        userId: ownerUserId,
        originTriggerMessageId: 'message-correction',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      done();
    });
    await app.register(callbackProposeTasteRoutes, {
      registry: { isLatest: async () => true },
      tasteProposalStore: store,
      socketManager: { emitToUser: () => {} },
      tasteRepository: { canonicalRoot: () => root, approvalLockKey: () => 'callback-test' },
      approvalIngress: {
        async publish(draft, proposalStore) {
          await proposalStore.commitEnvelope(draft.canonicalProposalId, {
            canonicalProposalId: draft.canonicalProposalId,
            sourceFeatureId: 'F221',
            ownerUserId: draft.ownerUserId,
            requesterCatId: draft.requesterCatId,
            originRef: draft.originRef,
            approvalCardRef: { threadId: draft.cardThreadId, messageId: 'message-card' },
            createdAt: draft.createdAt,
          });
          return { proposalId: draft.canonicalProposalId, cardMessageId: 'message-card' };
        },
      },
    });
    app.testStore = store;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a correction in the existing Taste proposal store only when target revision is current', async () => {
    const expectedRevision = revisionOf(readFileSync(join(root, sourcePath)));
    const payload = {
      target: {
        sourceAnchor,
        expectedRevision,
        reason: 'outdated',
        suggestedPatch: { takeaway: '更新后的假设。' },
      },
      clientRequestId: 'taste-callback:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
    };
    const response = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.equal(response.statusCode, 200, response.body);
    const created = app.testStore.get(response.json().proposalId);
    assert.deepEqual(created.correctionTarget, payload.target);
    assert.equal(created.takeaway, '更新后的假设。');
    assert.equal(created.publication.state, 'anchored');

    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-taste',
      payload: {
        ...payload,
        clientRequestId: 'taste-stale:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        target: { ...payload.target, expectedRevision: `sha256:${'f'.repeat(64)}` },
      },
    });
    assert.equal(stale.statusCode, 409, stale.body);
  });
});
