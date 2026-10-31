import type { OperationActionResult } from '@clowder-ai/plugin-contract';

export interface OperationState {
  readonly currentAction: string;
  readonly updatedAt?: number;
}

export interface OperationActionDefinition {
  readonly id: string;
  readonly next?: string;
  readonly rollback?: string;
  readonly timeout?: number;
}

export interface OperationTransition {
  readonly state: OperationState;
  readonly decision: {
    readonly kind: 'next' | 'stay' | 'rollback';
    readonly actionId: string;
  };
  readonly targetValues: Readonly<Record<string, string>>;
}

export interface TransitionOperationStateInput {
  readonly actions: readonly OperationActionDefinition[];
  readonly actionId: string;
  readonly currentState?: OperationState;
  readonly targetKeys?: readonly string[];
  readonly result: OperationActionResult;
  readonly now: number;
}

function timedOut(action: OperationActionDefinition, currentState: OperationState | undefined, now: number): boolean {
  return (
    action.rollback !== undefined &&
    action.timeout !== undefined &&
    currentState?.currentAction === action.id &&
    currentState.updatedAt !== undefined &&
    now - currentState.updatedAt >= action.timeout * 1_000
  );
}

function declaredTargetValues(
  targetKeys: readonly string[],
  result: OperationActionResult,
): Readonly<Record<string, string>> {
  if (result.advance === false || !result.targetValues) return {};
  const values: Record<string, string> = {};
  for (const key of targetKeys) {
    const value = result.targetValues[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** Side-effect-free transition of a manifest-declared operation step. */
export function transitionOperationState(input: TransitionOperationStateInput): OperationTransition {
  const action = input.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) throw new TypeError(`Action '${input.actionId}' is not declared`);
  if (timedOut(action, input.currentState, input.now)) {
    return {
      state: { currentAction: action.rollback!, updatedAt: input.now },
      decision: { kind: 'rollback', actionId: action.rollback! },
      targetValues: {},
    };
  }

  if (input.result.advance === false) {
    return {
      state: {
        currentAction: action.id,
        updatedAt: input.currentState?.updatedAt ?? input.now,
      },
      decision: { kind: 'stay', actionId: action.id },
      targetValues: {},
    };
  }

  const nextAction = action.next ?? action.id;
  return {
    state: { currentAction: nextAction, updatedAt: input.now },
    decision: { kind: 'next', actionId: nextAction },
    targetValues: declaredTargetValues(input.targetKeys ?? [], input.result),
  };
}
