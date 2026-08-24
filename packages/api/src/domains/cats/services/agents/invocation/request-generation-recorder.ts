import { randomUUID } from 'node:crypto';
import type {
  CatId,
  RequestGenerationEnvelopeV1,
  RequestGenerationPresentationV1,
  RequestGenerationRetryReason,
  RequestGenerationSourceRef,
  RequestGenerationTerminalEvent,
} from '@cat-cafe/shared';
import {
  requestGenerationEnvelopeV1Schema,
  requestGenerationObservedEventSchema,
  requestGenerationTerminalEventSchema,
} from '@cat-cafe/shared';
import { CURRENT_RELATIONSHIP_PROFILE_URI, renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import type { FileProfileRepository } from '../../profile/ProfileRepository.js';
import { encodeProfileSourceRef } from '../../session/request-generation-source-policy.js';
import type { TranscriptSessionInfo, TranscriptWriter } from '../../session/TranscriptWriter.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { PreparedProviderRequestV1, ProviderRequestGenerationCommitV1 } from '../../types.js';

export interface RequestGenerationRecorderSnapshot {
  readonly continuity: RequestGenerationEnvelopeV1['continuity'];
  readonly messageSourceRefs: readonly RequestGenerationSourceRef[];
  readonly nativeInstructionSourceRefs: readonly RequestGenerationSourceRef[];
  readonly presentations: readonly RequestGenerationPresentationV1[];
}

export interface RequestGenerationRecordBoundary {
  readonly attempt: number;
  readonly reason?: RequestGenerationRetryReason;
}

export interface RequestGenerationRecorder {
  recordPrepared(
    prepared: PreparedProviderRequestV1,
    boundary: RequestGenerationRecordBoundary,
  ): Promise<ProviderRequestGenerationCommitV1>;
  recordObserved(
    commit: ProviderRequestGenerationCommitV1,
    evidence: { readonly evidenceRef: string; readonly runtimeSessionId?: string; readonly model?: string },
  ): Promise<void>;
  recordTerminal(
    commit: ProviderRequestGenerationCommitV1,
    outcome: RequestGenerationTerminalEvent['outcome'],
    reason?: string,
  ): Promise<void>;
}

interface GenerationState {
  readonly session: TranscriptSessionInfo;
  readonly runtime: PreparedProviderRequestV1['runtime'];
  observed: boolean;
  terminal: boolean;
}

function transcriptSession(record: {
  id: string;
  threadId: string;
  catId: string;
  cliSessionId?: string;
  seq: number;
}): TranscriptSessionInfo {
  return {
    sessionId: record.id,
    threadId: record.threadId,
    catId: record.catId,
    ...(record.cliSessionId ? { cliSessionId: record.cliSessionId } : {}),
    seq: record.seq,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('request_generation_tool_schema_not_json');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('request_generation_tool_schema_not_json');
}

function canonicalSet(values: readonly unknown[]): string {
  return `[${values.map(canonicalJson).sort().join(',')}]`;
}

function uniqueSourceRefs(sourceRefs: readonly RequestGenerationSourceRef[]): RequestGenerationSourceRef[] {
  const seen = new Set<string>();
  return sourceRefs.filter((sourceRef) => {
    const key = `${sourceRef.owner}\0${sourceRef.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function persistedToolSurface(
  prepared: PreparedProviderRequestV1['tools'],
  digest: (value: string) => Promise<string>,
): Promise<RequestGenerationEnvelopeV1['tools']> {
  const declaredServerSetHash = prepared.declaredServerNames
    ? await digest(canonicalSet([...new Set(prepared.declaredServerNames)]))
    : undefined;
  const catCafeSchemaSetHash = prepared.catCafeSchemas
    ? await digest(canonicalSet(prepared.catCafeSchemas))
    : undefined;
  const providerObservedSchemaSetHash = prepared.providerObservedSchemas
    ? await digest(canonicalSet(prepared.providerObservedSchemas))
    : undefined;
  return {
    finalSurface: prepared.finalSurface,
    ...(declaredServerSetHash ? { declaredServerSetHash } : {}),
    ...(catCafeSchemaSetHash ? { catCafeSchemaSetHash } : {}),
    ...(providerObservedSchemaSetHash ? { providerObservedSchemaSetHash } : {}),
  };
}

async function persistedMessageChannel(input: {
  readonly message: PreparedProviderRequestV1['message'];
  readonly fallbackSourceRefs: readonly RequestGenerationSourceRef[];
  readonly requestGenerationId: string;
  readonly digest: (value: string) => Promise<string>;
}): Promise<{
  readonly channel: RequestGenerationEnvelopeV1['channels'][number];
  readonly messageDigest: string;
}> {
  const body = 'body' in input.message ? input.message.body : undefined;
  const accuracy = body === undefined ? input.message.accuracy : 'exact';
  if (!accuracy) throw new Error('request_generation_message_accuracy_unavailable');
  const messageDigest = await input.digest(body ?? `request-generation:${input.requestGenerationId}:${accuracy}`);
  return {
    messageDigest,
    channel: {
      channel: 'message',
      accuracy,
      ...(body === undefined
        ? {}
        : {
            keyedContentDigest: messageDigest,
            byteLength: Buffer.byteLength(body, 'utf8'),
            body,
          }),
      sourceRefs: [...(input.message.sourceRefs ?? input.fallbackSourceRefs)],
      ...(input.message.injectionDecision ? { injectionDecision: input.message.injectionDecision } : {}),
    },
  };
}

function persistedRetryBoundary(
  generationOrdinal: number,
  boundary: RequestGenerationRecordBoundary,
): RequestGenerationEnvelopeV1['retryBoundary'] {
  if (generationOrdinal === 1) return { attempt: boundary.attempt };
  return {
    attempt: boundary.attempt,
    previousGenerationOrdinal: generationOrdinal - 1,
    ...(boundary.reason ? { reason: boundary.reason } : {}),
  };
}

type ProfileSourceRepository = Pick<FileProfileRepository, 'readCapsule' | 'scope' | 'readPrimer'>;

async function embeddedCapsuleSourceRef(input: {
  readonly body: string;
  readonly userId: string;
  readonly profileRepository?: ProfileSourceRepository;
  readonly digest: (value: string) => Promise<string>;
}): Promise<RequestGenerationSourceRef | undefined> {
  if (!input.body.includes('## 主人画像')) return undefined;
  let rendered = '';
  try {
    const capsule = input.profileRepository?.readCapsule(input.userId);
    rendered = capsule ? renderUserCapsuleSection(capsule.content) : '';
  } catch {
    rendered = '';
  }
  const digest = rendered && input.body.includes(rendered) ? await input.digest(rendered) : 'unresolved';
  return { owner: 'home_state', ref: encodeProfileSourceRef('capsule', digest) };
}

async function embeddedPrimerSourceRef(input: {
  readonly body: string;
  readonly userId: string;
  readonly catId: CatId;
  readonly profileRepository?: ProfileSourceRepository;
  readonly digest: (value: string) => Promise<string>;
}): Promise<RequestGenerationSourceRef | undefined> {
  if (!input.body.includes(CURRENT_RELATIONSHIP_PROFILE_URI)) return undefined;
  let primer: { content: string } | null = null;
  try {
    const scope = input.profileRepository?.scope(input.userId, input.catId);
    primer = scope && input.profileRepository ? input.profileRepository.readPrimer(scope) : null;
  } catch {
    primer = null;
  }
  const digest = primer ? await input.digest(primer.content) : 'unresolved';
  return { owner: 'home_state', ref: encodeProfileSourceRef('primer', digest) };
}

export function createRequestGenerationRecorder(input: {
  readonly invocationId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: CatId;
  readonly transcriptWriter: Pick<TranscriptWriter, 'appendDurableEvent' | 'keyedContentDigest'>;
  readonly sessionChainStore: Pick<ISessionChainStore, 'getActive'>;
  readonly profileRepository?: ProfileSourceRepository;
  readonly snapshot: () => RequestGenerationRecorderSnapshot;
  readonly now?: () => number;
  readonly createId?: () => string;
}): RequestGenerationRecorder {
  let generationOrdinal = 0;
  const generations = new Map<string, GenerationState>();

  const resolveState = (commit: ProviderRequestGenerationCommitV1): GenerationState => {
    const state = generations.get(commit.requestGenerationId);
    if (!state || state.session.sessionId !== commit.sessionId) {
      throw new Error('request_generation_commit_unknown');
    }
    return state;
  };

  const lifecycleSession = async (state: GenerationState): Promise<TranscriptSessionInfo> => {
    const active = await input.sessionChainStore.getActive(input.catId, input.threadId, input.userId);
    return active ? transcriptSession(active) : state.session;
  };

  const profileSourceRefs = async (body: string): Promise<RequestGenerationSourceRef[]> => {
    const digest = input.transcriptWriter.keyedContentDigest.bind(input.transcriptWriter);
    return (
      await Promise.all([
        embeddedCapsuleSourceRef({ body, userId: input.userId, profileRepository: input.profileRepository, digest }),
        embeddedPrimerSourceRef({
          body,
          userId: input.userId,
          catId: input.catId,
          profileRepository: input.profileRepository,
          digest,
        }),
      ])
    ).filter((sourceRef): sourceRef is RequestGenerationSourceRef => Boolean(sourceRef));
  };

  const persistedNativeChannels = async (
    prepared: PreparedProviderRequestV1,
    snapshot: RequestGenerationRecorderSnapshot,
  ): Promise<RequestGenerationEnvelopeV1['channels']> =>
    Promise.all(
      prepared.nativeInstructions.map(async (instruction) => ({
        channel: 'native_instruction' as const,
        accuracy: 'exact' as const,
        keyedContentDigest: await input.transcriptWriter.keyedContentDigest(instruction.body),
        byteLength: Buffer.byteLength(instruction.body, 'utf8'),
        body: instruction.body,
        sourceRefs: uniqueSourceRefs([
          ...(instruction.sourceRefs ?? snapshot.nativeInstructionSourceRefs),
          ...(await profileSourceRefs(instruction.body)),
        ]),
        ...(instruction.injectionDecision ? { injectionDecision: instruction.injectionDecision } : {}),
      })),
    );

  return {
    async recordPrepared(prepared, boundary) {
      const active = await input.sessionChainStore.getActive(input.catId, input.threadId, input.userId);
      if (!active) throw new Error('request_generation_active_session_unavailable');
      generationOrdinal += 1;
      const snapshot = input.snapshot();
      const requestGenerationId = (input.createId ?? randomUUID)();
      const digest = input.transcriptWriter.keyedContentDigest.bind(input.transcriptWriter);
      const { channel: messageChannel, messageDigest } = await persistedMessageChannel({
        message: prepared.message,
        fallbackSourceRefs: snapshot.messageSourceRefs,
        requestGenerationId,
        digest,
      });
      const nativeChannels = await persistedNativeChannels(prepared, snapshot);
      const tools = await persistedToolSurface(prepared.tools, digest);
      const envelope = requestGenerationEnvelopeV1Schema.parse({
        v: 1,
        invocationId: input.invocationId,
        sessionId: active.id,
        generationOrdinal,
        requestGenerationId,
        promptGenerationId: messageDigest,
        assembledAt: (input.now ?? Date.now)(),
        continuity: snapshot.continuity,
        channels: [
          messageChannel,
          ...nativeChannels,
          {
            channel: 'provider_native_hidden',
            accuracy: prepared.providerNativeVisibility,
            sourceRefs: [],
          },
        ],
        presentations: [...snapshot.presentations],
        runtime: {
          requested: prepared.runtime,
          providerNativeVisibility: prepared.providerNativeVisibility,
        },
        tools,
        retryBoundary: persistedRetryBoundary(generationOrdinal, boundary),
      });
      const session = transcriptSession(active);
      await input.transcriptWriter.appendDurableEvent(
        session,
        { type: 'request_generation_assembled', envelope },
        input.invocationId,
      );
      generations.set(requestGenerationId, { session, runtime: prepared.runtime, observed: false, terminal: false });
      return { requestGenerationId, generationOrdinal, sessionId: active.id };
    },
    async recordObserved(commit, evidence) {
      const state = resolveState(commit);
      if (state.observed) return;
      if (state.terminal) throw new Error('request_generation_observed_after_terminal');
      const event = requestGenerationObservedEventSchema.parse({
        type: 'request_generation_observed',
        requestGenerationId: commit.requestGenerationId,
        generationOrdinal: commit.generationOrdinal,
        observedAt: (input.now ?? Date.now)(),
        evidence: {
          provider: state.runtime.provider,
          carrier: state.runtime.carrier,
          ...((evidence.model ?? state.runtime.model) ? { model: evidence.model ?? state.runtime.model } : {}),
          ...(evidence.runtimeSessionId ? { runtimeSessionId: evidence.runtimeSessionId } : {}),
          evidenceRef: evidence.evidenceRef,
        },
      });
      await input.transcriptWriter.appendDurableEvent(await lifecycleSession(state), event, input.invocationId);
      state.observed = true;
    },
    async recordTerminal(commit, outcome, reason) {
      const state = resolveState(commit);
      if (state.terminal) return;
      const event = requestGenerationTerminalEventSchema.parse({
        type: 'request_generation_terminal',
        requestGenerationId: commit.requestGenerationId,
        generationOrdinal: commit.generationOrdinal,
        terminalAt: (input.now ?? Date.now)(),
        outcome,
        ...(reason ? { reason: reason.slice(0, 160) } : {}),
      });
      await input.transcriptWriter.appendDurableEvent(await lifecycleSession(state), event, input.invocationId);
      state.terminal = true;
    },
  };
}
