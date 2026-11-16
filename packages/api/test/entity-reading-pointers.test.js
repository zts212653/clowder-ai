import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { z } from 'zod';
import { rememberTools } from '../../mcp-server/dist/tools/remember-tool.js';
import { F260ApprovalAdapter } from '../dist/domains/approval-hub/adapters/F260ApprovalAdapter.js';
import { InMemoryEntityProposalStore } from '../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { readCanonicalProjectDocument } from '../dist/domains/memory/cue/sources/canonical-project-document.js';
import { EntityNudgeService } from '../dist/domains/memory/EntityNudgeService.js';
import { EntityRegistryStore } from '../dist/domains/memory/EntityRegistry.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { callbackProposeEntityRoutes } from '../dist/routes/callback-propose-entity-routes.js';
import { registerEntityProposalDecisionRoutes } from '../dist/routes/entity-proposal-decision-routes.js';

const pointer = {
  source: 'cat-proposed',
  sourcePath: 'docs/stories/shared-work.md',
  threadId: 'thread-origin',
  messageId: 'message-origin',
  note: '了解共同做作品的起因、分工与当时的限制',
};
const payload = {
  entityId: 'cat:reading-fixture',
  entityType: 'cat',
  canonicalName: '一起做作品的伙伴',
  aliases: ['小画家'],
  stance: 'unknown',
  visibilityScope: 'workspace',
  provenance: [pointer],
  rationale: '主人希望名字能带出可读的过往',
  clientRequestId: 'reading-pointer',
};

test('remember entity schema keeps authored reading coordinates and purpose', () => {
  const parsed = z
    .object(rememberTools[0].inputSchema)
    .parse({ items: [{ itemId: 'one', target: 'entity', payload }] });
  assert.deepEqual(parsed.items[0].payload.provenance, [pointer]);
});

test('original proposal, approval, registry and nudge retain a readable source and its purpose', async (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const entities = new EntityRegistryStore(db),
    proposals = new InMemoryEntityProposalStore();
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'opus', 'thread-current');
  const app = Fastify();
  const root = await mkdtemp(join(tmpdir(), 'entity-reading-'));
  t.after(async () => {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs/stories'), { recursive: true });
  const original = '我们一起做了作品。这里只记录当时的合作，不代表后续所有作品都沿用同一分工。';
  await writeFile(join(root, pointer.sourcePath), original);
  await app.register(callbackProposeEntityRoutes, {
    registry,
    entityProposalStore: proposals,
    socketManager: { emitToUser() {} },
    approvalIngress: {
      async validateOrigin() {},
      async publish(draft, store) {
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: 'F260',
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: 'thread-current', messageId: 'approval-card' },
          createdAt: draft.createdAt,
        };
        await store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    },
  });
  registerEntityProposalDecisionRoutes(app, {
    store: proposals,
    upsertEntities: (rows, context) => entities.upsert(rows, context),
    inspectEntityConflict: () => null,
    resolveEntityConflict: () => {
      throw new Error('unexpected conflict');
    },
    socketManager: { emitToUser() {} },
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const response = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', headers, payload });
  assert.equal(response.statusCode, 200, response.body);
  const { proposalId } = response.json();
  assert.equal(entities.get(payload.entityId), null, 'proposal is not an approved registry entry');
  assert.deepEqual(proposals.get(proposalId).provenance, [pointer]);
  const adapter = new F260ApprovalAdapter(proposals);
  const pending = await adapter.listPending('owner');
  assert.deepEqual(pending[0].detail.provenance, [pointer], 'the owner sees the reading pointer before approving');
  const foreign = await app.inject({
    method: 'POST',
    url: `/api/entity-proposals/${proposalId}/approve`,
    headers: { 'x-cat-cafe-user': 'another-owner' },
  });
  assert.equal(foreign.statusCode, 403);
  const approved = await app.inject({
    method: 'POST',
    url: `/api/entity-proposals/${proposalId}/approve`,
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(entities.get(payload.entityId).provenance[0], pointer);
  const service = new EntityNudgeService(db);
  db.prepare('UPDATE entity_aliases SET provenance_json = ? WHERE entity_id = ?').run(
    JSON.stringify([
      { source: 'legacy-alias', sourcePath: 'docs/stories/wrong.md', note: 'unversioned alias history' },
    ]),
    payload.entityId,
  );
  const candidates = service.detectCandidates({
    text: '想起小画家一起做作品的时候',
    threadId: 'thread-next',
    ownerUserId: 'owner',
  });
  const presentation = service.preparePresentation(candidates, {
    catId: 'opus',
    invocationId: 'next-invocation',
    sourceMessageId: 'next-message',
  });
  assert.match(presentation.promptContext, /了解共同做作品的起因、分工与当时的限制/);
  assert.match(presentation.promptContext, /docs\/stories\/shared-work\.md/);
  assert.doesNotMatch(
    presentation.promptContext,
    /wrong\.md|unversioned alias history/,
    'the rendered pointer must belong to the registry revision',
  );
  assert.ok(
    !presentation.promptContext.includes(original),
    'the nudge is a reading pointer, not injected source content',
  );
  const pointed = presentation.result.nudges[0].provenance[0];
  const read = await readCanonicalProjectDocument(root, pointed.sourcePath);
  assert.equal(read.content, original);
  assert.equal(
    await readCanonicalProjectDocument(root, '../outside.md'),
    null,
    'a pointer does not widen the source reader',
  );
  await rm(join(root, pointer.sourcePath));
  assert.equal(await readCanonicalProjectDocument(root, pointed.sourcePath), null, 'missing source stays unavailable');
  entities.upsert([{ ...entities.get(payload.entityId), status: 'retired' }], {
    source: 'owner-action',
    actorId: 'owner',
    reason: 'retire fixture',
    conflictPolicy: 'allow-update',
  });
  assert.equal(presentation.isCurrent(), false);
  assert.throws(() => presentation.confirmAssembled(), /source_changed/);
  assert.equal(
    service.preparePresentation(candidates, { catId: 'opus', invocationId: 'later', sourceMessageId: 'later-message' })
      .result.nudges.length,
    0,
  );
});
