import type { ConsensusResult, TriageEntry, Verdict } from '@cat-cafe/shared';

export function resolveConsensus(entries: readonly TriageEntry[]): ConsensusResult {
  if (entries.length === 0) throw new Error('resolveConsensus requires at least one entry');

  if (entries.length === 1) {
    return {
      verdict: entries[0].verdict,
      needsOwner: false,
      reasonCode: entries[0].reasonCode,
      resolvedAt: Date.now(),
    };
  }

  const [a, b] = entries;

  if (a.verdict === 'WELCOME' && b.verdict === 'WELCOME') {
    return { verdict: 'WELCOME', needsOwner: false, resolvedAt: Date.now() };
  }

  if (a.verdict === 'POLITELY-DECLINE' && b.verdict === 'POLITELY-DECLINE') {
    return {
      verdict: 'POLITELY-DECLINE',
      needsOwner: false,
      reasonCode: a.reasonCode ?? b.reasonCode,
      resolvedAt: Date.now(),
    };
  }

  const verdict: Verdict = 'NEEDS-DISCUSSION';
  return {
    verdict,
    needsOwner: true,
    reasonCode: entries.find((e) => e.reasonCode)?.reasonCode,
    resolvedAt: Date.now(),
  };
}
