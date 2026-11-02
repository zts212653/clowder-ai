import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createMemoryCueTools } from '../../../mcp-server/dist/tools/memory-cue-tools.js';
import { buildActionSuccessorFence } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { claimActionSuccessor } from '../../dist/domains/ball-custody/action-successor-state-machine.js';
import { prepareProviderPresentationAttempt } from '../../dist/domains/cats/services/agents/invocation/provider-presentation-delivery.js';
import { FileProfileRepository } from '../../dist/domains/cats/services/profile/ProfileRepository.js';
import { ContextEpochOwner } from '../../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { mapToPresentation } from '../../dist/domains/cats/services/session/context/context-presentation.js';
import { mintDeliveryReceipt } from '../../dist/domains/cats/services/session/context/delivery-receipt.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/context/PresentationLedger.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ContextSourceOpportunityStore } from '../../dist/domains/memory/cue/ContextSourceOpportunityStore.js';
import { createMemoryCueRuntime } from '../../dist/domains/memory/cue/createMemoryCueRuntime.js';
import { MemoryCueDrillHandleService } from '../../dist/domains/memory/cue/MemoryCueDrillHandleService.js';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { registerCallbackMemoryCueRoutes } from '../../dist/routes/callback-memory-cue-routes.js';

test('a fresh authorized Task presents and drills the same primer dismissed in the prior epoch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f321-a2a-presentation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new FileProfileRepository({ dataDir: root, relationshipKeyForCat: () => 'relationship' });
  const path = repository.primerPath(repository.scope('owner', 'cat'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Approved current form of address: paper companion.');
  const revision = repository.readPrimer(repository.scope('owner', 'cat')).revision;
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const episodes = new MemoryCueEpisodeStore(db);
  const opportunities = new ContextSourceOpportunityStore(db);
  const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), episodes);
  const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'consumer' };
  const task = { id: 'task', ownerCatId: 'cat', threadId: 'thread', userId: 'owner', status: 'doing', updatedAt: 1 };
  const lease = claimActionSuccessor(null, {
    leaseId: 'lease',
    tenantScope: 'owner',
    subjectRef: 'subject:task:task',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['cat'],
    holderThreadId: 'thread',
    dispatchId: 'dispatch',
    claimOrigin: 'structured_transfer',
    predecessorCatId: 'sender',
    predecessorThreadId: 'thread',
    issuerStandingEvidenceRef: 'message:source',
    evidenceRefs: ['message:source'],
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task',
      predicate: { kind: 'task_done' },
    }),
    now: Date.now(),
  }).lease;
  lease.dispatchDeliveredMessageId = 'source';
  const runtime = createMemoryCueRuntime({
    ownerUserId: 'owner',
    episodeStore: episodes,
    handles,
    contextSourceOpportunityStore: opportunities,
    messageStore: {
      getById: async () => ({
        id: 'source',
        userId: 'owner',
        threadId: 'thread',
        catId: 'sender',
        from: { kind: 'agent', catId: 'sender' },
        content: 'Continue the entrusted work.',
      }),
    },
    contextSourceAuthorization: {
      threads: { get: async () => ({ id: 'thread', createdBy: 'owner', projectPath: '/project' }) },
      tasks: { get: async () => task, listByThread: async () => [task] },
      leases: { get: async () => lease },
    },
    profileRepository: repository,
    evidenceStore: { getByAnchor: async () => null },
    eventStore: {},
    entityRegistry: {},
    tasteRepository: {},
    projectDocsRoot: root,
    autoDreamStore: {},
  });
  const epochStore = new InMemoryContextEpochStore();
  const owner = new ContextEpochOwner(epochStore);
  const identity = { userId: 'owner', catId: 'cat', threadId: 'thread' };
  const fresh = (runtimeSessionId) => ({
    state: 'fresh',
    reason: 'no_prior_session',
    runtimeSessionId,
    evidenceRef: runtimeSessionId,
  });
  const previous = await owner.resolve({ ...identity, disposition: fresh('previous-native') });
  const ledger = new PresentationLedger(new InMemoryPresentationLedgerStore(epochStore));
  const anchor = 'profile:primer:relationship:cat';
  const candidate = {
    subjectKey: `memory-cue:profile:${anchor}:consumer:cat`,
    asOf: { kind: 'version', value: revision },
    sourceTier: 'T2',
    requested: 'pointer',
    epistemicCeiling: 'pointer',
  };
  const reserved = await ledger.reserve(mapToPresentation(candidate), previous, { promptGenerationId: 'old-prompt' });
  assert.equal(reserved.admitted, true);
  await ledger.commit(
    reserved.reservation,
    mintDeliveryReceipt({
      promptGenerationId: 'old-prompt',
      providerReceivedAt: Date.now(),
      providerAdapterId: 'isolated-test-adapter',
    }),
  );
  for (const outcome of ['presented', 'dismissed'])
    episodes.append({
      eventId: `old-${outcome}`,
      idempotencyKey: `old-${outcome}`,
      cueId: 'old-cue',
      opportunityId: 'old-opportunity',
      scope: { ...scope, invocationId: 'old-consumer' },
      consumerCatId: 'cat',
      resolverFamily: 'profile',
      sourceAnchor: anchor,
      sourceRevision: revision,
      axis: 'consumption',
      consumptionOutcome: outcome,
      catalogVersion: 7,
      resolverVersion: 2,
      occurredAt: Date.now(),
    });
  const decision = await owner.resolve({ ...identity, disposition: fresh('new-native') });
  assert.equal(decision.contextEpoch, previous.contextEpoch + 1);
  const original = buildActionSuccessorFence(lease, 'dispatch');
  const actionSuccessorFence = {
    dispatchId: original.dispatchId,
    generation: original.generation,
    leaseId: original.leaseId,
    invocationLineageRef: original.invocationLineageRef,
    terminalPredicateDigest: original.terminalPredicateDigest,
  };
  const seed = await runtime.contextSourceAdmission.prepare({
    scope,
    consumerCatId: 'cat',
    ownerAuthProvenance: 'strict',
    exactSourceMessageId: 'source',
    ingress: { kind: 'queue_agent', sourceMessageId: 'source', actionSuccessorFence },
    decision: { ...decision, normalizedDisposition: fresh('new-native') },
    now: Date.now(),
  });
  assert.equal(seed?.kind, 'authorized_task_sources');
  const resolved = await runtime.promptService.resolve({
    seeds: [seed],
    serverScope: scope,
    consumerCatId: 'cat',
    now: Date.now(),
  });
  assert.equal(resolved.presentationEnvelopes.length, 1);
  const attempt = await prepareProviderPresentationAttempt({
    envelopes: resolved.presentationEnvelopes,
    ledger,
    scope: decision,
    opportunityContext: { ...scope, consumerCatId: 'cat', surface: 'dynamic_context', now: Date.now() },
    buildEffectivePrompt: (segments) => ['Continue the task.', ...segments].join('\n'),
  });
  assert.equal(attempt.admitted.length, 1, 'the final source fence must preserve a semantically identical Task proof');
  assert.doesNotMatch(attempt.effectivePrompt, /paper companion/);
  const displayedHandle = attempt.effectivePrompt.match(/^Handle: (.+)$/m)?.[1];
  assert.ok(displayedHandle);
  const receipt = mintDeliveryReceipt({
    promptGenerationId: attempt.promptGenerationId,
    providerReceivedAt: Date.now(),
    providerAdapterId: 'isolated-test-adapter',
  });
  const commits = await attempt.confirm(receipt);
  assert.ok(commits.every((commit) => commit.outcome.committed));
  await runtime.promptService.recordPresented(
    commits.map((commit) => commit.envelope.receipt),
    {
      generationId: receipt.promptGenerationId,
      evidenceRef: 'isolated-test-provider-received',
    },
  );
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('callbackAuth', undefined);
  app.addHook('preHandler', async (request) => {
    request.callbackAuth = {
      ...scope,
      userId: 'owner',
      catId: 'cat',
      callbackToken: 'test',
      clientMessageIds: new Set(),
      createdAt: 0,
      expiresAt: Date.now() + 10000,
    };
  });
  registerCallbackMemoryCueRoutes(app, {
    episodeStore: episodes,
    handles,
    sourceReader: runtime.sourceReader,
    now: Date.now,
  });
  const statuses = [];
  const tools = createMemoryCueTools(async (url, payload) => {
    const response = await app.inject({ method: 'POST', url, payload });
    statuses.push(response.statusCode);
    return { content: [{ type: 'text', text: response.body }] };
  });
  const drilled = await tools.handleDrillMemoryCue({ handle: displayedHandle, clientRequestId: 'drill' });
  assert.match(drilled.content[0].text, /paper companion/);
  await tools.handleRecordMemoryCueOutcome({ handle: displayedHandle, outcome: 'applied', clientRequestId: 'outcome' });
  assert.deepEqual(statuses, [200, 200]);
  assert.deepEqual(
    episodes.listByCue('owner', resolved.deliveryReceipts[0].cueId).map((event) => event.consumptionOutcome),
    ['presented', 'drilled', 'applied'],
  );
  assert.equal(opportunities.find(decision.scopeKey, decision.contextEpoch, 'source', 'cat').committed, true);
  const read = {
    opportunityId: resolved.admittedOpportunityIds[0],
    family: 'profile',
    anchor,
    expectedRevision: revision,
    scope,
    consumerCatId: 'cat',
  };
  writeFileSync(path, 'A corrected source.');
  assert.deepEqual(await runtime.sourceReader.read(read), {
    status: 'not_available',
    invalidationReason: 'source_corrected',
  });
  lease.status = 'completed';
  assert.deepEqual(await runtime.sourceReader.read(read), {
    status: 'not_available',
    invalidationReason: 'scope_revoked',
  });
});
