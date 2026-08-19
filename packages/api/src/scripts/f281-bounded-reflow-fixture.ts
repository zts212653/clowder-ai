import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRedisClient, type RedisClient } from '@cat-cafe/shared/utils';
import { HumanDispositionFeedbackContextService } from '../domains/human-disposition/HumanDispositionFeedbackContextService.js';
import { HumanDispositionLedger } from '../domains/human-disposition/HumanDispositionLedger.js';
import { HumanDispositionKeys } from '../domains/human-disposition/human-disposition-keys.js';
import { ProactiveCandidateRegistryResolver } from '../domains/memory/ProactiveCandidateRegistryResolver.js';
import { PersonMemoryDispositionProofResolver } from '../domains/memory/people/PersonMemoryDispositionProofResolver.js';
import { PersonMemoryDispositionSubjectProofResolver } from '../domains/memory/people/PersonMemoryDispositionSubjectProofResolver.js';
import { PersonMemoryKeys } from '../domains/memory/people/person-memory-keys.js';
import { RedisPersonMemoryStore } from '../domains/memory/people/RedisPersonMemoryStore.js';
import {
  candidateInput,
  capturePrompts,
  cleanupFixtureKeys,
  envelopeFor,
  F281_FIXTURE_KEY_PREFIX,
  feedbackBlock,
  groupedProofBytes,
  keyDumps,
  materializePerson,
  requireIsolatedRedis,
  sha256,
  stageAndAnchor,
} from './f281-bounded-reflow-fixture-support.js';

const OWNER = 'f281-fixture-owner';
const OTHER_OWNER = 'f281-fixture-other-owner';
const FORBIDDEN_PROMPT_TOKENS = /(acceptance|score|global[_ -]?policy|接受率|评分|全局策略)/i;

async function runFixture(redis: RedisClient): Promise<Record<string, unknown>> {
  const store = new RedisPersonMemoryStore(redis);
  const primaryPersonId = await materializePerson(
    store,
    'person_candidate_f281_fixture_person',
    '周女士',
    OWNER,
    1_000,
  );

  const deterministicStore = new RedisPersonMemoryStore(redis, {
    humanDispositionRandomBytesSource: groupedProofBytes([7, 8, 10]),
  });
  const root = candidateInput({
    candidateId: 'person_candidate_f281_fixture_root',
    displayName: '周玉晶',
    ownerUserId: OWNER,
    targetPersonId: primaryPersonId,
    createdAt: 2_000,
  });
  const anchoredRoot = await stageAndAnchor(deterministicStore, root);
  assert.ok(anchoredRoot.dispositionLineageBindingKey);
  const rootBindingRaw = await redis.get(anchoredRoot.dispositionLineageBindingKey);
  assert.ok(rootBindingRaw);
  const rootBinding = JSON.parse(rootBindingRaw) as Record<string, string>;

  const successor = candidateInput({
    candidateId: 'person_candidate_f281_fixture_successor',
    displayName: '周玉晶',
    ownerUserId: OWNER,
    targetPersonId: primaryPersonId,
    replacesProposalId: root.candidateId,
    createdAt: 2_001,
  });
  const anchoredSuccessor = await stageAndAnchor(deterministicStore, successor);
  assert.equal(anchoredSuccessor.dispositionLineageBindingKey, anchoredRoot.dispositionLineageBindingKey);
  const successorBindingRaw = await redis.get(anchoredRoot.dispositionLineageBindingKey);
  assert.ok(successorBindingRaw);
  const successorBinding = JSON.parse(successorBindingRaw) as Record<string, string>;
  assert.equal(successorBinding.opaqueLineageHandle, rootBinding.opaqueLineageHandle);
  assert.notEqual(successorBinding.currentOpaqueSupersessionHandle, rootBinding.currentOpaqueSupersessionHandle);

  const collision = candidateInput({
    candidateId: 'person_candidate_f281_fixture_collision',
    displayName: 'Alden',
    ownerUserId: OWNER,
    targetPersonId: primaryPersonId,
    createdAt: 2_002,
  });
  await deterministicStore.stageCandidate(collision);
  const collisionKey = PersonMemoryKeys.candidate(OWNER, collision.candidateId);
  const collisionBindingKey = PersonMemoryKeys.dispositionLineageBinding(OWNER, collision.candidateId);
  const beforeCollision = await keyDumps(redis, [
    collisionKey,
    collisionBindingKey,
    HumanDispositionKeys.receipts(OWNER),
    HumanDispositionKeys.episodes(OWNER),
  ]);
  const collisionStore = new RedisPersonMemoryStore(redis, {
    humanDispositionRandomBytesSource: groupedProofBytes([7]),
  });
  await assert.rejects(
    () => collisionStore.commitEnvelope(collision.candidateId, envelopeFor(collision)),
    /collision retry exhausted/,
  );
  assert.deepEqual(
    await keyDumps(redis, [
      collisionKey,
      collisionBindingKey,
      HumanDispositionKeys.receipts(OWNER),
      HumanDispositionKeys.episodes(OWNER),
    ]),
    beforeCollision,
  );
  const retryStore = new RedisPersonMemoryStore(redis, {
    humanDispositionRandomBytesSource: groupedProofBytes([9]),
  });
  await retryStore.commitEnvelope(collision.candidateId, envelopeFor(collision));
  const collisionAnchored = await retryStore.getCandidateForOwner(OWNER, collision.candidateId);
  assert.ok(collisionAnchored?.dispositionLineageBindingKey);
  const collisionBindingRaw = await redis.get(collisionAnchored.dispositionLineageBindingKey);
  assert.ok(collisionBindingRaw);
  const collisionBinding = JSON.parse(collisionBindingRaw) as Record<string, string>;
  assert.notEqual(collisionBinding.opaqueLineageHandle, successorBinding.opaqueLineageHandle);

  const unboundRoot = candidateInput({
    candidateId: 'person_candidate_f281_fixture_unbound',
    displayName: '未绑定链',
    ownerUserId: OWNER,
    createdAt: 3_000,
  });
  await stageAndAnchor(store, unboundRoot);
  const unboundSuccessor = candidateInput({
    candidateId: 'person_candidate_f281_fixture_unbound_successor',
    displayName: '未绑定链',
    ownerUserId: OWNER,
    targetPersonId: primaryPersonId,
    replacesProposalId: unboundRoot.candidateId,
    createdAt: 3_001,
  });
  const mixedAnchored = await stageAndAnchor(store, unboundSuccessor);
  const mixedRejected = await store.rejectCandidate({
    ownerUserId: OWNER,
    candidateId: unboundSuccessor.candidateId,
    decisionId: 'decision_f281_fixture_unbound',
    feedback: { reasonCode: 'wrong' },
    decidedAt: 3_100,
  });
  assert.equal(mixedRejected.outcome, 'applied');
  assert.equal(mixedAnchored.dispositionLineageBindingKey, undefined);
  assert.equal(mixedRejected.candidate.humanDispositionLedgerEntry, undefined);

  const otherPersonId = await materializePerson(
    store,
    'person_candidate_f281_fixture_other_person',
    '第二联系人',
    OWNER,
    3_200,
  );
  const differentRoot = candidateInput({
    candidateId: 'person_candidate_f281_fixture_different_root',
    displayName: '跨人链',
    ownerUserId: OWNER,
    targetPersonId: primaryPersonId,
    createdAt: 3_300,
  });
  await stageAndAnchor(store, differentRoot);
  const differentSuccessor = candidateInput({
    candidateId: 'person_candidate_f281_fixture_different_successor',
    displayName: '跨人链',
    ownerUserId: OWNER,
    targetPersonId: otherPersonId,
    replacesProposalId: differentRoot.candidateId,
    createdAt: 3_301,
  });
  const differentAnchored = await stageAndAnchor(store, differentSuccessor);
  const differentRejected = await store.rejectCandidate({
    ownerUserId: OWNER,
    candidateId: differentSuccessor.candidateId,
    decisionId: 'decision_f281_fixture_different',
    feedback: { reasonCode: 'wrong' },
    decidedAt: 3_400,
  });
  assert.equal(differentRejected.outcome, 'applied');
  assert.equal(differentAnchored.dispositionLineageBindingKey, undefined);
  assert.equal(differentRejected.candidate.humanDispositionLedgerEntry, undefined);

  const rejected = await deterministicStore.rejectCandidate({
    ownerUserId: OWNER,
    candidateId: successor.candidateId,
    decisionId: 'decision_f281_fixture_main',
    feedback: { reasonCode: 'bad_evidence' },
    decidedAt: 4_000,
  });
  assert.equal(rejected.outcome, 'applied');
  assert.ok(rejected.candidate.humanDispositionLedgerEntry);
  const entry = rejected.candidate.humanDispositionLedgerEntry;
  const receiptRaw = await redis.hget(HumanDispositionKeys.receipts(OWNER), entry.episode.sourceRef);
  assert.ok(receiptRaw);
  const ledger = new HumanDispositionLedger(redis, new PersonMemoryDispositionProofResolver(redis));
  const queried = await ledger.query(OWNER, {
    subjectRef: entry.episode.subjectRef,
    interactionKind: 'person_memory_proposal',
    limit: 10,
  });
  assert.equal(queried.entries.length, 1);
  assert.equal(await ledger.get(OTHER_OWNER, entry.episode.sourceRef), null);

  const registry = new ProactiveCandidateRegistryResolver({
    entityRegistry: { resolveExactAlias: () => [] },
    entityProposalStore: {
      listPending: async () => [],
      listSettledByUser: async () => [],
    },
    personMemoryStore: store,
  });
  const proofResolver = new PersonMemoryDispositionProofResolver(redis);
  const contextService = new HumanDispositionFeedbackContextService({
    subjectResolver: new PersonMemoryDispositionSubjectProofResolver(registry, store, proofResolver),
    ledger,
  });
  const exactPrompts = await capturePrompts(contextService, '周玉晶', OWNER);
  const otherPrompts = await capturePrompts(contextService, 'Alden', OWNER);
  const exactBlock = feedbackBlock(exactPrompts.serial);
  assert.ok(exactBlock.includes('reason=bad_evidence'));
  assert.equal(feedbackBlock(otherPrompts.serial), '');
  assert.ok(exactPrompts.parallel.every((prompt) => feedbackBlock(prompt) === exactBlock));
  assert.equal(FORBIDDEN_PROMPT_TOKENS.test(exactBlock), false);

  const bindingKey = rejected.candidate.dispositionLineageBindingKey;
  assert.ok(bindingKey);
  const finalBindingRaw = await redis.get(bindingKey);
  assert.ok(finalBindingRaw);
  const finalBinding = JSON.parse(finalBindingRaw) as Record<string, string>;
  const lineageLocatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(OWNER, finalBinding.opaqueLineageHandle);
  const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(OWNER, entry.episode.sourceRef);
  const receiptHasProducerPayload = [
    root.candidateId,
    successor.candidateId,
    primaryPersonId,
    'bad_evidence',
    '周玉晶',
  ].some((token) => receiptRaw.includes(token));
  assert.equal(receiptHasProducerPayload, false);
  const durableTtls = await Promise.all([
    redis.ttl(HumanDispositionKeys.receipts(OWNER)),
    redis.ttl(HumanDispositionKeys.episodes(OWNER)),
    redis.ttl(HumanDispositionKeys.subject(OWNER, entry.episode.subjectRef)),
  ]);
  assert.deepEqual(durableTtls, [-1, -1, -1]);

  const deletion = await store.hardForget({
    ownerUserId: OWNER,
    personId: primaryPersonId,
    requestId: 'person_forget_f281_fixture',
    requestedAt: 5_000,
  });
  assert.equal(deletion.verdict, 'purged');
  assert.equal(await redis.get(bindingKey), null);
  assert.equal(await redis.get(lineageLocatorKey), null);
  assert.equal(await redis.get(decisionLocatorKey), null);
  assert.equal(await ledger.get(OWNER, entry.episode.sourceRef), null);
  assert.equal(await store.getCandidateForOwner(OWNER, root.candidateId), null);
  assert.equal(await store.getCandidateForOwner(OWNER, successor.candidateId), null);
  assert.equal(await store.getCandidateForOwner(OWNER, collision.candidateId), null);
  assert.equal(await contextService.prepare({ ownerUserId: OWNER, text: '周玉晶' }), '');
  const serializedDeletion = JSON.stringify(deletion);
  assert.equal(
    [root.candidateId, successor.candidateId, primaryPersonId, '周玉晶', 'bad_evidence'].some((token) =>
      serializedDeletion.includes(token),
    ),
    false,
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    redis: {
      endpoint: 'redis://127.0.0.1:6398/15',
      fixturePrefix: F281_FIXTURE_KEY_PREFIX,
      receiptsTtl: durableTtls[0],
      episodesTtl: durableTtls[1],
      subjectTtl: durableTtls[2],
    },
    lineage: {
      replacementReusedOpaqueRoot: successorBinding.opaqueLineageHandle === rootBinding.opaqueLineageHandle,
      replacementRotatedSupersession:
        successorBinding.currentOpaqueSupersessionHandle !== rootBinding.currentOpaqueSupersessionHandle,
      forcedCollisionFirstAttemptZeroWrite: true,
      forcedCollisionRetryUsedDifferentRoot:
        collisionBinding.opaqueLineageHandle !== successorBinding.opaqueLineageHandle,
      subjectIndexesAreDistinct:
        HumanDispositionKeys.subject(OWNER, collisionBinding.opaqueLineageHandle) !==
        HumanDispositionKeys.subject(OWNER, successorBinding.opaqueLineageHandle),
    },
    exclusions: {
      unboundRootToBoundSuccessorPhaseCEntry: false,
      differentPersonAncestorPhaseCEntry: false,
      otherSubjectContextInjected: false,
      crossOwnerEntryVisible: false,
    },
    ledger: {
      hydratedEntries: queried.entries.length,
      exactFeedback: queried.entries[0]?.episode.feedback?.reasonCode ?? null,
      receiptFields: Object.keys(JSON.parse(receiptRaw)).sort(),
      receiptContainsProducerPayload: receiptHasProducerPayload,
    },
    prompts: {
      serialExactSha256: sha256(exactPrompts.serial),
      serialExactFeedbackBlock: exactBlock,
      serialOtherSha256: sha256(otherPrompts.serial),
      serialOtherFeedbackBlock: feedbackBlock(otherPrompts.serial),
      parallelExactSha256: exactPrompts.parallel.map(sha256),
      parallelBlocksEqual: exactPrompts.parallel.every((prompt) => feedbackBlock(prompt) === exactBlock),
      forbiddenScoreOrGlobalPolicyTokens: FORBIDDEN_PROMPT_TOKENS.test(exactBlock),
    },
    hardForget: {
      verdict: deletion.verdict,
      mainCandidatesRemoved: true,
      lineageBindingRemoved: true,
      lineageLocatorRemoved: true,
      decisionLocatorRemoved: true,
      ledgerEntryRemoved: true,
      contextRemoved: true,
      deletionReceiptContentFree: true,
    },
  };
}

async function main(): Promise<void> {
  const redisUrl = requireIsolatedRedis();
  const admin = createRedisClient({ url: redisUrl, keyPrefix: '' });
  const redis = createRedisClient({ url: redisUrl, keyPrefix: F281_FIXTURE_KEY_PREFIX });
  let evidence: Record<string, unknown> | undefined;
  let cleanupDeletedKeys = 0;
  try {
    await Promise.all([admin.ping(), redis.ping()]);
    await cleanupFixtureKeys(admin);
    evidence = await runFixture(redis);
  } finally {
    cleanupDeletedKeys = await cleanupFixtureKeys(admin);
    await Promise.allSettled([redis.quit(), admin.quit()]);
  }
  if (!evidence) throw new Error('fixture produced no evidence');
  evidence.redis = {
    ...(evidence.redis as Record<string, unknown>),
    cleanupDeletedKeys,
    liveRuntimeRestarted: false,
  };
  const outputDir = resolve(process.cwd(), '../../docs/evidence/F281/phase-c');
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'bounded-reflow.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

await main();
