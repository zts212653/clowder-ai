import type {
  AntigravitySideEffectJournalEntry,
  AntigravitySideEffectJournalSummary,
} from './AntigravitySideEffectJournal.js';
import type { AntigravityResumeTierDecision } from './antigravity-resume-tier.js';

export interface AntigravityResumeContext {
  cascadeId: string;
  interruptedAt: number;
  completedEffects: AntigravitySideEffectJournalEntry[];
  pendingOrUnknownEffects: AntigravitySideEffectJournalEntry[];
  resumeTierDecision?: AntigravityResumeTierDecision;
  instruction: 'continue_without_repeating_completed_side_effects';
}

export function buildAntigravityResumeContext(input: {
  cascadeId: string;
  interruptedAt: number;
  journalSummary: AntigravitySideEffectJournalSummary;
  resumeTierDecision?: AntigravityResumeTierDecision;
}): AntigravityResumeContext {
  const completedEffects = input.journalSummary.entries.filter((entry) => entry.status === 'done');
  const pendingOrUnknownEffects = input.journalSummary.entries.filter((entry) => entry.status !== 'done');

  return {
    cascadeId: input.cascadeId,
    interruptedAt: input.interruptedAt,
    completedEffects,
    pendingOrUnknownEffects,
    ...(input.resumeTierDecision ? { resumeTierDecision: input.resumeTierDecision } : {}),
    instruction: 'continue_without_repeating_completed_side_effects',
  };
}
