import type {
  PawFeelDispositionProjection,
  PawFeelInboxItem,
  PawFeelResponsibilityProjection,
  PawFeelSourceResolution,
} from '@cat-cafe/shared';
import { PAW_FEEL_OVERDUE_MS } from './read-model-pagination.js';

function sourceHref(projection: PawFeelDispositionProjection): string {
  return `/thread/${encodeURIComponent(projection.sourceThreadId)}?message=${encodeURIComponent(
    projection.sourceMessageId,
  )}`;
}

function unavailableSource(projection: PawFeelDispositionProjection, reason: string): PawFeelSourceResolution {
  return { availability: 'unavailable', reason, sourceHref: sourceHref(projection) };
}

export function clampPawFeelPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}

export function pawFeelResponsibilityAge(
  projection: PawFeelDispositionProjection,
  responsibility: PawFeelResponsibilityProjection,
  nowMs: number,
): number {
  const discoveredAt = Date.parse(projection.discoveredAt);
  const endAt = responsibility.validExit ? Date.parse(projection.lastTransitionAt) : nowMs;
  return Math.max(0, endAt - discoveredAt);
}

export function unavailablePawFeelItem(
  projection: PawFeelDispositionProjection,
  responsibility: PawFeelResponsibilityProjection,
  nowMs: number,
  reason: string,
): PawFeelInboxItem {
  const ageMs = pawFeelResponsibilityAge(projection, responsibility, nowMs);
  return {
    disposition: projection,
    responsibility,
    source: unavailableSource(projection, reason),
    ageMs,
    overdue: !responsibility.validExit && ageMs >= PAW_FEEL_OVERDUE_MS,
  };
}

export function availablePawFeelSourceHref(projection: PawFeelDispositionProjection): string {
  return sourceHref(projection);
}
