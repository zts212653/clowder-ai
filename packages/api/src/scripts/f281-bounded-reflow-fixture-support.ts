import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  type ApprovalEnvelope,
  candidateClaimDraftIdSchema,
  captureCandidateIdSchema,
  catRegistry,
  createCatId,
  type PersonId,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import type { RouteStrategyDeps } from '../domains/cats/services/agents/routing/route-helpers.js';
import { routeParallel } from '../domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../domains/cats/services/agents/routing/route-serial.js';
import type { AgentService } from '../domains/cats/services/types.js';
import type { HumanDispositionFeedbackContextService } from '../domains/human-disposition/HumanDispositionFeedbackContextService.js';
import type {
  StagePersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from '../domains/memory/people/PersonMemoryStore.js';
import type { RedisPersonMemoryStore } from '../domains/memory/people/RedisPersonMemoryStore.js';

export const F281_FIXTURE_KEY_PREFIX = 'cat-cafe-f281-bounded-reflow-fixture:';

export function requireIsolatedRedis(): string {
  const redisUrl = process.env.REDIS_URL;
  if (process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1') {
    throw new Error('fixture requires CAT_CAFE_REDIS_TEST_ISOLATED=1');
  }
  if (redisUrl !== 'redis://127.0.0.1:6398/15') {
    throw new Error('fixture requires exact REDIS_URL=redis://127.0.0.1:6398/15');
  }
  return redisUrl;
}

export async function cleanupFixtureKeys(admin: RedisClient): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await admin.scan(cursor, 'MATCH', `${F281_FIXTURE_KEY_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (keys.some((key) => !key.startsWith(F281_FIXTURE_KEY_PREFIX))) {
      throw new Error('fixture cleanup resolved a key outside its exact prefix');
    }
    const [firstKey, ...remainingKeys] = keys;
    if (firstKey !== undefined) removed += await admin.unlink(firstKey, ...remainingKeys);
  } while (cursor !== '0');
  return removed;
}

export async function keyDumps(redis: RedisClient, keys: string[]): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await redis.dump(key)] as const)));
}

export function feedbackBlock(prompt: string): string {
  return prompt.match(/\[human-disposition-feedback\][\s\S]*?\[\/human-disposition-feedback\]/)?.[0] ?? '';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function candidateInput(input: {
  candidateId: string;
  displayName: string;
  ownerUserId: string;
  createdAt: number;
  targetPersonId?: PersonId;
  replacesProposalId?: string;
}): StagePersonMemoryCandidateInput {
  const candidateId = captureCandidateIdSchema.parse(input.candidateId);
  const draftId = candidateClaimDraftIdSchema.parse(`person_draft_${input.candidateId.slice(17)}`);
  const sourceMessageRef = {
    kind: 'message' as const,
    threadId: 'thread_f281_fixture',
    messageId: `msg_${input.candidateId}`,
  };
  const claimDraft = {
    draftId,
    payload: {
      kind: 'reported_fact' as const,
      predicate: 'fixture_note',
      value: `${input.displayName} fixture evidence`,
      assertedBy: 'owner' as const,
    },
    normalizedDraft: `${input.displayName} fixture evidence`,
    sourceRole: 'owner_explicit' as const,
    evidenceExcerpt: `${input.displayName} fixture evidence`,
    decision: 'pending' as const,
  };
  return {
    candidateId,
    ownerUserId: input.ownerUserId,
    requesterCatId: createCatId('codex-sol'),
    sourceMessageRef,
    personDraft: {
      displayName: input.displayName,
      privateAliases: [input.displayName],
    },
    ...(input.targetPersonId ? { targetPersonId: input.targetPersonId } : {}),
    ...(input.replacesProposalId
      ? { replacesProposalId: captureCandidateIdSchema.parse(input.replacesProposalId) }
      : {}),
    claimDrafts: [claimDraft],
    sourceBundle: {
      sources: [
        {
          sourceId: `source-${draftId}`,
          kind: 'message_text',
          sourceRef: sourceMessageRef,
          ownerUserId: input.ownerUserId,
          resolvedDigest: 'a'.repeat(64),
          excerpt: claimDraft.evidenceExcerpt,
        },
      ],
      assertionBindings: [
        {
          sourceId: `source-${draftId}`,
          target: { kind: 'claim', draftId },
          role: 'reported_fact',
        },
      ],
    },
    remainingDraftIds: [draftId],
    retention: 'owner_controlled_no_ttl',
    createdAt: input.createdAt,
  };
}

export function envelopeFor(input: StagePersonMemoryCandidateInput): ApprovalEnvelope {
  return {
    canonicalProposalId: input.candidateId,
    sourceFeatureId: 'F276',
    ownerUserId: input.ownerUserId,
    requesterCatId: input.requesterCatId,
    originRef: {
      kind: 'message',
      threadId: input.sourceMessageRef.threadId,
      messageId: input.sourceMessageRef.messageId,
    },
    approvalCardRef: {
      threadId: input.sourceMessageRef.threadId,
      messageId: `card_${input.candidateId}`,
    },
    createdAt: input.createdAt,
  };
}

export async function stageAndAnchor(
  store: RedisPersonMemoryStore,
  input: StagePersonMemoryCandidateInput,
): Promise<StoredPersonMemoryCandidate> {
  await store.stageCandidate(input);
  await store.commitEnvelope(input.candidateId, envelopeFor(input));
  const anchored = await store.getCandidateForOwner(input.ownerUserId, input.candidateId);
  if (!anchored) throw new Error('fixture candidate disappeared after anchor');
  return anchored;
}

export async function materializePerson(
  store: RedisPersonMemoryStore,
  candidateId: string,
  displayName: string,
  ownerUserId: string,
  createdAt: number,
): Promise<PersonId> {
  const seed = candidateInput({ candidateId, displayName, ownerUserId, createdAt });
  await stageAndAnchor(store, seed);
  const approved = await store.approveDrafts({
    ownerUserId,
    candidateId: seed.candidateId,
    selectedDraftIds: seed.remainingDraftIds,
    decisionId: `decision_${candidateId}`,
    authorizedAt: createdAt + 1,
  });
  assert.ok(approved.outcome === 'applied' || approved.outcome === 'replayed');
  return approved.receipt.personId;
}

export function groupedProofBytes(groups: number[]): (size: number) => Uint8Array {
  let calls = 0;
  return (size) => {
    const group = groups[Math.min(Math.floor(calls / 4), groups.length - 1)];
    calls += 1;
    return new Uint8Array(size).fill(group);
  };
}

function createCapturingService(catId: string, prompts: string[]): AgentService {
  return {
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'text', catId: createCatId(catId), content: 'fixture reply', timestamp: Date.now() };
      yield { type: 'done', catId: createCatId(catId), timestamp: Date.now() };
    },
  } as AgentService;
}

function routeDeps(
  feedbackService: HumanDispositionFeedbackContextService,
  services: Record<string, AgentService>,
): RouteStrategyDeps {
  let sequence = 0;
  const stored = new Map<string, { id: string; threadId: string }>();
  return {
    services,
    humanDispositionFeedbackContextService: feedbackService,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `fixture-inv-${++sequence}`, callbackToken: `fixture-token-${sequence}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/f281-fixture',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (message: { threadId?: string; [key: string]: unknown }) => {
        const result = { id: `fixture-message-${++sequence}`, threadId: message.threadId ?? 'fixture-thread' };
        stored.set(result.id, result);
        return { ...message, ...result };
      },
      getById: async (id: string) => stored.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  } as unknown as RouteStrategyDeps;
}

export async function capturePrompts(
  feedbackService: HumanDispositionFeedbackContextService,
  text: string,
  ownerUserId: string,
): Promise<{ serial: string; parallel: string[] }> {
  if (catRegistry.getAllIds().length === 0) {
    const templatePath = resolve(process.cwd(), '../../cat-template.json');
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(templatePath)))) {
      catRegistry.register(createCatId(id), config);
    }
  }
  const serialPrompts: string[] = [];
  const parallelPrompts: string[] = [];
  const serialDeps = routeDeps(feedbackService, {
    opus: createCapturingService('opus', serialPrompts),
  });
  for await (const _event of routeSerial(serialDeps, [createCatId('opus')], text, ownerUserId, 'thread-f281-fixture', {
    humanDispositionInvocationOrigin: 'direct_owner',
  })) {
    // Drain.
  }
  const parallelDeps = routeDeps(feedbackService, {
    opus: createCapturingService('opus', parallelPrompts),
    codex: createCapturingService('codex', parallelPrompts),
  });
  for await (const _event of routeParallel(
    parallelDeps,
    [createCatId('opus'), createCatId('codex')],
    text,
    ownerUserId,
    'thread-f281-fixture',
    { humanDispositionInvocationOrigin: 'direct_owner' },
  )) {
    // Drain.
  }
  if (!serialPrompts[0] || parallelPrompts.length !== 2) throw new Error('fixture prompt capture was incomplete');
  return { serial: serialPrompts[0], parallel: parallelPrompts };
}
