/** Historical observation of one explicit DSH connection check, without credentials. */
export interface DshConnectionCheckFact {
  catId: string;
  attemptId: string;
  effectiveFingerprint: string;
  toolManifestHash: string;
  phase: 'started' | 'terminal';
  startedAt: number;
  finishedAt?: number;
  outcome?: 'passed' | 'partial' | 'failed' | 'unknown';
  reasonCode?: string;
}

/** A historical started fact is checking only while this API still owns its request. */
export interface DshConnectionCheckView {
  state: 'unchecked' | 'checking' | 'passed' | 'partial' | 'failed' | 'unknown' | 'stale';
  fact?: DshConnectionCheckFact;
  reasonCode?: string;
}
