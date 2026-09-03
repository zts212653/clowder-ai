import type { SessionRecord } from '@cat-cafe/shared';
import { projectInvocationTerminalEvidence } from '../../../domains/cats/services/session/InvocationTrajectoryProjector.js';
import type { TranscriptEvent, TranscriptReader } from '../../../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../../../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import {
  assertCandidateBudget,
  assertInvocationStateBudget,
  consumeDrillBudget,
  consumeEvidenceBudget,
  consumeInBatches,
  createTrajectoryScanBudget,
  mapWithConcurrency,
  retainFallbackCommand,
  TRAJECTORY_SCAN_CONCURRENCY,
  type TrajectoryScanBudget,
} from './trajectory-inspector-scan-limits.js';
import type { TrajectoryInspectorEpisode, TrajectoryInspectorWindowSelector } from './trajectory-inspector-types.js';

export { assertCandidateBudget, mapWithConcurrency, TRAJECTORY_SCAN_CONCURRENCY };

export interface TrajectoryCandidate {
  invocationId: string;
  eligibleAtMs: number;
  anomalyKind: TrajectoryInspectorEpisode['anomalyKind'];
  eligibility: Set<TrajectoryInspectorEpisode['eligibility'][number]>;
  threadId?: string;
  sessionId?: string;
  catId?: string;
  model?: string;
  runtime?: string;
  sourceRefs: Set<string>;
}

export interface TrajectoryDrill {
  targetInvocationId: string;
  observedAtMs: number;
  threadIdHint?: string;
  sessionIdHint?: string;
  successful: boolean;
}

interface IndexedDrill extends TrajectoryDrill {
  stableId: string;
  toolUseId?: string;
}
interface WindowSessionFacts {
  present: boolean;
  candidates: TrajectoryCandidate[];
  drills: IndexedDrill[];
  fallbackCommands: string[];
}
interface InvocationWindowState {
  invocationId: string;
  lastEventAtMs: number;
  terminal?: ReturnType<typeof projectInvocationTerminalEvidence>;
  fingerprint: { model?: string; runtime?: string };
}
interface TranscriptScannerDeps {
  threadStore: Pick<IThreadStore, 'list'>;
  sessionChainStore: Pick<ISessionChainStore, 'getChainByThread'>;
  transcriptReader: Pick<TranscriptReader, 'scanEvents'>;
}
export type CandidateEvidenceIndex = Map<string, Map<string, TranscriptEvent[]>>;

export async function scanOwnerTrajectoryWindow(
  deps: TranscriptScannerDeps,
  selector: TrajectoryInspectorWindowSelector,
  ownerUserId: string,
): Promise<{
  sessions: SessionRecord[];
  candidates: Map<string, TrajectoryCandidate>;
  drills: TrajectoryDrill[];
  fallbackCommands: string[];
  missingTranscriptSessions: number;
}> {
  const threads = await deps.threadStore.list(ownerUserId);
  const chains = await mapWithConcurrency(threads, TRAJECTORY_SCAN_CONCURRENCY, (thread) =>
    deps.sessionChainStore.getChainByThread(thread.id),
  );
  const sessions = chains.flat().filter((session) => session.userId === ownerUserId);
  const windowSessions = sessions.filter((session) => sessionOverlapsWindow(session, selector));
  const scanBudget = createTrajectoryScanBudget();
  const candidates = new Map<string, TrajectoryCandidate>();
  const drills = new Map<string, IndexedDrill>();
  const fallbackCommands: string[] = [];
  let missingTranscriptSessions = 0;
  await consumeInBatches(
    windowSessions,
    TRAJECTORY_SCAN_CONCURRENCY,
    (session) => scanWindowSession(deps.transcriptReader, session, selector, scanBudget),
    (row) => {
      if (!row.present) missingTranscriptSessions += 1;
      for (const candidate of row.candidates) {
        mergeTrajectoryCandidate(candidates, candidate);
        assertCandidateBudget(candidates.size);
      }
      for (const drill of row.drills) {
        const existing = drills.get(drill.stableId);
        if (!existing) drills.set(drill.stableId, drill);
        else existing.successful ||= drill.successful;
      }
      fallbackCommands.push(...row.fallbackCommands);
    },
  );
  return {
    sessions,
    candidates,
    drills: [...drills.values()],
    fallbackCommands,
    missingTranscriptSessions,
  };
}

async function scanWindowSession(
  transcriptReader: Pick<TranscriptReader, 'scanEvents'>,
  session: SessionRecord,
  selector: TrajectoryInspectorWindowSelector,
  scanBudget: TrajectoryScanBudget,
): Promise<WindowSessionFacts> {
  const invocationStates = new Map<string, InvocationWindowState>();
  const drills = new Map<string, IndexedDrill>();
  const successfulDrillIds = new Set<string>();
  const fallbackCommands: string[] = [];
  const scan = await transcriptReader.scanEvents(session.id, session.threadId, session.catId, (event) => {
    if (event.invocationId) {
      const terminal = projectInvocationTerminalEvidence(event.event);
      const current = invocationStates.get(event.invocationId);
      invocationStates.set(event.invocationId, {
        invocationId: event.invocationId,
        lastEventAtMs: event.t,
        terminal: preferTerminal(current?.terminal, terminal),
        fingerprint: current?.fingerprint ?? eventFingerprint(event),
      });
      assertInvocationStateBudget(invocationStates.size);
    }
    if (
      event.event.type === 'tool_result' &&
      event.event.toolResultStatus !== 'error' &&
      typeof event.event.toolUseId === 'string' &&
      drills.has(event.event.toolUseId)
    ) {
      successfulDrillIds.add(event.event.toolUseId);
    }
    if (!insideWindow(event.t, selector)) return;
    if (event.event.type === 'tool_use') collectToolUse(event, drills, fallbackCommands, scanBudget);
  });
  const candidates = new Map<string, TrajectoryCandidate>();
  for (const state of invocationStates.values()) {
    if (!state.terminal || !insideWindow(state.lastEventAtMs, selector)) continue;
    mergeTrajectoryCandidate(candidates, {
      invocationId: state.invocationId,
      eligibleAtMs: state.lastEventAtMs,
      anomalyKind: state.terminal.status,
      eligibility: new Set(['terminal_anomaly']),
      threadId: session.threadId,
      sessionId: session.id,
      catId: session.catId,
      ...state.fingerprint,
      sourceRefs: new Set([`inv:${state.invocationId}`, `thread:${session.threadId}`, `session:${session.id}`]),
    });
    assertCandidateBudget(candidates.size);
  }
  for (const row of drills.values()) {
    row.successful = typeof row.toolUseId === 'string' && successfulDrillIds.has(row.toolUseId);
  }
  return {
    present: scan.present,
    candidates: [...candidates.values()],
    drills: [...drills.values()],
    fallbackCommands,
  };
}

function collectToolUse(
  event: TranscriptEvent,
  drills: Map<string, IndexedDrill>,
  fallbackCommands: string[],
  scanBudget: TrajectoryScanBudget,
): void {
  const toolName = String(event.event.toolName ?? event.event.name ?? '');
  const input = asRecord(event.event.toolInput ?? event.event.input);
  collectDrill(event, toolName, input, drills, scanBudget);
  const command = typeof input?.command === 'string' ? input.command : '';
  if (/events\.jsonl|\bjsonl\b/i.test(command)) {
    fallbackCommands.push(retainFallbackCommand(scanBudget, command));
  }
}

function collectDrill(
  event: TranscriptEvent,
  toolName: string,
  input: Record<string, unknown> | undefined,
  drills: Map<string, IndexedDrill>,
  scanBudget: TrajectoryScanBudget,
): void {
  if (!toolName.endsWith('cat_cafe_read_invocation_detail') || typeof input?.invocationId !== 'string') return;
  const toolUseId = typeof event.event.toolUseId === 'string' ? event.event.toolUseId : undefined;
  const stableId = toolUseId ?? `${event.sessionId}:${event.eventNo}`;
  if (drills.has(stableId)) return;
  consumeDrillBudget(scanBudget);
  drills.set(stableId, {
    stableId,
    ...(toolUseId ? { toolUseId } : {}),
    targetInvocationId: input.invocationId,
    observedAtMs: event.t,
    ...(typeof input.threadId === 'string' ? { threadIdHint: input.threadId } : {}),
    ...(typeof input.sessionId === 'string' ? { sessionIdHint: input.sessionId } : {}),
    successful: false,
  });
}

export async function scanTrajectoryCandidateEvidence(
  transcriptReader: Pick<TranscriptReader, 'scanEvents'>,
  sessions: SessionRecord[],
  candidates: Map<string, TrajectoryCandidate>,
): Promise<CandidateEvidenceIndex> {
  const candidateThreads = new Set(
    [...candidates.values()].map((candidate) => candidate.threadId).filter((value): value is string => !!value),
  );
  const hasUnscopedCandidate = [...candidates.values()].some((candidate) => !candidate.threadId);
  const evidenceSessions = hasUnscopedCandidate
    ? sessions
    : sessions.filter((session) => candidateThreads.has(session.threadId));
  const evidenceBudget = createTrajectoryScanBudget();
  const rows = await mapWithConcurrency(evidenceSessions, TRAJECTORY_SCAN_CONCURRENCY, async (session) => {
    const eventsByInvocation = new Map<string, TranscriptEvent[]>();
    await transcriptReader.scanEvents(session.id, session.threadId, session.catId, (event) => {
      retainCandidateEvidence(event, candidates, eventsByInvocation, evidenceBudget);
    });
    return { sessionId: session.id, eventsByInvocation };
  });
  const index: CandidateEvidenceIndex = new Map(
    [...candidates.keys()].map((invocationId) => [invocationId, new Map<string, TranscriptEvent[]>()]),
  );
  for (const row of rows) {
    for (const [invocationId, events] of row.eventsByInvocation) {
      const bySession = index.get(invocationId) ?? new Map<string, TranscriptEvent[]>();
      bySession.set(row.sessionId, events);
      index.set(invocationId, bySession);
    }
  }
  return index;
}

function retainCandidateEvidence(
  event: TranscriptEvent,
  candidates: Map<string, TrajectoryCandidate>,
  eventsByInvocation: Map<string, TranscriptEvent[]>,
  evidenceBudget: TrajectoryScanBudget,
): void {
  if (!event.invocationId) return;
  const candidate = candidates.get(event.invocationId);
  if (!candidate) return;
  const retained = eventsByInvocation.get(event.invocationId) ?? [];
  const isRequestGeneration = String(event.event.type ?? 'unknown').startsWith('request_generation_');
  const evidenceEvent = isRequestGeneration ? event : retained.length === 0 ? compactIdentityEvent(event) : undefined;
  if (evidenceEvent) {
    consumeEvidenceBudget(evidenceBudget, evidenceEvent, retained.length + 1);
    retained.push(evidenceEvent);
  }
  eventsByInvocation.set(event.invocationId, retained);
  Object.assign(candidate, missingFingerprint(candidate, event));
}

export function mergeTrajectoryCandidate(
  target: Map<string, TrajectoryCandidate>,
  incoming: TrajectoryCandidate,
): void {
  const current = target.get(incoming.invocationId);
  if (!current) {
    target.set(incoming.invocationId, incoming);
    return;
  }
  for (const value of incoming.eligibility) current.eligibility.add(value);
  for (const value of incoming.sourceRefs) current.sourceRefs.add(value);
  const incomingPriority = terminalPriority(incoming.anomalyKind);
  const currentPriority = terminalPriority(current.anomalyKind);
  if (
    incomingPriority > currentPriority ||
    (incomingPriority === currentPriority && incoming.eligibleAtMs < current.eligibleAtMs)
  ) {
    Object.assign(current, {
      eligibleAtMs: incoming.eligibleAtMs,
      anomalyKind: incoming.anomalyKind,
      threadId: incoming.threadId,
      sessionId: incoming.sessionId,
      catId: incoming.catId,
    });
  }
}

function missingFingerprint(
  candidate: TrajectoryCandidate,
  event: TranscriptEvent,
): { model?: string; runtime?: string } {
  const fingerprint = eventFingerprint(event);
  return {
    ...(!candidate.model && fingerprint.model ? { model: fingerprint.model } : {}),
    ...(!candidate.runtime && fingerprint.runtime ? { runtime: fingerprint.runtime } : {}),
  };
}

function compactIdentityEvent(event: TranscriptEvent): TranscriptEvent {
  const fingerprint = eventFingerprint(event);
  return {
    ...event,
    event: {
      type: String(event.event.type ?? 'identity_evidence'),
      ...(fingerprint.model || fingerprint.runtime ? { metadata: fingerprint } : {}),
    },
  };
}

function eventFingerprint(event: TranscriptEvent): { model?: string; runtime?: string } {
  const metadata = asRecord(event.event.metadata);
  const model = typeof metadata?.model === 'string' ? metadata.model : undefined;
  const runtime = typeof metadata?.runtime === 'string' ? metadata.runtime : undefined;
  return { ...(model ? { model } : {}), ...(runtime ? { runtime } : {}) };
}

export function sessionOverlapsWindow(session: SessionRecord, selector: TrajectoryInspectorWindowSelector): boolean {
  const observedEnd = session.status === 'sealed' ? (session.sealedAt ?? Infinity) : Infinity;
  return session.createdAt < selector.windowEndMs && observedEnd >= selector.windowStartMs;
}

function insideWindow(value: number, selector: TrajectoryInspectorWindowSelector): boolean {
  return value >= selector.windowStartMs && value < selector.windowEndMs;
}

function terminalPriority(kind: TrajectoryCandidate['anomalyKind']): number {
  if (kind === 'timeout') return 3;
  if (kind === 'cancelled') return 2;
  if (kind === 'error') return 1;
  return 0;
}

function preferTerminal(
  current: ReturnType<typeof projectInvocationTerminalEvidence>,
  incoming: ReturnType<typeof projectInvocationTerminalEvidence>,
): ReturnType<typeof projectInvocationTerminalEvidence> {
  if (!incoming) return current;
  if (!current) return incoming;
  return terminalPriority(incoming.status) > terminalPriority(current.status) ? incoming : current;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
