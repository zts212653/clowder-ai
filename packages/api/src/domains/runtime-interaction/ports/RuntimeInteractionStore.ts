import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';

export interface CreateRuntimeInteractionInput {
  request: RuntimeInteractionRequest;
  hostEpoch: string;
  now: number;
}

export interface SettleRuntimeInteractionInput {
  interactionId: string;
  hostEpoch: string;
  terminal: RuntimeInteractionTerminal;
  now: number;
}

export interface InvalidateRuntimeInteractionInput {
  interactionId: string;
  reasonCode: RuntimeInteractionTerminalReasonCode;
  now: number;
}

export interface RuntimeInteractionStore {
  createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord>;
  anchor(
    interactionId: string,
    hostEpoch: string,
    cardRef: RuntimeInteractionCardRef,
    now: number,
  ): Promise<RuntimeInteractionRecord | null>;
  settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null>;
  invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null>;
  invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]>;
  invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]>;
  get(interactionId: string): Promise<RuntimeInteractionRecord | null>;
  listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]>;
}
