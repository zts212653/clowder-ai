import type {
  PawFeelDispositionProjection,
  PawFeelInboxItem,
  PawFeelIssueProjection,
  PawFeelResponsibilityProjection,
} from '@cat-cafe/shared';
import { PAW_FEEL_OVERDUE_MS } from '../read-model-pagination.js';
import {
  availablePawFeelSourceHref,
  clampPawFeelPreview,
  pawFeelResponsibilityAge,
  unavailablePawFeelItem,
} from '../read-model-source.js';
import type { PawFeelReadSourceSnapshot } from './read-model-source-snapshot.js';

export function buildPawFeelInboxItem(input: {
  projection: PawFeelDispositionProjection;
  responsibility: PawFeelResponsibilityProjection;
  issue: PawFeelIssueProjection;
  sourceSnapshot?: PawFeelReadSourceSnapshot;
  nowMs: number;
}): PawFeelInboxItem {
  const { projection, responsibility, issue, sourceSnapshot, nowMs } = input;
  if (!sourceSnapshot || sourceSnapshot.availability === 'unavailable') {
    return unavailablePawFeelItem(
      projection,
      responsibility,
      issue,
      nowMs,
      sourceSnapshot?.reason ?? 'source read failed',
    );
  }
  const { candidate, message, sourceMarkerCount } = sourceSnapshot;
  const preview = clampPawFeelPreview(
    candidate.marker.tool ? `${candidate.marker.tool} · ${candidate.marker.symptom}` : candidate.marker.symptom,
  );
  const deterministicGroupKey = candidate.marker.tool
    ? `tool:${candidate.marker.tool.trim().toLowerCase()}`
    : undefined;
  const ageMs = pawFeelResponsibilityAge(projection, responsibility, nowMs);
  return {
    disposition: projection,
    responsibility,
    issue,
    source: {
      availability: 'available',
      preview,
      sourceHref: availablePawFeelSourceHref(projection),
      digestVerified: true,
    },
    sourceOccurredAt: candidate.occurredAt,
    ageMs,
    overdue: !responsibility.validExit && ageMs >= PAW_FEEL_OVERDUE_MS,
    reviewContext: {
      sourceMarkerCount,
      ...(message.extra?.stream?.turnInvocationId ? { turnInvocationId: message.extra.stream.turnInvocationId } : {}),
      ...(!message.extra?.stream?.turnInvocationId && message.extra?.stream?.invocationId
        ? { legacyInvocationId: message.extra.stream.invocationId }
        : {}),
    },
    ...(deterministicGroupKey ? { deterministicGroupKey } : {}),
  };
}
