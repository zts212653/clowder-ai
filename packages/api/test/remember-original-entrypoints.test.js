import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ApprovalIngress } from '../src/domains/approval-hub/ApprovalIngress.js';
import { InMemoryEntityProposalStore } from '../src/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProfileUpdateProposalStore } from '../src/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { EntityRegistryStore } from '../src/domains/memory/EntityRegistry.js';
import { EventMemoryStore, eventMemoryRevision } from '../src/domains/memory/EventMemoryStore.js';
import { InMemoryEventMemoryCorrectionProposalStore } from '../src/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';
import { MatterMemoryService } from '../src/domains/memory/matters/MatterMemoryService.js';
import { ProactiveCandidateRegistryResolver } from '../src/domains/memory/ProactiveCandidateRegistryResolver.js';
import { RedisPersonMemoryStore } from '../src/domains/memory/people/RedisPersonMemoryStore.js';
import { EvidenceStoreWorkspacePersonResolver } from '../src/domains/memory/people/WorkspacePersonResolver.js';
import { RedisDeferredPersonMemoryReceiptStore } from '../src/domains/memory/RedisDeferredPersonMemoryReceiptStore.js';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations } from '../src/domains/memory/schema.js';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackDeferPersonMemoryRoutes } from '../src/routes/callback-defer-person-memory-routes.js';
import { callbackProposeEntityRoutes } from '../src/routes/callback-propose-entity-routes.js';
import { callbackProposeEventMemoryCorrectionRoutes } from '../src/routes/callback-propose-event-memory-correction-routes.js';
import { registerCallbackProposePersonMemoryRoutes } from '../src/routes/callback-propose-person-memory-routes.js';
import { registerCallbackProposeProfileUpdateRoutes } from '../src/routes/callback-propose-profile-update-routes.js';
import { callbackProposeTasteRoutes } from '../src/routes/callback-propose-taste-routes.js';
import { registerCallbackRecordProactiveMemoryAbstentionRoutes } from '../src/routes/callback-record-proactive-memory-abstention-routes.js';
import { registerCallbackRememberRoutes } from '../src/routes/callback-remember-routes.js';
import { registerCallbackMatterMemoryRoutes } from '../src/routes/memory-matter-routes.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

let redis;
before(async () => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'remember original routes');
  redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `remember:${randomUUID()}:` });
  await redis.ping();
});
after(async () => {
  await cleanupClientKeyspace(redis);
  await redis.quit();
});

test('remember uses all eight original submit routes, original publication and native deduplication', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-original-'));
  const owner = randomUUID(),
    registry = new InvocationRegistry(),
    messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create(owner, '薄入口真实提交');
  const text = '林岚负责终端研发。请保留具体背景，让设计一眼能看懂。';
  const source = messages.append({
    from: { kind: 'user', userId: owner },
    userId: owner,
    threadId: thread.id,
    content: text,
    mentions: [],
    timestamp: Date.now(),
  });
  const auth = await registry.create(owner, 'codex-astra', thread.id, undefined, undefined, undefined, source.id);
  const profile = new InMemoryProfileUpdateProposalStore(),
    taste = new InMemoryTasteProposalStore(),
    entity = new InMemoryEntityProposalStore();
  const person = new RedisPersonMemoryStore(redis),
    deferred = new RedisDeferredPersonMemoryReceiptStore(redis);
  const evidence = new SqliteEvidenceStore(join(directory, 'entities.sqlite'));
  await evidence.initialize();
  const db = new Database(':memory:');
  applyMigrations(db);
  const events = new EventMemoryStore(':memory:');
  await events.initialize();
  const corrections = new InMemoryEventMemoryCorrectionProposalStore();
  const matters = new MatterMemoryService({ db, runWrite: (f) => f(), messageStore: messages, threadStore: threads });
  const repository = new FileProfileRepository({ dataDir: directory, relationshipKeyForCat: () => 'maine-coon' });
  const sockets = { broadcastToRoom() {}, emitToUser() {} };
  const ingress = new ApprovalIngress({ messageStore: messages, socketManager: sockets });
  const common = { registry, messageStore: messages, socketManager: sockets, approvalIngress: ingress };
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await evidence.close();
    events.db.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  registerCallbackAuthHook(app, registry);
  registerCallbackRememberRoutes(app, common);
  registerCallbackProposeProfileUpdateRoutes(app, { ...common, proposalStore: profile, repository });
  registerCallbackProposePersonMemoryRoutes(app, {
    ...common,
    store: person,
    workspacePersonResolver: new EvidenceStoreWorkspacePersonResolver(evidence),
  });
  registerCallbackMatterMemoryRoutes(app, matters);
  registerCallbackRecordProactiveMemoryAbstentionRoutes(app, { registry });
  registerCallbackDeferPersonMemoryRoutes(app, {
    ...common,
    receiptStore: deferred,
    registryResolver: new ProactiveCandidateRegistryResolver({
      entityRegistry: new EntityRegistryStore(evidence.getDb()),
      entityProposalStore: entity,
      personMemoryStore: person,
    }),
  });
  await app.register(callbackProposeTasteRoutes, { ...common, tasteProposalStore: taste });
  await app.register(callbackProposeEntityRoutes, { ...common, entityProposalStore: entity });
  await app.register(callbackProposeEventMemoryCorrectionRoutes, {
    ...common,
    eventMemoryStore: events,
    proposalStore: corrections,
    sourceReaders: { threadStore: threads, messageStore: messages },
  });
  const submit = (clientRequestId, items) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/remember',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { clientRequestId, items },
    });
  const groupOne = [
    {
      itemId: 'profile',
      target: 'profile',
      payload: {
        afterContent: '共同工作时先讲具体背景。',
        rationale: '本次明确表达',
        signalKind: 'cvo-instructed',
        targetLayer: 'capsule',
      },
    },
    {
      itemId: 'taste',
      target: 'taste',
      payload: {
        scene: '讨论界面',
        quote: '让设计一眼能看懂',
        tags: ['设计'],
        dimension: 'visual-quality',
        privacy: 'sensitive',
      },
    },
    {
      itemId: 'entity',
      target: 'entity',
      payload: {
        entityId: 'concept:薄入口',
        entityType: 'concept',
        canonicalName: '薄入口',
        aliases: ['薄入口'],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        provenance: [{ source: 'thread', anchor: `${thread.id}#${source.id}` }],
        rationale: '便于后续找回',
      },
    },
    {
      itemId: 'matter',
      target: 'matter',
      payload: {
        operation: 'create',
        title: '设计讨论',
        sources: [
          { threadId: thread.id, messageId: source.id, segment: 'body', start: 0, end: text.length, quote: text },
        ],
      },
    },
  ];
  const firstResponse = await submit('four-originals', groupOne);
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = firstResponse.json();
  assert.deepEqual(
    first.results.map((r) => r.statusCode),
    [200, 200, 200, 201],
    JSON.stringify(first.results),
  );
  assert.equal((await profile.get(first.results[0].result.proposalId)).status, 'pending');
  assert.equal((await taste.get(first.results[1].result.proposalId)).status, 'pending');
  assert.equal((await entity.get(first.results[2].result.proposalId)).status, 'pending');
  assert.equal(repository.readCapsule(owner), null, 'Submitting profile is not approval');
  assert.equal(first.results[3].result.outcome, 'applied', 'Matter remains a direct write');
  assert.equal(
    (await messages.getById(first.messageId)).extra.rich.blocks[0].meta.memoryGroup.rows[3].resultRef,
    first.results[3].result.matter.matterId,
  );
  const repeated = (await submit('four-originals', groupOne)).json();
  assert.equal(repeated.groupId, first.groupId);
  assert.equal(repeated.messageId, first.messageId);
  assert.deepEqual(
    repeated.results.slice(0, 3).map((r) => r.result.proposalId),
    first.results.slice(0, 3).map((r) => r.result.proposalId),
  );
  assert.deepEqual(
    repeated.results[3].result,
    first.results[3].result,
    'Original Matter receipt is returned unchanged',
  );
  const event = events.markEvent(
    {
      type: 'scope_correction',
      trigger: 'human_brake',
      cat: 'codex-astra',
      threadId: thread.id,
      messageId: source.id,
      timestamp: Date.now(),
      summary: '需要更正的摘要',
      cognitiveTransition: 'scope_correction',
      relatedHarness: ['F332'],
      confidence: 'high',
    },
    owner,
  ).event;
  const secondResponse = await submit('person-event', [
    {
      itemId: 'person',
      target: 'person',
      payload: {
        person: { displayName: '林岚', privateAliases: ['林岚'] },
        claims: [
          {
            payload: { kind: 'reported_fact', predicate: '职责', value: '负责终端研发', assertedBy: 'owner' },
            normalizedDraft: '林岚负责终端研发',
            sourceRole: 'owner_explicit',
            evidenceExcerpt: '林岚负责终端研发',
          },
        ],
      },
    },
    {
      itemId: 'event',
      target: 'event_correction',
      payload: {
        eventId: event.eventId,
        expectedRevision: eventMemoryRevision(event),
        reason: 'unsupported_by_source',
        suggestedPatch: { summary: '请保留具体背景' },
      },
    },
    { itemId: 'abstain', target: 'person_abstain', payload: { reasonCode: 'bad_timing' } },
  ]);
  assert.equal(secondResponse.statusCode, 200, secondResponse.body);
  const second = secondResponse.json();
  assert.deepEqual(
    second.results.map((r) => r.statusCode),
    [200, 200, 200],
    JSON.stringify(second.results),
  );
  const candidate = await person.getCandidateForOwner(owner, second.results[0].result.candidateId);
  assert.equal((await corrections.get(second.results[1].result.proposalId)).status, 'pending');
  assert.equal(second.results[2].result.status, 'recorded');
  assert.equal(
    (await messages.getById(second.messageId)).extra.rich.blocks[0].meta.memoryGroup.rows[0].proposalId,
    candidate.candidateId,
  );
  // Seed the already-known person through the original approval transaction; defer still uses the original capture route.
  await person.approveDrafts({
    ownerUserId: owner,
    candidateId: candidate.candidateId,
    decisionId: 'owner-approve-person',
    selectedDraftIds: candidate.remainingDraftIds,
    authorizedAt: Date.now(),
  });
  const lastResponse = await submit('known-person-defer', [
    {
      itemId: 'defer',
      target: 'person_defer',
      payload: { subject: '林岚', sources: [{ kind: 'message', messageId: source.id }] },
    },
  ]);
  assert.equal(lastResponse.statusCode, 200, lastResponse.body);
  const last = lastResponse.json();
  assert.equal(last.results[0].statusCode, 200, JSON.stringify(last));
  assert.ok(await deferred.get(owner, last.results[0].result.receiptId));
});
