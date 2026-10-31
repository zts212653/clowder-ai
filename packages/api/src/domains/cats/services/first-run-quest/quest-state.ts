/**
 * F171: First-Run Quest state machine.
 * Tracks user progress through the gamified onboarding flow.
 */

export const QUEST_PHASES = [
  'quest-0-welcome',
  'quest-1-create-first-cat',
  'quest-2-cat-intro',
  'quest-3-task-select',
  'quest-4-task-running',
  'quest-5-error-encountered',
  'quest-6-second-cat-prompt',
  'quest-7-second-cat-created',
  'quest-8-collaboration-demo',
  'quest-9-completion',
] as const;

export type QuestPhase = (typeof QUEST_PHASES)[number];

export interface FirstRunQuestState {
  v: 1;
  phase: QuestPhase;
  startedAt: number;
  completedAt?: number;
  firstCatId?: string;
  firstCatName?: string;
  secondCatId?: string;
  secondCatName?: string;
  selectedTaskId?: string;
  /** Whether a real error was encountered during task execution */
  errorDetected?: boolean;
}

const PHASE_INDEX = new Map(QUEST_PHASES.map((p, i) => [p, i]));

/**
 * Validate that a phase transition is forward-only.
 * Returns null if invalid, new phase if valid.
 */
export function validateQuestTransition(current: QuestPhase, next: QuestPhase): QuestPhase | null {
  const currentIdx = PHASE_INDEX.get(current);
  const nextIdx = PHASE_INDEX.get(next);
  if (currentIdx === undefined || nextIdx === undefined) return null;
  // Allow forward-only, and allow skipping to completion
  if (nextIdx > currentIdx) return next;
  return null;
}

export function createInitialQuestState(): FirstRunQuestState {
  return {
    v: 1,
    phase: 'quest-0-welcome',
    startedAt: Date.now(),
  };
}
