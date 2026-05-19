import type { AntigravitySideEffectJournalSummary } from './AntigravitySideEffectJournal.js';
import type { AntigravityCascadeHealthSnapshot } from './antigravity-cascade-health.js';
import type { AntigravityResumeTierDecision } from './antigravity-resume-tier.js';

export type AntigravityRecoveryErrorCode = 'model_capacity' | 'network_error' | 'stream_error' | 'empty_response';

export type AntigravityDispatchRelevantStepKind =
  | 'none'
  | 'side_effect'
  | 'tool_read_shell'
  | 'tool_read_mcp'
  | 'tool_read'
  | 'unknown';

export interface AntigravityRecoveryDispatchState {
  hasDispatchRelevantStep: boolean;
  hasResolvedToolishStep: boolean;
  hasNativeDispatch: boolean;
  hasAttemptToolActivity: boolean;
  hasBatchToolActivity: boolean;
  toolishRetryEligible: boolean;
  dispatchRelevantStepKind: AntigravityDispatchRelevantStepKind;
  hasCooccurringUpstreamError?: boolean;
}

export interface AntigravityRecoveryRetryBudget {
  attemptsUsed: number;
  delaysMs: readonly number[];
}

export interface AntigravityRecoveryContext {
  errorCode: AntigravityRecoveryErrorCode;
  journalSummary: AntigravitySideEffectJournalSummary;
  dispatchState: AntigravityRecoveryDispatchState;
  retryBudget: AntigravityRecoveryRetryBudget;
  resumeTierDecision?: AntigravityResumeTierDecision;
  autoResumeEnabled?: boolean;
  resumeAttemptCount?: number;
  maxAutoResumeAttempts?: number;
  cascadeHealth?: Pick<AntigravityCascadeHealthSnapshot, 'level' | 'reasons' | 'retryableForEmptyResponse'>;
}

export type AntigravityRecoveryDecision =
  | {
      action: 'retry_fresh_cascade';
      reason: string;
      delayMs: number;
      journalSummary?: AntigravitySideEffectJournalSummary;
      resumeTierDecision?: AntigravityResumeTierDecision;
      resumeAttemptCount?: number;
    }
  | {
      action: 'surface_resumable_error';
      reason: string;
      journalSummary: AntigravitySideEffectJournalSummary;
      resumeTierDecision?: AntigravityResumeTierDecision;
    }
  | { action: 'surface_terminal_error'; reason: string };

type FreshCascadeRetryDecision = Extract<AntigravityRecoveryDecision, { action: 'retry_fresh_cascade' }>;

function retryDelay(ctx: AntigravityRecoveryContext): number | null {
  return ctx.retryBudget.delaysMs[ctx.retryBudget.attemptsUsed] ?? null;
}

function hasRetryBudget(ctx: AntigravityRecoveryContext): boolean {
  return retryDelay(ctx) != null;
}

function hasObservedSideEffect(summary: AntigravitySideEffectJournalSummary): boolean {
  return (
    summary.hasSideEffect ||
    summary.hasCompletedSideEffect ||
    summary.hasFailedSideEffect ||
    summary.hasPendingOrUnknownSideEffect ||
    summary.blocksBlindRetry
  );
}

function autoResumeDecision(ctx: AntigravityRecoveryContext): FreshCascadeRetryDecision | null {
  let maxAutoResumeAttempts = 1;
  if (ctx.maxAutoResumeAttempts !== undefined) maxAutoResumeAttempts = ctx.maxAutoResumeAttempts;
  let resumeAttemptCount = 0;
  if (ctx.resumeAttemptCount !== undefined) resumeAttemptCount = ctx.resumeAttemptCount;
  if (
    ctx.autoResumeEnabled === false ||
    ctx.resumeTierDecision?.canAutoResume !== true ||
    resumeAttemptCount >= maxAutoResumeAttempts
  ) {
    return null;
  }
  return {
    action: 'retry_fresh_cascade',
    reason: ctx.resumeTierDecision.tier,
    delayMs: 0,
    journalSummary: ctx.journalSummary,
    resumeTierDecision: ctx.resumeTierDecision,
    resumeAttemptCount: resumeAttemptCount + 1,
  };
}

function decidePostSideEffectRecovery(ctx: AntigravityRecoveryContext): AntigravityRecoveryDecision {
  const autoResume = autoResumeDecision(ctx);
  if (autoResume) return autoResume;
  return {
    action: 'surface_resumable_error',
    reason: ctx.errorCode === 'empty_response' ? 'empty_response_with_side_effect' : 'post_side_effect_interrupted',
    journalSummary: ctx.journalSummary,
    ...(ctx.resumeTierDecision ? { resumeTierDecision: ctx.resumeTierDecision } : {}),
  };
}

function decideEmptyResponseRecovery(ctx: AntigravityRecoveryContext): AntigravityRecoveryDecision {
  const delayMs = retryDelay(ctx);
  if (ctx.cascadeHealth?.retryableForEmptyResponse && delayMs != null) {
    return {
      action: 'retry_fresh_cascade',
      reason: 'empty_response_retryable_cascade_health',
      delayMs,
    };
  }
  return { action: 'surface_terminal_error', reason: 'empty_response_without_retryable_cascade_health' };
}

function terminalTransientReason(ctx: AntigravityRecoveryContext): string | null {
  if (!hasRetryBudget(ctx)) return 'retry_budget_exhausted';
  const { dispatchState } = ctx;
  if (dispatchState.hasCooccurringUpstreamError) return 'cooccurring_upstream_error';
  if (dispatchState.hasResolvedToolishStep) return 'resolved_toolish_step_seen';
  if (dispatchState.hasNativeDispatch) return 'native_dispatch_seen';
  if (dispatchState.hasAttemptToolActivity) return 'tool_activity_seen';
  if (dispatchState.hasBatchToolActivity) return 'tool_activity_seen';
  if (dispatchState.hasDispatchRelevantStep && !dispatchState.toolishRetryEligible) {
    return dispatchState.dispatchRelevantStepKind === 'tool_read_mcp'
      ? 'read_only_mcp_tool_transient_retry_intentionally_disabled'
      : 'toolish_step_present';
  }
  return null;
}

export function decideAntigravityRecovery(ctx: AntigravityRecoveryContext): AntigravityRecoveryDecision {
  if (hasObservedSideEffect(ctx.journalSummary)) return decidePostSideEffectRecovery(ctx);
  if (ctx.errorCode === 'empty_response') {
    return decideEmptyResponseRecovery(ctx);
  }

  const terminalReason = terminalTransientReason(ctx);
  if (terminalReason) return { action: 'surface_terminal_error', reason: terminalReason };

  const delayMs = retryDelay(ctx);
  if (delayMs == null) {
    return { action: 'surface_terminal_error', reason: 'retry_budget_exhausted' };
  }
  return {
    action: 'retry_fresh_cascade',
    reason: 'pre_side_effect_transient',
    delayMs,
  };
}
