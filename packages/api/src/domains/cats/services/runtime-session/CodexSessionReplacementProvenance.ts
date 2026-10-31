export type CodexWriterClassification =
  | 'local_live_lease'
  | 'native_active_turn_without_local_lease'
  | 'external_or_unknown';

export type CodexWriterClassificationConfidence = 'high' | 'medium' | 'low';

export interface CodexActiveWriterDiagnostics {
  observedAt: number;
  classification: CodexWriterClassification;
  confidence: CodexWriterClassificationConfidence;
  localHostLease: {
    state: 'live' | 'not_observed';
    source: 'carrier_affinity';
  };
  nativeThread: {
    readOutcome: 'succeeded' | 'failed';
    threadId: string;
    status: 'active' | 'idle' | 'not_loaded' | 'system_error' | 'unknown';
    activeTurn?: {
      turnId: string;
      startedAt?: number;
    };
  };
  /** Codex app-server thread/read does not expose the writer's client identity. */
  writerClientIdentity: 'unavailable';
}

export interface CodexActiveWriterReplacementProvenance {
  cause: 'active_writer_reborn';
  previousNativeThreadId: string;
  detectedAt: number;
  attempt: number;
  diagnostics: CodexActiveWriterDiagnostics;
}

export type CodexNativeResumeRejection = 'rollout_not_found' | 'max_payload_size_exceeded';

export interface CodexNativeResumeReplacementProvenance {
  cause: 'native_resume_rejected';
  previousNativeThreadId: string;
  detectedAt: number;
  rejection: CodexNativeResumeRejection;
}

export type CodexSessionReplacementProvenance =
  | CodexActiveWriterReplacementProvenance
  | CodexNativeResumeReplacementProvenance;

export interface CodexActiveWriterDetection {
  previousNativeThreadId: string;
  detectedAt: number;
  diagnostics: CodexActiveWriterDiagnostics;
}

export class CodexActiveWriterRecoveryError extends Error {
  readonly detection: CodexActiveWriterDetection;

  constructor(message: string, detection: CodexActiveWriterDetection) {
    super(message);
    this.name = 'CodexActiveWriterRecoveryError';
    this.detection = detection;
  }
}

export async function captureCodexActiveWriterDetection(input: {
  threadId: string;
  localLiveLease: boolean;
  observedAt: number;
  readThread: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<CodexActiveWriterDetection> {
  let threadRead: { outcome: 'succeeded'; result: unknown } | { outcome: 'failed' };
  try {
    threadRead = {
      outcome: 'succeeded',
      result: await withTimeout(input.readThread(), Math.max(1, input.timeoutMs ?? 1_000)),
    };
  } catch {
    threadRead = { outcome: 'failed' };
  }
  return {
    previousNativeThreadId: input.threadId,
    detectedAt: input.observedAt,
    diagnostics: buildCodexActiveWriterDiagnostics({
      threadId: input.threadId,
      observedAt: input.observedAt,
      localLiveLease: input.localLiveLease,
      threadRead,
    }),
  };
}

export function buildCodexActiveWriterDiagnostics(input: {
  threadId: string;
  observedAt: number;
  localLiveLease: boolean;
  threadRead: { outcome: 'succeeded'; result: unknown } | { outcome: 'failed' };
}): CodexActiveWriterDiagnostics {
  const threadResult = input.threadRead.outcome === 'succeeded' ? asRecord(input.threadRead.result) : null;
  const thread = asRecord(threadResult?.thread);
  const statusRecord = asRecord(thread?.status);
  const status = normalizeThreadStatus(statusRecord?.type);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const activeTurn = turns
    .map(asRecord)
    .reverse()
    .find((turn): turn is Record<string, unknown> => turn?.status === 'inProgress' && typeof turn.id === 'string');
  const nativeActiveTurn = status === 'active' ? activeTurn : undefined;
  const activeTurnSnapshot = nativeActiveTurn
    ? {
        turnId: nativeActiveTurn.id as string,
        ...(typeof nativeActiveTurn.startedAt === 'number' && Number.isFinite(nativeActiveTurn.startedAt)
          ? { startedAt: nativeActiveTurn.startedAt }
          : {}),
      }
    : undefined;
  const classification: CodexWriterClassification = input.localLiveLease
    ? 'local_live_lease'
    : activeTurnSnapshot
      ? 'native_active_turn_without_local_lease'
      : 'external_or_unknown';
  const confidence: CodexWriterClassificationConfidence =
    classification === 'local_live_lease'
      ? 'high'
      : classification === 'native_active_turn_without_local_lease'
        ? 'medium'
        : 'low';

  return {
    observedAt: input.observedAt,
    classification,
    confidence,
    localHostLease: {
      state: input.localLiveLease ? 'live' : 'not_observed',
      source: 'carrier_affinity',
    },
    nativeThread: {
      readOutcome: input.threadRead.outcome,
      threadId: input.threadId,
      status: input.threadRead.outcome === 'succeeded' ? status : 'unknown',
      ...(activeTurnSnapshot ? { activeTurn: activeTurnSnapshot } : {}),
    },
    writerClientIdentity: 'unavailable',
  };
}

export function isCodexSessionReplacementProvenance(value: unknown): value is CodexSessionReplacementProvenance {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.previousNativeThreadId)) return false;
  if (!isFiniteNumber(value.detectedAt)) return false;
  if (value.cause === 'native_resume_rejected') {
    return value.rejection === 'rollout_not_found' || value.rejection === 'max_payload_size_exceeded';
  }
  if (value.cause !== 'active_writer_reborn') return false;
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) return false;
  if (!isRecord(value.diagnostics)) return false;
  const diagnostics = value.diagnostics;
  if (!isFiniteNumber(diagnostics.observedAt)) return false;
  if (!isRecord(diagnostics.localHostLease) || diagnostics.localHostLease.source !== 'carrier_affinity') return false;
  if (!isRecord(diagnostics.nativeThread)) return false;
  if (diagnostics.nativeThread.threadId !== value.previousNativeThreadId) return false;
  if (!['succeeded', 'failed'].includes(String(diagnostics.nativeThread.readOutcome))) return false;
  if (!['active', 'idle', 'not_loaded', 'system_error', 'unknown'].includes(String(diagnostics.nativeThread.status))) {
    return false;
  }
  if (diagnostics.nativeThread.activeTurn !== undefined && !isActiveTurnSnapshot(diagnostics.nativeThread.activeTurn)) {
    return false;
  }
  if (diagnostics.writerClientIdentity !== 'unavailable') return false;

  const classification = diagnostics.classification;
  if (classification === 'local_live_lease') {
    return diagnostics.confidence === 'high' && diagnostics.localHostLease.state === 'live';
  }
  if (classification === 'native_active_turn_without_local_lease') {
    return (
      diagnostics.confidence === 'medium' &&
      diagnostics.localHostLease.state === 'not_observed' &&
      diagnostics.nativeThread.status === 'active' &&
      isActiveTurnSnapshot(diagnostics.nativeThread.activeTurn)
    );
  }
  return (
    classification === 'external_or_unknown' &&
    diagnostics.confidence === 'low' &&
    diagnostics.localHostLease.state === 'not_observed' &&
    diagnostics.nativeThread.activeTurn === undefined
  );
}

function isActiveTurnSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.turnId)) return false;
  return value.startedAt === undefined || isFiniteNumber(value.startedAt);
}

function normalizeThreadStatus(value: unknown): CodexActiveWriterDiagnostics['nativeThread']['status'] {
  if (value === 'active' || value === 'idle' || value === 'notLoaded' || value === 'systemError') {
    return value === 'notLoaded' ? 'not_loaded' : value === 'systemError' ? 'system_error' : value;
  }
  return 'unknown';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex active-writer diagnostics timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
