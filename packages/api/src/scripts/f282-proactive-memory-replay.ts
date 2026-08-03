import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  candidateClaimDraftSchema,
  type PersonMemorySourceBundleInput,
  validatePersonMemoryAssertionMatrix,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { MessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { ProactiveCandidateNudgeReceiptStore } from '../domains/memory/ProactiveCandidateNudgeReceiptStore.js';
import type { ProactiveCandidateRegistryMatch } from '../domains/memory/ProactiveCandidateRegistryResolver.js';
import { ProactiveMemoryCandidateDetector } from '../domains/memory/ProactiveMemoryCandidateDetector.js';
import { ProactiveMemoryNudgeService } from '../domains/memory/ProactiveMemoryNudgeService.js';
import {
  digestPersonMemorySourceMaterial,
  PersonMemorySourceBundleResolver,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import { DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG } from '../domains/memory/proactive-memory-candidate-contract.js';
import { normalizeCandidatePhrase } from '../domains/memory/proactive-memory-lexical-noise.js';
import { summarizeF282SingleImportantCoverage } from './f282-proactive-memory-phase-d-replay.js';

const OWNER_USER_ID = 'f282-replay-owner';
const DAY = 24 * 60 * 60 * 1000;

type RegistryDisposition = 'registered' | 'pending' | 'dormant';

interface ReplayMessage {
  readonly content: string;
  readonly threadId: string;
  readonly timestamp: number;
}

interface ReplayThread {
  readonly id: string;
  readonly private?: boolean;
}

interface ReplayEpisodeFixture {
  readonly id: string;
  readonly threads: readonly ReplayThread[];
  readonly messages: readonly ReplayMessage[];
  readonly eligibleSubjects: readonly string[];
  readonly irrelevantSubjects: readonly string[];
  readonly registry?: Readonly<Record<string, RegistryDisposition>>;
}

export interface F282ReplayEpisodeResult {
  readonly id: string;
  readonly surfacedSubjects: readonly string[];
  readonly eligibleSubjects: readonly string[];
  readonly irrelevantSubjects: readonly string[];
  readonly privateCoordinatesSurfaced: readonly string[];
  readonly registrySubjectsSurfaced: readonly string[];
}

export interface F282ProactiveMemoryReplayResult {
  readonly fixtureRevision: 'f282-phase-a-b-v2';
  readonly status: 'incubating';
  readonly threshold: {
    readonly windowMs: number;
    readonly recentWindowMs: number;
    readonly minDistinctThreads: number;
    readonly minDistinctMessages: number;
    readonly minBackgroundMessages: number;
    readonly minRecentBurstLift: number;
    readonly maxNudgesPerTurn: number;
  };
  readonly vector: {
    readonly relevantCoverage: {
      readonly detector: {
        readonly eligibleOpportunities: number;
        readonly surfacedEligibleOpportunities: number;
      };
      readonly singleImportantCatJudgment: {
        readonly opportunities: number;
        readonly informedOpportunities: number;
      };
    };
    readonly irrelevantSlots: {
      readonly surfacedSlots: number;
      readonly irrelevantSlots: number;
    };
    readonly attentionBurden: {
      readonly activeWorkspaceWeeks: number;
      readonly surfacedSlotsByWeek: readonly number[];
    };
  };
  readonly hardConstraintFailures: readonly string[];
  readonly episodes: readonly F282ReplayEpisodeResult[];
  readonly evidenceContract: {
    readonly attachmentResolved: boolean;
    readonly confirmedTranscriptResolved: boolean;
    readonly inferenceRejectedBeforeStage: boolean;
    readonly quotedEventFactRejected: boolean;
    readonly hardFailures: readonly string[];
  };
}

const F282_THRESHOLD_EPISODES: readonly ReplayEpisodeFixture[] = [
  {
    id: 'alden-positive',
    threads: [{ id: 'alden-a' }, { id: 'alden-b' }],
    messages: [
      { content: 'Alden', threadId: 'alden-a', timestamp: 100 },
      { content: 'Alden', threadId: 'alden-b', timestamp: 200 },
      { content: 'Alden', threadId: 'alden-b', timestamp: 300 },
    ],
    eligibleSubjects: ['alden'],
    irrelevantSubjects: [],
  },
  {
    id: 'single-thread-detector-silent',
    threads: [{ id: 'single-a' }],
    messages: [
      { content: 'Alden', threadId: 'single-a', timestamp: 100 },
      { content: 'Alden', threadId: 'single-a', timestamp: 200 },
      { content: 'Alden', threadId: 'single-a', timestamp: 300 },
    ],
    eligibleSubjects: [],
    irrelevantSubjects: [],
  },
  {
    id: 'observed-lexical-noise',
    threads: [{ id: 'noise-a' }, { id: 'noise-b' }],
    messages: [
      { content: 'App，commit，我希望，而言，成本，代码，会议', threadId: 'noise-a', timestamp: 100 },
      { content: 'App，commit，我希望，而言，成本，代码，会议', threadId: 'noise-b', timestamp: 200 },
      { content: 'App，commit，我希望，而言，成本，代码，会议', threadId: 'noise-b', timestamp: 300 },
    ],
    eligibleSubjects: [],
    irrelevantSubjects: ['app', 'commit', '我希望', '而言', '成本', '代码', '会议'],
  },
  {
    id: 'chronic-background-noise',
    threads: [{ id: 'chronic-a' }, { id: 'chronic-b' }, { id: 'chronic-c' }],
    messages: [
      { content: 'Mingle', threadId: 'chronic-a', timestamp: DAY },
      { content: 'Mingle', threadId: 'chronic-b', timestamp: 2 * DAY },
      { content: 'Mingle', threadId: 'chronic-a', timestamp: 3 * DAY },
      { content: 'Mingle', threadId: 'chronic-b', timestamp: 4 * DAY },
      { content: 'Mingle', threadId: 'chronic-a', timestamp: 5 * DAY + 100 },
      { content: 'Mingle', threadId: 'chronic-b', timestamp: 5 * DAY + 200 },
      { content: 'Mingle', threadId: 'chronic-c', timestamp: 6 * DAY },
    ],
    eligibleSubjects: [],
    irrelevantSubjects: ['mingle'],
  },
  {
    id: 'private-source-excluded',
    threads: [{ id: 'private-a', private: true }, { id: 'private-b', private: true }, { id: 'public-a' }],
    messages: [
      { content: 'Alden', threadId: 'private-a', timestamp: 100 },
      { content: 'Alden', threadId: 'private-b', timestamp: 200 },
      { content: 'Alden', threadId: 'public-a', timestamp: 300 },
    ],
    eligibleSubjects: [],
    irrelevantSubjects: [],
  },
  {
    id: 'registry-and-dormant-suppressed',
    threads: [{ id: 'registry-a' }, { id: 'registry-b' }],
    messages: [
      { content: 'Alden，Beren，Cora', threadId: 'registry-a', timestamp: 100 },
      { content: 'Alden，Beren，Cora', threadId: 'registry-b', timestamp: 200 },
      { content: 'Alden，Beren，Cora', threadId: 'registry-b', timestamp: 300 },
    ],
    eligibleSubjects: [],
    irrelevantSubjects: [],
    registry: {
      alden: 'registered',
      beren: 'pending',
      cora: 'dormant',
    },
  },
  {
    id: 'cap-overflow-preserved',
    threads: [{ id: 'cap-a' }, { id: 'cap-b' }, { id: 'cap-c' }],
    messages: [
      { content: 'Alden，Boreal，Cora，Daria', threadId: 'cap-a', timestamp: 100 },
      { content: 'Alden，Boreal，Cora，Daria', threadId: 'cap-b', timestamp: 200 },
      { content: 'Alden，Boreal，Cora，Daria', threadId: 'cap-b', timestamp: 300 },
      { content: 'Boreal，Cora，Daria', threadId: 'cap-c', timestamp: 400 },
      { content: 'Cora，Daria', threadId: 'cap-c', timestamp: 500 },
      { content: 'Daria', threadId: 'cap-c', timestamp: 600 },
    ],
    eligibleSubjects: ['alden', 'boreal', 'cora', 'daria'],
    irrelevantSubjects: [],
  },
];

function createThread(fixture: ReplayThread): Thread {
  return {
    id: fixture.id,
    projectPath: '/fixture',
    title: fixture.id,
    createdBy: OWNER_USER_ID,
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
    ...(fixture.private ? { threadMetadata: { v: 1, notes: { privacy: 'private' } } } : {}),
  };
}

function resolveRegistryMatch(
  registry: ReplayEpisodeFixture['registry'],
  phrase: string,
): ProactiveCandidateRegistryMatch {
  const normalized = normalizeCandidatePhrase(phrase);
  const disposition = registry?.[normalized];
  if (disposition === 'registered') return { kind: 'registered_entity', ref: `entity:${normalized}` };
  if (disposition === 'pending') {
    return { kind: 'pending_candidate', producerId: 'F276', proposalId: `pending:${normalized}` };
  }
  if (disposition === 'dormant') {
    return { kind: 'dormant_candidate', producerId: 'F276', proposalId: `dormant:${normalized}` };
  }
  return { kind: 'unregistered' };
}

async function replayEpisode(fixture: ReplayEpisodeFixture): Promise<F282ReplayEpisodeResult> {
  const messageStore = new MessageStore();
  const threads = new Map(fixture.threads.map((thread) => [thread.id, createThread(thread)]));
  let currentMessageId = '';
  let currentTimestamp = 0;
  for (const message of fixture.messages) {
    const stored = messageStore.append({
      userId: OWNER_USER_ID,
      catId: null,
      content: message.content,
      mentions: [],
      threadId: message.threadId,
      timestamp: message.timestamp,
    });
    currentMessageId = stored.id;
    currentTimestamp = message.timestamp;
  }

  const db = new Database(':memory:');
  try {
    const detector = new ProactiveMemoryCandidateDetector(
      messageStore,
      { get: (threadId) => threads.get(threadId) ?? null },
      DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG,
    );
    const service = new ProactiveMemoryNudgeService({
      detector,
      registryResolver: {
        resolve: async ({ phrase }) => resolveRegistryMatch(fixture.registry, phrase),
      },
      receiptStore: new ProactiveCandidateNudgeReceiptStore(db),
    });
    const prepared = await service.prepare({
      ownerUserId: OWNER_USER_ID,
      currentUserMessageId: currentMessageId,
      now: currentTimestamp,
    });
    service.finalize(prepared, currentTimestamp);

    const privateThreadIds = new Set(fixture.threads.filter((thread) => thread.private).map((thread) => thread.id));
    const surfacedSubjects = prepared.candidates.map((candidate) => candidate.normalizedPhrase);
    const privateCoordinatesSurfaced = prepared.candidates.flatMap((candidate) =>
      candidate.sourceCoordinates
        .filter((coordinate) => privateThreadIds.has(coordinate.threadId))
        .map((coordinate) => `${candidate.normalizedPhrase}@${coordinate.threadId}`),
    );
    const registrySubjectsSurfaced = surfacedSubjects.filter((subject) => fixture.registry?.[subject] !== undefined);

    return {
      id: fixture.id,
      surfacedSubjects,
      eligibleSubjects: fixture.eligibleSubjects,
      irrelevantSubjects: fixture.irrelevantSubjects,
      privateCoordinatesSurfaced,
      registrySubjectsSurfaced,
    };
  } finally {
    db.close();
  }
}

async function replayEvidenceContract(): Promise<F282ProactiveMemoryReplayResult['evidenceContract']> {
  const messageStore = new MessageStore();
  const attachment = {
    type: 'image' as const,
    url: '/uploads/synthetic-zhou-yujing.png',
    alt: '截图显示周玉晶负责 proactive memory pipeline',
  };
  const attachmentMessage = messageStore.append({
    userId: OWNER_USER_ID,
    catId: null,
    content: '周玉晶职责见附件。',
    contentBlocks: [attachment],
    mentions: [],
    threadId: 'typed-evidence',
    timestamp: 1,
  });
  const confirmationMessage = messageStore.append({
    userId: OWNER_USER_ID,
    catId: null,
    content: '对，这份转写准确。',
    mentions: [],
    threadId: 'typed-evidence',
    timestamp: 2,
  });
  const transcript = '周玉晶说她负责 proactive memory pipeline';
  const sourceBundle: PersonMemorySourceBundleInput = {
    sources: [
      {
        sourceId: 'attachment',
        kind: 'message_attachment',
        messageId: attachmentMessage.id,
        attachmentLocator: { surface: 'content_block', index: 0 },
        expectedDigest: digestPersonMemorySourceMaterial(attachment),
        boundedTranscript: attachment.alt,
      },
      {
        sourceId: 'transcript',
        kind: 'owner_confirmed_transcript',
        transcript,
        transcriptDigest: digestPersonMemorySourceMaterial(transcript),
        confirmationMessageId: confirmationMessage.id,
        confirmationScope: 'transcript_accuracy',
      },
    ],
    assertionBindings: [
      {
        sourceId: 'attachment',
        target: { kind: 'claim', index: 0 },
        role: 'reported_fact',
      },
      {
        sourceId: 'transcript',
        target: { kind: 'claim', index: 1 },
        role: 'quoted_third_party',
      },
    ],
  };
  const resolver = new PersonMemorySourceBundleResolver({ messageStore });
  const resolved = await resolver.resolve(
    sourceBundle,
    { ownerUserId: OWNER_USER_ID },
    {
      claimDraftIds: [
        candidateClaimDraftSchema.shape.draftId.parse('person_draft_attachment'),
        candidateClaimDraftSchema.shape.draftId.parse('person_draft_transcript'),
      ],
    },
  );
  const resolvedKinds = resolved.status === 'resolved' ? resolved.bundle.sources.map((source) => source.kind) : [];
  const inferenceRejectedBeforeStage = validatePersonMemoryAssertionMatrix({
    claims: [],
    hasRelationship: false,
    hasInteraction: true,
    bindings: [
      {
        sourceId: 'inference',
        target: { kind: 'interaction', field: 'headline' },
        role: 'agent_inference',
      },
    ],
  }).some((error) => error.startsWith('agent_inference'));
  const quotedEventFactRejected = validatePersonMemoryAssertionMatrix({
    claims: [],
    hasRelationship: false,
    hasInteraction: true,
    bindings: [
      {
        sourceId: 'quote',
        target: { kind: 'interaction', field: 'occurredAt' },
        role: 'quoted_third_party',
      },
    ],
  }).includes('quoted_third_party cannot support interaction occurredAt');
  const attachmentResolved = resolvedKinds.includes('message_attachment');
  const confirmedTranscriptResolved = resolvedKinds.includes('owner_confirmed_transcript');
  const hardFailures = [
    ...(attachmentResolved ? [] : ['attachment_not_resolved']),
    ...(confirmedTranscriptResolved ? [] : ['confirmed_transcript_not_resolved']),
    ...(inferenceRejectedBeforeStage ? [] : ['inference_not_rejected']),
    ...(quotedEventFactRejected ? [] : ['quote_ceiling_not_enforced']),
  ];
  return {
    attachmentResolved,
    confirmedTranscriptResolved,
    inferenceRejectedBeforeStage,
    quotedEventFactRejected,
    hardFailures,
  };
}

export async function runF282ProactiveMemoryReplay(): Promise<F282ProactiveMemoryReplayResult> {
  const episodes: F282ReplayEpisodeResult[] = [];
  for (const fixture of F282_THRESHOLD_EPISODES) {
    episodes.push(await replayEpisode(fixture));
  }

  const hardConstraintFailures = episodes.flatMap((episode) => [
    ...episode.privateCoordinatesSurfaced.map((coordinate) => `privacy:${episode.id}:${coordinate}`),
    ...episode.registrySubjectsSurfaced.map((subject) => `registry:${episode.id}:${subject}`),
  ]);
  const eligibleOpportunities = episodes.reduce((count, episode) => count + episode.eligibleSubjects.length, 0);
  const surfacedEligibleOpportunities = episodes.reduce(
    (count, episode) =>
      count + episode.surfacedSubjects.filter((subject) => episode.eligibleSubjects.includes(subject)).length,
    0,
  );
  const surfacedSlots = episodes.reduce((count, episode) => count + episode.surfacedSubjects.length, 0);
  const irrelevantSlots = episodes.reduce(
    (count, episode) =>
      count + episode.surfacedSubjects.filter((subject) => episode.irrelevantSubjects.includes(subject)).length,
    0,
  );
  const evidenceContract = await replayEvidenceContract();

  return {
    fixtureRevision: 'f282-phase-a-b-v2',
    status: 'incubating',
    threshold: {
      ...DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG,
    },
    vector: {
      relevantCoverage: {
        detector: { eligibleOpportunities, surfacedEligibleOpportunities },
        singleImportantCatJudgment: summarizeF282SingleImportantCoverage(),
      },
      irrelevantSlots: { surfacedSlots, irrelevantSlots },
      attentionBurden: {
        activeWorkspaceWeeks: episodes.length,
        surfacedSlotsByWeek: episodes.map((episode) => episode.surfacedSubjects.length),
      },
    },
    hardConstraintFailures,
    episodes,
    evidenceContract,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runF282ProactiveMemoryReplay()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
