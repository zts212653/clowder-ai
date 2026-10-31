import type { StoredMessage } from '../ports/MessageStore.js';

type RecoveryMarker = NonNullable<NonNullable<StoredMessage['extra']>['recovery']>;
type RecoverySourceProof = NonNullable<RecoveryMarker['sourceProof']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseWithheldDecision(value: unknown): NonNullable<RecoverySourceProof['withheldDecision']> | undefined {
  if (
    !isRecord(value) ||
    typeof value.withheldAtUtc !== 'string' ||
    typeof value.closureId !== 'string' ||
    typeof value.decisionKind !== 'string'
  ) {
    return undefined;
  }
  return {
    withheldAtUtc: value.withheldAtUtc,
    closureId: value.closureId,
    decisionKind: value.decisionKind,
  };
}

function parseSourceProof(value: unknown): RecoverySourceProof | undefined {
  if (
    !isRecord(value) ||
    typeof value.transcriptPath !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !Number.isSafeInteger(value.firstEventNo) ||
    !Number.isSafeInteger(value.lastEventNo) ||
    !Number.isSafeInteger(value.terminalEventNo) ||
    (value.terminalKind !== 'transcript_done' && value.terminalKind !== 'f254_withheld_decision')
  ) {
    return undefined;
  }
  const withheldDecision = parseWithheldDecision(value.withheldDecision);
  if (value.terminalKind === 'f254_withheld_decision' && !withheldDecision) return undefined;
  return {
    transcriptPath: value.transcriptPath,
    sessionId: value.sessionId,
    firstEventNo: value.firstEventNo as number,
    lastEventNo: value.lastEventNo as number,
    terminalEventNo: value.terminalEventNo as number,
    terminalKind: value.terminalKind,
    ...(withheldDecision ? { withheldDecision } : {}),
  };
}

export function parseRecoveryMarker(value: unknown): RecoveryMarker | undefined {
  if (
    !isRecord(value) ||
    value.kind !== 'f254_withheld_message' ||
    typeof value.invocationId !== 'string' ||
    typeof value.manifestSha256 !== 'string' ||
    typeof value.contentSha256 !== 'string' ||
    typeof value.cvoDecisionRef !== 'string' ||
    !Number.isSafeInteger(value.recoveredAt) ||
    (value.recoveredAt as number) <= 0
  ) {
    return undefined;
  }
  const sourceProof = parseSourceProof(value.sourceProof);
  if (!sourceProof) return undefined;
  return {
    kind: 'f254_withheld_message',
    invocationId: value.invocationId,
    manifestSha256: value.manifestSha256,
    contentSha256: value.contentSha256,
    cvoDecisionRef: value.cvoDecisionRef,
    recoveredAt: value.recoveredAt as number,
    sourceProof,
  };
}
