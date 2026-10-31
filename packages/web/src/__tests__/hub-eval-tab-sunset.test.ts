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
import {
  deriveDomainScheduleLine,
  deriveDomainStateBadge,
  deriveDomainVerdictLabel,
  VERDICT_LABELS,
} from '@/components/HubEvalTypes';

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

// F248 Phase A — domain STATE badge (lifecycle) is split from the latest
// VERDICT label (most-recent conclusion). The old `deriveDomainStatusBadge`
// conflated them, so a `build` verdict surfaced as the domain's status badge
// reading "需新建" — operators misread it as "this domain needs to be created".
// Now the state badge only ever shows Sunset / 待首次评估 / 运行中, and the
// verdict label is rendered separately with a "结论：" prefix.

describe('deriveDomainStateBadge (Sunset > 运行中 > 待首次评估)', () => {
  it('returns Sunset when enabled === false (overrides verdict presence)', () => {
    expect(deriveDomainStateBadge({ enabled: false, hasVerdict: true })).toBe('Sunset');
  });

  it('returns Sunset when enabled === false and no verdict exists', () => {
    expect(deriveDomainStateBadge({ enabled: false, hasVerdict: false })).toBe('Sunset');
  });

  it('returns 运行中 when enabled and a verdict exists', () => {
    expect(deriveDomainStateBadge({ enabled: true, hasVerdict: true })).toBe('运行中');
  });

  it('returns 待首次评估 when enabled and no verdict yet', () => {
    expect(deriveDomainStateBadge({ enabled: true, hasVerdict: false })).toBe('待首次评估');
  });
});

describe('deriveDomainVerdictLabel (latest conclusion, may be absent)', () => {
  it('returns the human verdict label when a verdict exists', () => {
    expect(deriveDomainVerdictLabel({ hasVerdict: true, latestVerdict: 'keep_observe' })).toBe(
      VERDICT_LABELS.keep_observe,
    );
    expect(deriveDomainVerdictLabel({ hasVerdict: true, latestVerdict: 'fix' })).toBe(VERDICT_LABELS.fix);
    expect(deriveDomainVerdictLabel({ hasVerdict: true, latestVerdict: 'build' })).toBe('建议新建能力');
  });

  it('returns undefined when no verdict exists', () => {
    expect(deriveDomainVerdictLabel({ hasVerdict: false })).toBeUndefined();
  });

  it('returns undefined when hasVerdict=true but latestVerdict is undefined (defensive)', () => {
    // hasVerdict true but latestVerdict undefined shouldn't happen in practice
    // (read-model couples them); defensively we must not render a stray label.
    expect(deriveDomainVerdictLabel({ hasVerdict: true })).toBeUndefined();
  });
});

describe('VERDICT_LABELS.build disambiguation (F248 Phase A)', () => {
  it('uses "建议新建能力" instead of the ambiguous "需新建"', () => {
    expect(VERDICT_LABELS.build).toBe('建议新建能力');
  });
});
