import type {
  HostSignatureOutput,
  MessageOutputOwner,
  MessageOutputUnavailableReason,
  OutputMessageIdentity,
} from '@cat-cafe/shared';

export interface OutputTextRun {
  kind: 'text';
  text: string;
  identity?: OutputMessageIdentity;
  channel?: 'commentary' | 'final';
  complete: boolean;
  paragraphBoundary: boolean;
  displayPrefix: boolean;
}

export interface OutputToolRef {
  kind: 'tool';
  toolEventId: string;
  executionRef: string;
}

export interface OutputHostTail {
  kind: 'host';
  text: string;
  observation: HostSignatureOutput;
}

/** Invocation-local pure accumulation, not another durable message/store. */
export interface MessageOutputState {
  owner: MessageOutputOwner;
  entries: readonly (OutputTextRun | OutputToolRef | OutputHostTail)[];
  reason?: MessageOutputUnavailableReason;
}

export interface MessageOutputTextInput {
  content: string;
  textMode?: unknown;
  outputMessage?: unknown;
  hostOutput?: unknown;
  /** Exact suffix actually removed by the native producer; invocation-local, never wire metadata. */
  nativeSignatureSuffix?: string;
  /** Trusted invocation-local sanitizer facts; never persisted as native metadata. */
  fragment?: { mode?: 'append'; complete: boolean; changed: boolean };
}
