import { describe, expect, it } from 'vitest';
import { metricRefKeyCandidates } from '../eval-metric-ref.js';

describe('metricRefKeyCandidates', () => {
  it('normalizes verdict prefixes, inline values, and component paths', () => {
    expect(metricRefKeyCandidates('metric:search_zero_hit_count')).toContain('search_zero_hit_count');
    expect(metricRefKeyCandidates('metric:c1.hold_zombie_count=1')).toContain('c1.hold_zombie_count');
    expect(metricRefKeyCandidates('ratio:shadow_live_ratio=1.04')).toContain('shadow_live_ratio');
    expect(metricRefKeyCandidates('metric:memory-recall/search_abandon_count')).toEqual(
      expect.arrayContaining(['search_abandon_count', 'memory-recall/search_abandon_count']),
    );
    expect(metricRefKeyCandidates('metric:legacyScheduledTaskIds=0')).toContain('legacyscheduledtaskids');
  });

  it('maps A2A Prometheus and OTel aliases to registry glossary keys', () => {
    expect(metricRefKeyCandidates('metric:cat_cafe_a2a_hold_expired_after_satisfied_total=1')).toContain(
      'hold_lifecycle.expired_after_satisfied_total',
    );
    expect(metricRefKeyCandidates('metric:cat_cafe.a2a.c2.verdict_without_pass_count_total')).toContain(
      'c2.verdict_without_pass_count',
    );
    expect(metricRefKeyCandidates('metric:cat_cafe_a2a_c2_verdict_without_pass_count{cat="codex"}=1')).toContain(
      'c2.verdict_without_pass_count',
    );
  });

  it('does not mislabel a ratio expression as either operand metric', () => {
    const candidates = metricRefKeyCandidates('metric:ratio:c2.verdict_without_pass_count/c2.checked=6.7%');

    expect(candidates).not.toContain('c2.checked');
    expect(candidates).not.toContain('c2.verdict_without_pass_count');
    expect(candidates).toContain('ratio:c2.verdict_without_pass_count/c2.checked');
  });

  it('generates dot-separated candidates from colon-separated provenance paths', () => {
    // Static provenance path: process:runtime_pid → process.runtime_pid
    const pidCandidates = metricRefKeyCandidates('metric:process:runtime_pid=97100:start=2026-07-15T20:57:16Z');
    expect(pidCandidates).toContain('process.runtime_pid');
  });

  it('strips hex SHA segments from colon-separated provenance paths', () => {
    // Dynamic commit SHA: commit:ce5199d88:terminal_release_warmup → commit.terminal_release_warmup
    const commitCandidates = metricRefKeyCandidates(
      'metric:commit:ce5199d88:terminal_release_warmup=2026-07-15T21:58:58Z',
    );
    expect(commitCandidates).toContain('commit.terminal_release_warmup');
    // Should also include the non-stripped dotted version
    expect(commitCandidates).toContain('commit.ce5199d88.terminal_release_warmup');
  });

  it('does not strip non-SHA colon segments', () => {
    // Two-segment path without SHA → only dotted, no stripping
    const candidates = metricRefKeyCandidates('metric:process:runtime_pid=123');
    expect(candidates).toContain('process.runtime_pid');
    // Should NOT produce just 'runtime_pid' (no SHA to strip)
    expect(candidates).not.toContain('runtime_pid');
  });
});
