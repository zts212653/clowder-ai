const PREFIX = 'eval:verdict-lifecycle:approval-history:v1';

/** Rebuildable refs/progress only. All content and lifecycle remain in the canonical event LISTs. */
export const EvalRepairHistoryKeys = {
  progress: `${PREFIX}:progress`,
  lock: `${PREFIX}:lock`,
  dirty: `${PREFIX}:dirty-subjects`,
  version: `${PREFIX}:version`,
  ownerCounts: `${PREFIX}:owner-counts`,
  owner: (owner: string) => `${PREFIX}:owner:${owner}`,
  subjectSequence: (subject: string) => `${PREFIX}:subject-sequence:${subject}`,
  proposalSubject: (proposal: string) => `${PREFIX}:proposal-subject:${proposal}`,
  proposalEvents: (proposal: string) => `${PREFIX}:proposal-events:${proposal}`,
} as const;

export const EVAL_HISTORY_EVENT_LIMIT = 8;
export const EVAL_HISTORY_BYTE_LIMIT = 256 * 1024;
