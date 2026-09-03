import { describe, expect, it } from 'vitest';
import {
  isProviderSemanticEvent,
  PROVIDER_SEMANTIC_EVENT_KINDS,
  type ProviderSemanticEvent,
} from '../types/provider-semantic-event.js';

function warning(provider: string): ProviderSemanticEvent {
  return {
    v: 1,
    id: `warning-${provider}`,
    kind: 'warning',
    occurredAt: 1_788_000_000_000,
    category: 'safety',
    severity: 'warning',
    message: 'Protected action was declined.',
    provenance: { provider, carrier: 'native', nativeType: 'provider/warning' },
  };
}

describe('F306 provider-neutral semantic event contract', () => {
  it('freezes the user-meaning vocabulary rather than provider wire names', () => {
    expect(PROVIDER_SEMANTIC_EVENT_KINDS).toEqual([
      'plan',
      'diff',
      'reasoning',
      'warning',
      'guardian',
      'capability',
      'goal',
      'review',
    ]);
  });

  it.each(['codex', 'claude', 'gemini', 'kimi'])('accepts the same semantic warning from %s provenance', (provider) => {
    expect(isProviderSemanticEvent(warning(provider))).toBe(true);
  });

  it('fails closed for missing identity, unknown kinds, and provider wire envelopes', () => {
    expect(isProviderSemanticEvent({ ...warning('codex'), id: '' })).toBe(false);
    expect(isProviderSemanticEvent({ ...warning('codex'), kind: 'codex/event/review_mode' })).toBe(false);
    expect(isProviderSemanticEvent({ method: 'thread/goal/updated', params: {} })).toBe(false);
    expect(isProviderSemanticEvent({ ...warning('codex'), rawProviderPayload: { secret: true } })).toBe(false);
    expect(
      isProviderSemanticEvent({
        ...warning('codex'),
        provenance: { provider: 'codex', carrier: 'native', rawWire: 'must not cross adapter' },
      }),
    ).toBe(false);
  });

  it('accepts every provider-neutral goal status and rejects unknown status values', () => {
    const base = {
      v: 1,
      id: 'goal:thread-1:2:updated',
      kind: 'goal',
      occurredAt: 123,
      state: 'updated',
      revision: 2,
      objective: 'Ship Phase C',
      source: 'codex_app_server',
      observedAt: 122,
    } as const;

    for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
      expect(isProviderSemanticEvent({ ...base, status })).toBe(true);
    }
    expect(isProviderSemanticEvent({ ...base, status: 'mystery' })).toBe(false);
  });

  it('keeps native review target and delivery provider-neutral', () => {
    expect(
      isProviderSemanticEvent({
        v: 1,
        id: 'review-start-1',
        kind: 'review',
        occurredAt: 1_788_000_000_000,
        reviewId: 'review-1',
        stage: 'started',
        summary: 'Review started',
        requestedAt: 1_787_999_999_900,
        target: { kind: 'base_branch', branch: 'origin/main' },
        delivery: 'detached',
        reviewThreadId: 'native-review-thread-1',
        turnId: 'native-turn-1',
      }),
    ).toBe(true);
    expect(
      isProviderSemanticEvent({
        v: 1,
        id: 'review-start-empty-coordinate',
        kind: 'review',
        occurredAt: 1_788_000_000_000,
        reviewId: 'review-1',
        stage: 'started',
        summary: 'Review started',
        reviewThreadId: '',
        turnId: 'native-turn-1',
      }),
    ).toBe(false);
    expect(
      isProviderSemanticEvent({
        v: 1,
        id: 'review-start-bad',
        kind: 'review',
        occurredAt: 1_788_000_000_000,
        reviewId: 'review-1',
        stage: 'started',
        summary: 'Review started',
        target: { kind: 'baseBranch', branch: '' },
      }),
    ).toBe(false);
    expect(
      isProviderSemanticEvent({
        v: 1,
        id: 'review-start-raw-wire',
        kind: 'review',
        occurredAt: 1_788_000_000_000,
        reviewId: 'review-1',
        stage: 'started',
        summary: 'Review started',
        target: { kind: 'commit', sha: 'abc1234', raw: { method: 'review/start' } },
      }),
    ).toBe(false);
  });
});
