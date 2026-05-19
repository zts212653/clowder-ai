import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrajectoryStep } from './AntigravityBridge.js';
import type {
  AntigravityEffectKind,
  AntigravityEffectType,
  AntigravityStepEffect,
} from './antigravity-step-effects.js';

export type AntigravitySideEffectStatus = 'pending' | 'done' | 'failed' | 'unknown';

export interface AntigravitySideEffectJournalContext {
  threadId: string;
  catId: string;
  cascadeId: string;
  invocationId?: string;
}

export interface AntigravitySideEffectJournalEntry {
  invocationId?: string;
  threadId: string;
  catId: string;
  cascadeId: string;
  stepIndex?: number;
  stepId?: string;
  stepType: string;
  effectKind: AntigravityEffectKind;
  effectType?: AntigravityEffectType;
  operation: string;
  target?: string;
  status: AntigravitySideEffectStatus;
  retrySafe: boolean;
  idempotencyKey: string;
  observedAt: number;
}

export interface AntigravityExecutionJournalMetadata {
  approvalSent: boolean;
  dispatchAttempted: boolean;
  dispatchReturned: boolean;
  writebackSent: boolean;
}

export interface AntigravitySideEffectJournalSummary {
  entries: AntigravitySideEffectJournalEntry[];
  hasSideEffect: boolean;
  hasUnsafeSideEffect: boolean;
  hasCompletedSideEffect: boolean;
  hasFailedSideEffect: boolean;
  hasPendingOrUnknownSideEffect: boolean;
  blocksBlindRetry: boolean;
  dedupedEntryCount: number;
  retrySafeSummary: {
    safeToRetry: boolean;
    reason: 'no_side_effect' | 'all_side_effects_retry_safe' | 'unsafe_side_effect_seen';
    completedCount: number;
    pendingOrUnknownCount: number;
    failedCount: number;
  };
}

export interface AntigravitySideEffectJournalOptions extends AntigravitySideEffectJournalContext {
  auditDir?: string;
  now?: () => number;
}

interface BuildEntryInput {
  context: AntigravitySideEffectJournalContext;
  step: TrajectoryStep;
  stepIndex?: number;
  effect: AntigravityStepEffect;
  observedAt: number;
}

const SENSITIVE_TARGET_PATTERN =
  /(^|[/\\])(\.aws|\.ssh|\.gnupg)([/\\]|$)|(^|[/\\])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\.json)?|\.env(?:\..*)?)([/\\]|$)|(?:secret|token|password|api[_-]?key)/i;

function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function dateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function metadataString(step: TrajectoryStep, key: string): string | undefined {
  const value = step.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stepIdFromStep(step: TrajectoryStep, stepIndex: number | undefined): string | undefined {
  const source = step.metadata?.sourceTrajectoryStepInfo;
  if (source?.trajectoryId || source?.stepIndex != null || source?.metadataIndex != null) {
    return [source.trajectoryId, source.stepIndex, source.metadataIndex].filter((part) => part != null).join(':');
  }
  if (step.metadata?.toolCall?.id) return step.metadata.toolCall.id;
  return stepIndex == null ? undefined : String(stepIndex);
}

function operationFromStep(step: TrajectoryStep, effect: AntigravityStepEffect): string {
  const explicit = metadataString(step, 'operation');
  if (explicit) return explicit;
  if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') return 'run_command';
  if (step.type === 'CORTEX_STEP_TYPE_MCP_TOOL') return 'mcp_tool';
  if (step.type === 'CORTEX_STEP_TYPE_GENERATE_IMAGE') return 'generate_image';
  if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') return 'code_action';
  return effect.effectType ?? 'unknown';
}

function statusFromEffect(effect: AntigravityStepEffect): AntigravitySideEffectStatus {
  if (effect.completedSideEffect) return 'done';
  if (effect.failedSideEffect) return 'failed';
  if (effect.kind === 'side_effect_pending') return 'pending';
  return 'unknown';
}

function targetFromStep(step: TrajectoryStep, effect: AntigravityStepEffect): string | undefined {
  return (
    effect.target ??
    metadataString(step, 'path') ??
    step.runCommand?.commandLine ??
    step.runCommand?.proposedCommandLine ??
    step.toolCall?.toolName ??
    step.toolResult?.toolName ??
    step.metadata?.toolCall?.name ??
    step.generateImage?.imageName
  );
}

export function redactAntigravitySideEffectTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  return SENSITIVE_TARGET_PATTERN.test(target) ? '[REDACTED_TARGET]' : target;
}

function idempotencyKeyFor(input: {
  context: AntigravitySideEffectJournalContext;
  stepType: string;
  stepId?: string;
  operation: string;
  status: AntigravitySideEffectStatus;
  effectType?: string;
  target?: string;
  stepIndex?: number;
}): string {
  const scope = input.status === 'done' ? 'done' : input.status === 'failed' ? 'failed' : 'pending';
  const effectType = input.effectType ?? 'unknown';
  const stableMaterial =
    scope === 'done'
      ? [input.context.threadId, input.context.catId, effectType, input.operation, input.target ?? input.stepType].join(
          '|',
        )
      : [
          input.context.threadId,
          input.context.catId,
          input.context.cascadeId,
          input.stepId ?? input.stepIndex ?? input.stepType,
          effectType,
          input.operation,
          input.target ?? '',
        ].join('|');
  return `${scope}:${effectType}:${input.operation}:${hashKey(stableMaterial)}`;
}

export function buildAntigravitySideEffectJournalEntry(
  input: BuildEntryInput,
): AntigravitySideEffectJournalEntry | null {
  if (!input.effect.sideEffectCapable) return null;

  const operation = operationFromStep(input.step, input.effect);
  const rawTarget = targetFromStep(input.step, input.effect);
  const target = redactAntigravitySideEffectTarget(rawTarget);
  const status = statusFromEffect(input.effect);
  const stepId = stepIdFromStep(input.step, input.stepIndex);
  const idempotencyKey = idempotencyKeyFor({
    context: input.context,
    stepType: input.step.type,
    stepId,
    operation,
    status,
    effectType: input.effect.effectType,
    target: rawTarget,
    stepIndex: input.stepIndex,
  });

  return {
    ...(input.context.invocationId ? { invocationId: input.context.invocationId } : {}),
    threadId: input.context.threadId,
    catId: input.context.catId,
    cascadeId: input.context.cascadeId,
    ...(input.stepIndex == null ? {} : { stepIndex: input.stepIndex }),
    ...(stepId ? { stepId } : {}),
    stepType: input.step.type,
    effectKind: input.effect.kind,
    ...(input.effect.effectType ? { effectType: input.effect.effectType } : {}),
    operation,
    ...(target ? { target } : {}),
    status,
    retrySafe: !input.effect.blocksBlindRetry,
    idempotencyKey,
    observedAt: input.observedAt,
  };
}

export class AntigravitySideEffectJournal {
  private readonly context: AntigravitySideEffectJournalContext;
  private readonly auditDir: string | undefined;
  private readonly now: () => number;
  private readonly journalEntries: AntigravitySideEffectJournalEntry[] = [];
  private readonly seenDoneIdempotencyKeys = new Set<string>();
  private flushedEntryCount = 0;
  private dedupedCount = 0;

  constructor(options: AntigravitySideEffectJournalOptions) {
    this.context = {
      threadId: options.threadId,
      catId: options.catId,
      cascadeId: options.cascadeId,
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    };
    this.auditDir = options.auditDir;
    this.now = options.now ?? Date.now;
  }

  observeStep(input: { step: TrajectoryStep; stepIndex?: number; effect: AntigravityStepEffect }) {
    const entry = buildAntigravitySideEffectJournalEntry({
      context: this.context,
      step: input.step,
      stepIndex: input.stepIndex,
      effect: input.effect,
      observedAt: this.now(),
    });
    if (!entry) return null;
    if (entry.status === 'done') {
      if (this.seenDoneIdempotencyKeys.has(entry.idempotencyKey)) {
        this.dedupedCount += 1;
        return entry;
      }
      this.seenDoneIdempotencyKeys.add(entry.idempotencyKey);
    }
    this.journalEntries.push(entry);
    return entry;
  }

  entries(): AntigravitySideEffectJournalEntry[] {
    return this.journalEntries.map((entry) => ({ ...entry }));
  }

  summary(): AntigravitySideEffectJournalSummary {
    const entries = this.entries();
    const completedCount = entries.filter((entry) => entry.status === 'done').length;
    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    const pendingOrUnknownCount = entries.filter(
      (entry) => entry.status === 'pending' || entry.status === 'unknown',
    ).length;
    const hasUnsafeSideEffect = entries.some((entry) => !entry.retrySafe);
    const safeToRetry = entries.length === 0 || !hasUnsafeSideEffect;
    return {
      entries,
      hasSideEffect: entries.length > 0,
      hasUnsafeSideEffect,
      hasCompletedSideEffect: completedCount > 0,
      hasFailedSideEffect: failedCount > 0,
      hasPendingOrUnknownSideEffect: pendingOrUnknownCount > 0,
      blocksBlindRetry: hasUnsafeSideEffect,
      dedupedEntryCount: this.dedupedCount,
      retrySafeSummary: {
        safeToRetry,
        reason:
          entries.length === 0
            ? 'no_side_effect'
            : hasUnsafeSideEffect
              ? 'unsafe_side_effect_seen'
              : 'all_side_effects_retry_safe',
        completedCount,
        pendingOrUnknownCount,
        failedCount,
      },
    };
  }

  toExecutionJournal(input: AntigravityExecutionJournalMetadata): AntigravityExecutionJournalMetadata {
    const summary = this.summary();
    const observedCompletedOrFailed = [summary.hasCompletedSideEffect, summary.hasFailedSideEffect].some(Boolean);
    const dispatchAttempted = [input.dispatchAttempted, observedCompletedOrFailed].some(Boolean);
    const dispatchReturned = [input.dispatchReturned, observedCompletedOrFailed].some(Boolean);
    const writebackSent = [input.writebackSent, summary.hasCompletedSideEffect].some(Boolean);

    return {
      approvalSent: input.approvalSent,
      dispatchAttempted,
      dispatchReturned,
      writebackSent,
    };
  }

  async flushAudit(): Promise<void> {
    if (!this.auditDir || this.journalEntries.length === 0) return;
    const pendingEntries = this.journalEntries.slice(this.flushedEntryCount);
    if (pendingEntries.length === 0) return;
    await mkdir(this.auditDir, { recursive: true });
    const file = join(this.auditDir, `side-effect-journal-${dateKey(this.now())}.jsonl`);
    const lines = pendingEntries.map((entry) => JSON.stringify(entry)).join('\n');
    await appendFile(file, `${lines}\n`, 'utf-8');
    this.flushedEntryCount = this.journalEntries.length;
  }
}
