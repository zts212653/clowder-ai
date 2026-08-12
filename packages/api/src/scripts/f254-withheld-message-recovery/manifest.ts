import { createHash } from 'node:crypto';
import type { MessageMetadata } from '../../domains/cats/services/types.js';

const INVOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface RecoverySourceProof {
  transcriptPath: string;
  sessionId: string;
  firstEventNo: number;
  lastEventNo: number;
  terminalEventNo: number;
  terminalKind: 'transcript_done' | 'f254_withheld_decision';
  withheldDecision?: {
    withheldAtUtc: string;
    closureId: string;
    decisionKind: string;
  };
}

export interface RecoveryManifestEntry {
  invocationId: string;
  threadId: string;
  userId: string;
  catId: string;
  timestamp: number;
  content: string;
  contentSha256: string;
  sourceProof: RecoverySourceProof;
  metadata?: MessageMetadata;
  thinking?: string;
  replyTo?: string;
}

export interface RecoveryManifestInput {
  version: 1;
  incident: 'F254';
  generatedAt: string;
  cvoDecisionRef: string;
  entries: RecoveryManifestEntry[];
  censusSha256?: string;
  censusTotal?: number;
  omissions?: Array<{ invocationId: string; reason: 'no_recoverable_text' }>;
}

export interface ValidatedRecoveryManifest extends RecoveryManifestInput {
  manifestSha256: string;
}

export interface RecoveryTranscriptEvent {
  v: number;
  t: number;
  threadId: string;
  catId: string;
  sessionId: string;
  cliSessionId?: string;
  invocationId?: string;
  eventNo: number;
  event: Record<string, unknown>;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`recovery manifest ${field} must be a non-empty string`);
  }
}

function validateSourceProof(rawProof: unknown, invocationId: string): RecoverySourceProof {
  if (!isRecord(rawProof)) throw new Error(`recovery manifest ${invocationId} sourceProof must be an object`);
  const proof = rawProof as unknown as RecoverySourceProof;
  requireNonEmpty(proof.transcriptPath, `${invocationId}.sourceProof.transcriptPath`);
  if (proof.transcriptPath.startsWith('/') || proof.transcriptPath.includes('..')) {
    throw new Error(`recovery manifest ${invocationId} sourceProof transcriptPath must be repository-relative`);
  }
  requireNonEmpty(proof.sessionId, `${invocationId}.sourceProof.sessionId`);
  for (const [field, value] of Object.entries({
    firstEventNo: proof.firstEventNo,
    lastEventNo: proof.lastEventNo,
    terminalEventNo: proof.terminalEventNo,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`recovery manifest ${invocationId} sourceProof.${field} must be a non-negative integer`);
    }
  }
  if (proof.firstEventNo > proof.lastEventNo || proof.terminalEventNo > proof.lastEventNo) {
    throw new Error(`recovery manifest ${invocationId} sourceProof event span is invalid`);
  }
  if (proof.terminalKind === 'f254_withheld_decision') {
    const decision = proof.withheldDecision;
    if (
      !decision ||
      !Number.isFinite(Date.parse(decision.withheldAtUtc)) ||
      typeof decision.closureId !== 'string' ||
      decision.closureId.length === 0 ||
      typeof decision.decisionKind !== 'string' ||
      decision.decisionKind.length === 0
    ) {
      throw new Error(`recovery manifest ${invocationId} withheld decision evidence is invalid`);
    }
  } else if (proof.terminalKind !== 'transcript_done' || proof.withheldDecision) {
    throw new Error(`recovery manifest ${invocationId} sourceProof terminal evidence is invalid`);
  }
  return {
    transcriptPath: proof.transcriptPath,
    sessionId: proof.sessionId,
    firstEventNo: proof.firstEventNo,
    lastEventNo: proof.lastEventNo,
    terminalEventNo: proof.terminalEventNo,
    terminalKind: proof.terminalKind,
    ...(proof.withheldDecision ? { withheldDecision: { ...proof.withheldDecision } } : {}),
  };
}

function validateEntry(rawEntry: unknown): RecoveryManifestEntry {
  if (!isRecord(rawEntry)) throw new Error('recovery manifest entry must be an object');
  const entry = rawEntry as unknown as RecoveryManifestEntry;
  requireNonEmpty(entry.invocationId, 'entry.invocationId');
  if (!INVOCATION_ID_PATTERN.test(entry.invocationId)) {
    throw new Error(`recovery manifest invalid invocationId: ${entry.invocationId}`);
  }
  if (!THREAD_ID_PATTERN.test(entry.threadId)) {
    throw new Error(`recovery manifest ${entry.invocationId} has invalid threadId`);
  }
  requireNonEmpty(entry.userId, `${entry.invocationId}.userId`);
  requireNonEmpty(entry.catId, `${entry.invocationId}.catId`);
  if (!Number.isSafeInteger(entry.timestamp) || entry.timestamp <= 0) {
    throw new Error(`recovery manifest ${entry.invocationId} timestamp must be a positive integer`);
  }
  requireNonEmpty(entry.content, `${entry.invocationId}.content`);
  if (!SHA256_PATTERN.test(entry.contentSha256) || entry.contentSha256 !== sha256Text(entry.content)) {
    throw new Error(`recovery manifest ${entry.invocationId} contentSha256 mismatch`);
  }
  const sourceProof = validateSourceProof(entry.sourceProof, entry.invocationId);
  if (entry.metadata !== undefined && !isRecord(entry.metadata)) {
    throw new Error(`recovery manifest ${entry.invocationId} metadata must be an object`);
  }
  if (entry.thinking !== undefined && typeof entry.thinking !== 'string') {
    throw new Error(`recovery manifest ${entry.invocationId} thinking must be a string`);
  }
  if (entry.replyTo !== undefined && typeof entry.replyTo !== 'string') {
    throw new Error(`recovery manifest ${entry.invocationId} replyTo must be a string`);
  }
  return {
    invocationId: entry.invocationId,
    threadId: entry.threadId,
    userId: entry.userId,
    catId: entry.catId,
    timestamp: entry.timestamp,
    content: entry.content,
    contentSha256: entry.contentSha256,
    sourceProof,
    ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
    ...(entry.thinking ? { thinking: entry.thinking } : {}),
    ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
  };
}

function addUniqueInvocation(seenInvocations: Set<string>, invocationId: string): void {
  if (seenInvocations.has(invocationId)) {
    throw new Error(`recovery manifest duplicate invocationId: ${invocationId}`);
  }
  seenInvocations.add(invocationId);
}

function validateOmissions(
  rawOmissions: unknown,
  seenInvocations: Set<string>,
): NonNullable<RecoveryManifestInput['omissions']> {
  if (rawOmissions === undefined) return [];
  if (!Array.isArray(rawOmissions)) throw new Error('recovery manifest omissions must be an array');
  const omissions = rawOmissions ?? [];
  const validated: NonNullable<RecoveryManifestInput['omissions']> = [];
  for (const rawOmission of omissions) {
    if (!isRecord(rawOmission)) throw new Error('recovery manifest omission must be an object');
    const omission = rawOmission as { invocationId?: unknown; reason?: unknown };
    requireNonEmpty(omission.invocationId, 'omissions.invocationId');
    if (omission.reason !== 'no_recoverable_text') throw new Error('recovery manifest omission reason is invalid');
    addUniqueInvocation(seenInvocations, omission.invocationId);
    validated.push({ invocationId: omission.invocationId, reason: omission.reason });
  }
  return validated;
}

function validateCensusAccounting(
  censusSha256: unknown,
  censusTotal: unknown,
  entries: readonly RecoveryManifestEntry[],
  omissions: readonly { invocationId: string; reason: 'no_recoverable_text' }[],
): void {
  if (censusSha256 !== undefined && (typeof censusSha256 !== 'string' || !SHA256_PATTERN.test(censusSha256))) {
    throw new Error('recovery manifest censusSha256 is invalid');
  }
  if (
    censusTotal !== undefined &&
    (!Number.isSafeInteger(censusTotal) || censusTotal !== entries.length + omissions.length)
  ) {
    throw new Error('recovery manifest censusTotal does not account for entries plus omissions');
  }
}

export function validateRecoveryManifest(rawInput: unknown): ValidatedRecoveryManifest {
  if (!isRecord(rawInput)) throw new Error('recovery manifest must be an object');
  const input = rawInput;
  if (input.version !== 1 || input.incident !== 'F254') {
    throw new Error('recovery manifest must use version=1 and incident=F254');
  }
  if (typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))) {
    throw new Error('recovery manifest generatedAt must be an ISO timestamp');
  }
  requireNonEmpty(input.cvoDecisionRef, 'cvoDecisionRef');
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error('recovery manifest entries must be non-empty');
  }
  const seenInvocations = new Set<string>();
  const entries = input.entries
    .map(validateEntry)
    .sort((left, right) => left.invocationId.localeCompare(right.invocationId));
  for (const entry of entries) addUniqueInvocation(seenInvocations, entry.invocationId);
  const omissions = validateOmissions(input.omissions, seenInvocations);
  validateCensusAccounting(input.censusSha256, input.censusTotal, entries, omissions);
  const normalized: RecoveryManifestInput = {
    version: 1,
    incident: 'F254',
    generatedAt: input.generatedAt,
    cvoDecisionRef: input.cvoDecisionRef,
    entries,
    ...(typeof input.censusSha256 === 'string' ? { censusSha256: input.censusSha256 } : {}),
    ...(typeof input.censusTotal === 'number' ? { censusTotal: input.censusTotal } : {}),
    ...(omissions.length > 0
      ? { omissions: [...omissions].sort((a, b) => a.invocationId.localeCompare(b.invocationId)) }
      : {}),
  };
  return { ...normalized, manifestSha256: sha256Text(stableJson(normalized)) };
}

function textFromEvent(event: Record<string, unknown>): string {
  if (event.type === 'text' && typeof event.content === 'string') return event.content;
  if (event.type !== 'assistant') return '';
  if (typeof event.content === 'string') return event.content;
  if (!Array.isArray(event.content)) return '';
  return event.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const item = part as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function assertTranscriptIdentity(
  selected: readonly RecoveryTranscriptEvent[],
  first: RecoveryTranscriptEvent,
  invocationId: string,
): void {
  for (const event of selected) {
    if (event.threadId !== first.threadId || event.catId !== first.catId || event.sessionId !== first.sessionId) {
      throw new Error(`invocation ${invocationId} crosses transcript identity boundaries`);
    }
  }
}

export function extractRecoveryEntryFromEvents(input: {
  invocationId: string;
  userId: string;
  transcriptPath: string;
  events: readonly RecoveryTranscriptEvent[];
  withheldDecision?: NonNullable<RecoverySourceProof['withheldDecision']>;
}): RecoveryManifestEntry {
  const selected = input.events.filter((event) => event.invocationId === input.invocationId);
  if (selected.length === 0) throw new Error(`invocation not found in transcript: ${input.invocationId}`);
  const first = selected[0];
  if (!first) throw new Error(`invocation not found in transcript: ${input.invocationId}`);
  assertTranscriptIdentity(selected, first, input.invocationId);
  const start = selected.find((event) => event.event.type === 'session_init');
  if (!start) throw new Error(`invocation ${input.invocationId} has no session_init start evidence`);
  const terminal = [...selected].reverse().find((event) => event.event.type === 'done');
  if (!terminal && !input.withheldDecision) {
    throw new Error(`invocation ${input.invocationId} has no terminal done event`);
  }
  const textEvents = selected
    .map((event) => ({ event, text: textFromEvent(event.event) }))
    .filter((item) => item.text.length > 0);
  const content = textEvents.map((item) => item.text).join('');
  if (content.trim().length === 0) throw new Error(`invocation ${input.invocationId} has no recoverable text`);
  const metadataCandidate =
    textEvents.find((item) => item.event.event.metadata && typeof item.event.event.metadata === 'object')?.event.event
      .metadata ?? terminal?.event.metadata;
  const eventNumbers = selected.map((event) => event.eventNo);
  const sourceProof: RecoverySourceProof = {
    transcriptPath: input.transcriptPath,
    sessionId: first.sessionId,
    firstEventNo: Math.min(...eventNumbers),
    lastEventNo: Math.max(...eventNumbers),
    terminalEventNo: terminal?.eventNo ?? Math.max(...eventNumbers),
    terminalKind: terminal ? 'transcript_done' : 'f254_withheld_decision',
    ...(!terminal && input.withheldDecision ? { withheldDecision: { ...input.withheldDecision } } : {}),
  };
  return validateEntry({
    invocationId: input.invocationId,
    threadId: first.threadId,
    userId: input.userId,
    catId: first.catId,
    timestamp: start.t,
    content,
    contentSha256: sha256Text(content),
    sourceProof,
    ...(metadataCandidate ? { metadata: metadataCandidate as MessageMetadata } : {}),
  });
}
