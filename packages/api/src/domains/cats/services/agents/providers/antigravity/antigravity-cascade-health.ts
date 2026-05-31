import type { CascadeTrajectory, TrajectoryStep } from './AntigravityBridge.js';
import { classifyAntigravityStepEffect } from './antigravity-step-effects.js';

const MIB = 1024 * 1024;
const MAX_PLANNER_OUTPUT_CHARS = 500;

export type AntigravityCascadeHealthLevel = 'ok' | 'warn' | 'retire';

export interface AntigravityCascadeHealthThresholds {
  warnBytes: number;
  retireBytes: number;
  warnSteps: number;
  retireSteps: number;
}

export interface AntigravityCascadeHealthSnapshot {
  cascadeId: string;
  checkedAt: number;
  level: AntigravityCascadeHealthLevel;
  /** The cascade's run status at assessment time (e.g. CASCADE_RUN_STATUS_IDLE / _RUNNING). Callers use
   *  this to avoid retiring a cascade mid-turn — rotating a RUNNING cascade loses its in-progress work
   *  (F211-REG5: the busy-cascade reuse the rotation would undo). */
  cascadeStatus: string;
  stepCount: number;
  approximateTrajectoryBytes: number;
  thresholds: AntigravityCascadeHealthThresholds;
  reasons: string[];
  retryableForEmptyResponse: boolean;
  lastPlannerOutput?: {
    stepIndex: number;
    status: string;
    text: string;
  };
  lastSideEffectAt?: number;
}

export const DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS: AntigravityCascadeHealthThresholds = {
  warnBytes: Math.floor(1.5 * MIB),
  retireBytes: 2 * MIB,
  warnSteps: 150,
  retireSteps: 200,
};

type EnvLike = Record<string, string | undefined>;

function positiveFiniteNumber(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function cascadeHealthThresholdsFromEnv(env: EnvLike = process.env): AntigravityCascadeHealthThresholds {
  return {
    warnBytes: positiveFiniteNumber(
      env.ANTIGRAVITY_CASCADE_WARN_BYTES,
      DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.warnBytes,
    ),
    retireBytes: positiveFiniteNumber(
      env.ANTIGRAVITY_CASCADE_RETIRE_BYTES,
      DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.retireBytes,
    ),
    warnSteps: positiveFiniteNumber(
      env.ANTIGRAVITY_CASCADE_WARN_STEPS,
      DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.warnSteps,
    ),
    retireSteps: positiveFiniteNumber(
      env.ANTIGRAVITY_CASCADE_RETIRE_STEPS,
      DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.retireSteps,
    ),
  };
}

function trajectoryBytes(trajectory: CascadeTrajectory): number {
  try {
    return Buffer.byteLength(JSON.stringify(trajectory), 'utf8');
  } catch {
    return 0;
  }
}

function truncatePlannerOutput(text: string): string {
  return text.length > MAX_PLANNER_OUTPUT_CHARS ? `${text.slice(0, MAX_PLANNER_OUTPUT_CHARS)}...` : text;
}

function plannerOutputText(step: TrajectoryStep): string | undefined {
  const text = [
    step.plannerResponse?.modifiedResponse,
    step.plannerResponse?.response,
    step.plannerResponse?.thinking,
  ].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  return text ? truncatePlannerOutput(text.trim()) : undefined;
}

function lastPlannerOutput(steps: TrajectoryStep[]): AntigravityCascadeHealthSnapshot['lastPlannerOutput'] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) continue;
    if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
    const text = plannerOutputText(step);
    if (!text) continue;
    return { stepIndex: i, status: step.status, text };
  }
  return undefined;
}

function timestampFromStep(step: TrajectoryStep, fallback: number): number {
  const candidates = [step.metadata?.observedAt, step.metadata?.timestamp, step.metadata?.createdAt];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function lastSideEffectAt(steps: TrajectoryStep[], checkedAt: number): number | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) continue;
    const effect = classifyAntigravityStepEffect(step);
    if (effect.sideEffectCapable) return timestampFromStep(step, checkedAt);
    if (effect.blocksBlindRetry) return timestampFromStep(step, checkedAt);
  }
  return undefined;
}

export function assessAntigravityCascadeHealth(input: {
  cascadeId: string;
  trajectory: CascadeTrajectory;
  checkedAt?: number;
  thresholds?: AntigravityCascadeHealthThresholds;
}): AntigravityCascadeHealthSnapshot {
  const checkedAt = input.checkedAt === undefined ? Date.now() : input.checkedAt;
  const thresholds = input.thresholds === undefined ? cascadeHealthThresholdsFromEnv() : input.thresholds;
  const steps = Array.isArray(input.trajectory.trajectory?.steps) ? input.trajectory.trajectory.steps : [];
  const totalSteps = input.trajectory.numTotalSteps === undefined ? 0 : input.trajectory.numTotalSteps;
  const stepCount = Math.max(totalSteps, steps.length);
  const approximateTrajectoryBytes = trajectoryBytes(input.trajectory);
  const reasons: string[] = [];

  if (stepCount >= thresholds.retireSteps) reasons.push('step_count_retire_threshold');
  if (approximateTrajectoryBytes >= thresholds.retireBytes) reasons.push('trajectory_bytes_retire_threshold');
  const hasRetireReason = reasons.length > 0;

  if (!hasRetireReason && stepCount >= thresholds.warnSteps) reasons.push('step_count_warn_threshold');
  if (!hasRetireReason && approximateTrajectoryBytes >= thresholds.warnBytes) {
    reasons.push('trajectory_bytes_warn_threshold');
  }

  const level: AntigravityCascadeHealthLevel = hasRetireReason ? 'retire' : reasons.length > 0 ? 'warn' : 'ok';
  const plannerOutput = lastPlannerOutput(steps);
  const sideEffectAt = lastSideEffectAt(steps, checkedAt);

  return {
    cascadeId: input.cascadeId,
    checkedAt,
    level,
    cascadeStatus: input.trajectory.status,
    stepCount,
    approximateTrajectoryBytes,
    thresholds,
    reasons,
    retryableForEmptyResponse: level === 'retire' && sideEffectAt === undefined,
    ...(plannerOutput ? { lastPlannerOutput: plannerOutput } : {}),
    ...(sideEffectAt ? { lastSideEffectAt: sideEffectAt } : {}),
  };
}
