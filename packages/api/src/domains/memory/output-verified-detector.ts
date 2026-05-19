export interface OutputVerifiedSignalSources {
  getInvocationStatus(invocationId: string): Promise<string | null>;
  isPrMergedForThread(threadId: string): Promise<boolean>;
}

export interface OutputVerifiedResult {
  verified: boolean;
  signals: string[];
}

export class OutputVerifiedDetector {
  constructor(private readonly sources: OutputVerifiedSignalSources) {}

  async detect(invocationId: string, threadId: string): Promise<OutputVerifiedResult> {
    const signals: string[] = [];

    try {
      const status = await this.sources.getInvocationStatus(invocationId);
      if (status === 'succeeded') signals.push('invocation_succeeded');
    } catch {}

    try {
      const merged = await this.sources.isPrMergedForThread(threadId);
      if (merged) signals.push('pr_merged');
    } catch {}

    const STRONG_SIGNALS = ['pr_merged', 'cvo_accepted', 'reviewer_approved'];
    return {
      verified: signals.some((s) => STRONG_SIGNALS.includes(s)),
      signals,
    };
  }
}
