/**
 * F192 silent-fire fix (gpt52 R2 residual) — sunset rendering helper coverage.
 *
 * Pattern follows evidence-search.test.ts: pure helper logic extracted from
 * HubEvalTab JSX is unit-tested with vitest, avoiding @testing-library/react
 * / jsdom (web package has no component-render test infra). This closes the
 * test gap gpt52 flagged in PR #2130 R2 without expanding scope to a new
 * test framework dependency.
 */

import { describe, expect, it } from 'vitest';
import { deriveDomainScheduleLine, deriveDomainStatusBadge, VERDICT_LABELS } from '@/components/HubEvalTab';

describe('deriveDomainScheduleLine (sunset / next-eval / none)', () => {
  it('returns sunset line when enabled === false (even if nextCronFireAt is somehow present)', () => {
    const result = deriveDomainScheduleLine({
      enabled: false,
      nextCronFireAt: '2026-06-07T03:00:00.000Z',
    });
    expect(result.kind).toBe('sunset');
    if (result.kind === 'sunset') {
      expect(result.text).toContain('Sunset');
      expect(result.text).toContain('enabled: false');
      // Crucial: sunset wins even if a future fire time slips through —
      // operator must NEVER see "下次评估" for a sunset domain.
      expect(result.text).not.toContain('下次评估');
    }
  });

  it('returns sunset line when enabled === false and nextCronFireAt omitted', () => {
    const result = deriveDomainScheduleLine({ enabled: false });
    expect(result.kind).toBe('sunset');
  });

  it('returns next-eval line when enabled === true and nextCronFireAt set', () => {
    const result = deriveDomainScheduleLine({
      enabled: true,
      nextCronFireAt: '2026-06-07T03:00:00.000Z',
    });
    expect(result.kind).toBe('next-eval');
    if (result.kind === 'next-eval') {
      expect(result.text).toContain('下次评估');
    }
  });

  it('returns none when enabled === true and nextCronFireAt is omitted', () => {
    // Can occur during bootstrap / a transient backend state before next-fire
    // computation; UI should render nothing rather than a stale string.
    const result = deriveDomainScheduleLine({ enabled: true });
    expect(result.kind).toBe('none');
  });

  it('returns next-eval with "下次探测 (every-3d)" label for N-day domain (gpt52 R1 P2)', () => {
    // N-day domains: cron fires daily but gate decides if eval runs.
    // UI must show "下次探测" not "下次评估" to avoid false operator signal.
    const result = deriveDomainScheduleLine({
      enabled: true,
      nextCronFireAt: '2026-06-07T03:00:00.000Z',
      frequency: 'every-3d',
    });
    expect(result.kind).toBe('next-eval');
    if (result.kind === 'next-eval') {
      expect(result.text).toContain('下次探测');
      expect(result.text).toContain('every-3d');
      expect(result.text).not.toContain('下次评估');
    }
  });
});

describe('deriveDomainStatusBadge (Sunset > verdict label > 待首次评估)', () => {
  it('returns Sunset when enabled === false (overrides verdict)', () => {
    expect(
      deriveDomainStatusBadge({
        enabled: false,
        hasVerdict: true,
        latestVerdict: 'keep_observe',
      }),
    ).toBe('Sunset');
  });

  it('returns Sunset when enabled === false and no verdict exists', () => {
    expect(deriveDomainStatusBadge({ enabled: false, hasVerdict: false })).toBe('Sunset');
  });

  it('returns the verdict label when enabled and latestVerdict present', () => {
    expect(
      deriveDomainStatusBadge({
        enabled: true,
        hasVerdict: true,
        latestVerdict: 'keep_observe',
      }),
    ).toBe(VERDICT_LABELS.keep_observe);
    expect(
      deriveDomainStatusBadge({
        enabled: true,
        hasVerdict: true,
        latestVerdict: 'fix',
      }),
    ).toBe(VERDICT_LABELS.fix);
  });

  it('returns 待首次评估 when enabled, no verdict yet', () => {
    expect(deriveDomainStatusBadge({ enabled: true, hasVerdict: false })).toBe('待首次评估');
  });

  it('returns 待首次评估 when enabled and hasVerdict=true but latestVerdict is undefined (defensive)', () => {
    // hasVerdict true but latestVerdict undefined shouldn't happen in practice
    // (read-model couples them), but defensively the badge must not crash.
    expect(
      deriveDomainStatusBadge({
        enabled: true,
        hasVerdict: true,
      }),
    ).toBe('待首次评估');
  });
});
