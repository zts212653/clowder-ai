import type { TrajectoryStep } from './AntigravityBridge.js';

function getPlannerText(step: TrajectoryStep): string | null {
  const planner = step.plannerResponse;
  if (!planner) return null;
  return planner.modifiedResponse ?? planner.response ?? null;
}

function clonePlannerStepWithText(step: TrajectoryStep, text: string): TrajectoryStep {
  const plannerResponse = { ...(step.plannerResponse ?? {}) };
  // Thinking was already emitted on first delivery — strip it from replay steps
  // to prevent duplicate system_info emissions on every delta poll cycle.
  delete plannerResponse.thinking;
  if (plannerResponse.modifiedResponse !== undefined) {
    plannerResponse.modifiedResponse = text;
  } else if (plannerResponse.response !== undefined) {
    plannerResponse.response = text;
  } else {
    plannerResponse.modifiedResponse = text;
  }
  return { ...step, plannerResponse };
}

function toReplayStep(step: TrajectoryStep, previousPlannerText: string): TrajectoryStep | null {
  const currentPlannerText = getPlannerText(step);
  if (currentPlannerText == null) return step;
  if (!previousPlannerText) return step;
  if (currentPlannerText === previousPlannerText) return null;

  // Antigravity plannerResponse text normally grows by suffix append. Preserve the
  // stream append contract by emitting only the new suffix when that holds.
  if (currentPlannerText.startsWith(previousPlannerText)) {
    const delta = currentPlannerText.slice(previousPlannerText.length);
    if (!delta) return null;
    return clonePlannerStepWithText(step, delta);
  }

  // Non-prefix rewrites are rare. Fall back to the full snapshot so we do not
  // silently drop the update, even though append-only consumers may duplicate text.
  return step;
}

function fingerprintStep(step: TrajectoryStep): string {
  return JSON.stringify({
    type: step.type,
    status: step.status,
    plannerResponse: step.plannerResponse
      ? {
          response: step.plannerResponse.response,
          modifiedResponse: step.plannerResponse.modifiedResponse,
          thinking: step.plannerResponse.thinking,
          stopReason: step.plannerResponse.stopReason,
        }
      : undefined,
    errorMessage: step.errorMessage?.error
      ? {
          userErrorMessage: step.errorMessage.error.userErrorMessage,
          modelErrorMessage: step.errorMessage.error.modelErrorMessage,
        }
      : undefined,
    toolCall: step.toolCall
      ? {
          toolName: step.toolCall.toolName,
          input: step.toolCall.input,
        }
      : undefined,
    toolResult: step.toolResult
      ? {
          toolName: step.toolResult.toolName,
          success: step.toolResult.success,
          output: step.toolResult.output,
          error: step.toolResult.error,
        }
      : undefined,
    runCommand: step.runCommand
      ? {
          commandLine: step.runCommand.commandLine,
          proposedCommandLine: step.runCommand.proposedCommandLine,
          cwd: step.runCommand.cwd,
          shouldAutoRun: step.runCommand.shouldAutoRun,
          blocking: step.runCommand.blocking,
          stdout: step.runCommand.stdout,
          stderr: step.runCommand.stderr,
          exitCode: step.runCommand.exitCode,
        }
      : undefined,
    error: step.error
      ? {
          shortError: step.error.shortError,
          fullError: step.error.fullError,
        }
      : undefined,
  });
}

export function diffDeliveredSteps(
  allSteps: TrajectoryStep[],
  deliveredCount: number,
  previousFingerprints: string[],
  previousPlannerTexts: string[],
): {
  replaySteps: TrajectoryStep[];
  nextFingerprints: string[];
  nextPlannerTexts: string[];
  hadMutation: boolean;
} {
  const replaySteps: TrajectoryStep[] = [];
  const nextFingerprints = allSteps.map(fingerprintStep);
  const nextPlannerTexts = allSteps.map((step) => getPlannerText(step) ?? '');
  let hadMutation = false;

  for (let index = 0; index < Math.min(deliveredCount, allSteps.length); index += 1) {
    if (previousFingerprints[index] === nextFingerprints[index]) continue;
    hadMutation = true;
    const replayStep = toReplayStep(allSteps[index], previousPlannerTexts[index] ?? '');
    if (replayStep) replaySteps.push(replayStep);
  }

  return { replaySteps, nextFingerprints, nextPlannerTexts, hadMutation };
}
