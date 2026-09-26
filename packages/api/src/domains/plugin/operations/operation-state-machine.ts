import type { OperationActionResult } from '@clowder-ai/plugin-contract';

export interface OperationState {
  readonly currentAction: string;
  readonly lastResult?: { readonly render: string; readonly data: unknown; readonly label?: string };
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
  /** Legacy stores use this bit to retain the first polling timestamp. */
  readonly preserveUpdatedAt: boolean;
}

export interface TransitionOperationStateInput {
  readonly actions: readonly OperationActionDefinition[];
  readonly actionId: string;
  readonly currentState?: OperationState;
  readonly targetKeys?: readonly string[];
  readonly result: OperationActionResult;
  readonly now: number;
  /** Legacy connector polling remains frontend-governed until its routes are removed. */
  readonly enforceTimeout?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function persistedLastResult(
  result: OperationActionResult,
  previous: OperationState['lastResult'],
): NonNullable<OperationState['lastResult']> {
  const next = {
    render: result.render,
    data: result.data,
    ...(result.label ? { label: result.label } : {}),
  };
  if (result.advance !== false || result.render !== 'polling' || previous?.render !== 'img') return next;
  return {
    render: previous.render,
    data: isRecord(previous.data) && isRecord(result.data) ? { ...previous.data, ...result.data } : previous.data,
    ...(result.label ? { label: result.label } : previous.label ? { label: previous.label } : {}),
  };
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

/** Carrier-neutral, side-effect-free operation transition shared by legacy and package routes. */
export function transitionOperationState(input: TransitionOperationStateInput): OperationTransition {
  const action = input.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) throw new TypeError(`Action '${input.actionId}' is not declared`);
  if ((input.enforceTimeout ?? true) && timedOut(action, input.currentState, input.now)) {
    return {
      state: { currentAction: action.rollback!, updatedAt: input.now },
      decision: { kind: 'rollback', actionId: action.rollback! },
      targetValues: {},
      preserveUpdatedAt: false,
    };
  }

  const lastResult = persistedLastResult(input.result, input.currentState?.lastResult);
  if (input.result.advance === false) {
    return {
      state: {
        currentAction: action.id,
        lastResult,
        updatedAt: input.currentState?.updatedAt ?? input.now,
      },
      decision: { kind: 'stay', actionId: action.id },
      targetValues: {},
      preserveUpdatedAt: true,
    };
  }

  const nextAction = action.next ?? action.id;
  return {
    state: { currentAction: nextAction, lastResult, updatedAt: input.now },
    decision: { kind: 'next', actionId: nextAction },
    targetValues: declaredTargetValues(input.targetKeys ?? [], input.result),
    preserveUpdatedAt: false,
  };
}
