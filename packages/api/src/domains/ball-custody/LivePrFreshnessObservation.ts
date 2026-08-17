/**
 * A one-shot, server-owned GitHub observation used only to bootstrap the first
 * review action before either durable producer has observed that PR.
 */
export interface LivePrFreshnessSnapshot {
  subjectRef: string;
  headSha: string;
  prState: 'open' | 'merged' | 'closed';
}

export interface LivePrFreshnessObservationInput {
  subjectRef: string;
  repoFullName: string;
  prNumber: number;
}

export interface LivePrFreshnessProvider {
  observe(input: LivePrFreshnessObservationInput): Promise<LivePrFreshnessSnapshot | null>;
}

export type LivePrFreshnessResolution =
  | { status: 'verified'; evidenceRef: string }
  | { status: 'mismatch' | 'insufficient'; reason: string };

function parseLivePrFreshnessObservation(subjectRef: string): LivePrFreshnessObservationInput | null {
  const match = /^pr:([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/.exec(subjectRef);
  if (!match) return null;
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) return null;
  const prNumber = Number(number);
  if (!Number.isSafeInteger(prNumber)) return null;
  return { subjectRef, repoFullName: `${owner}/${repo}`, prNumber };
}

export async function resolveLivePrFreshnessObservation(
  subjectRef: string,
  expectedHeadSha: string | undefined,
  provider?: LivePrFreshnessProvider,
): Promise<LivePrFreshnessResolution | null> {
  if (!provider) return null;
  const observation = parseLivePrFreshnessObservation(subjectRef);
  if (!observation) return { status: 'insufficient', reason: 'bootstrap PR observation unavailable' };

  let livePr: LivePrFreshnessSnapshot | null;
  try {
    livePr = await provider.observe(observation);
  } catch {
    return { status: 'insufficient', reason: 'bootstrap PR observation unavailable' };
  }
  if (!livePr) return null;
  if (livePr.subjectRef !== subjectRef) {
    return { status: 'insufficient', reason: 'bootstrap PR observation subject mismatch' };
  }
  if (livePr.prState !== 'open') {
    return { status: 'mismatch', reason: 'bootstrap observation reports a terminal PR' };
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(livePr.headSha)) {
    return { status: 'insufficient', reason: 'bootstrap PR HEAD unavailable' };
  }
  if (livePr.headSha !== expectedHeadSha) {
    return { status: 'mismatch', reason: 'predicate HEAD is not the bootstrap-observed current HEAD' };
  }
  return { status: 'verified', evidenceRef: `github:${subjectRef}:head:${livePr.headSha}` };
}
