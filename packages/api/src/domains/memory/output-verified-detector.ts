export interface OutputVerifiedSignalSources {
  getInvocationStatus(invocationId: string): Promise<string | null>;
  isPrMergedForThread(threadId: string): Promise<boolean>;
  /** AC-D2.1: operator (co-creator) explicitly accepted the output in thread messages */
  isCvoAcceptedForThread?(threadId: string): Promise<boolean>;
  /** AC-D2.1: A reviewer cat approved the output in thread messages */
  isReviewerApprovedForThread?(threadId: string): Promise<boolean>;
  /** AC-D2.2: CI checks passed for a PR associated with this thread */
  isCiPassedForThread?(threadId: string): Promise<boolean>;
}

export interface OutputVerifiedResult {
  verified: boolean;
  signals: string[];
}

/** Strong signals that indicate a trajectory's output was verified by external means. */
const STRONG_SIGNALS = ['pr_merged', 'cvo_accepted', 'reviewer_approved', 'ci_passed'];

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

    // AC-D2.1: operator accept (optional source — backward compatible)
    if (this.sources.isCvoAcceptedForThread) {
      try {
        const accepted = await this.sources.isCvoAcceptedForThread(threadId);
        if (accepted) signals.push('cvo_accepted');
      } catch {}
    }

    // AC-D2.1: Reviewer approval (optional source — backward compatible)
    if (this.sources.isReviewerApprovedForThread) {
      try {
        const approved = await this.sources.isReviewerApprovedForThread(threadId);
        if (approved) signals.push('reviewer_approved');
      } catch {}
    }

    // AC-D2.2: CI check passed (optional source — backward compatible)
    if (this.sources.isCiPassedForThread) {
      try {
        const passed = await this.sources.isCiPassedForThread(threadId);
        if (passed) signals.push('ci_passed');
      } catch {}
    }

    return {
      verified: signals.some((s) => STRONG_SIGNALS.includes(s)),
      signals,
    };
  }
}
