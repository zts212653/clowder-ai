import { type RoutingPreflightDecisionV1, routingPreflightDecisionV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';

export type RoutingDispatchFailureClass =
  | 'quota_exhausted'
  | 'authentication_rejected'
  | 'provider_unreachable'
  | 'provider_timeout';

export interface RoutingDispatchFailureEvidence {
  cliReasonCode?: string;
  providerErrorCode?: string;
  terminalReason?: string;
}

export interface RoutingDispatchTerminalEvidence {
  ownerId: string;
  observationId: string;
  observedAt: number;
  evidenceRef: string;
  catId: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  failureClass?: RoutingDispatchFailureClass;
  preflightDecision: RoutingPreflightDecisionV1;
}

export interface RoutingDispatchTerminalObserver {
  observeTerminal(input: RoutingDispatchTerminalEvidence): Promise<readonly RoutingSignalEventAppendResult[]>;
}

const boundedId = z.string().trim().min(1).max(200);
const ownerId = z.string().trim().min(1).max(120);
const boundedRef = z.string().trim().min(1).max(500);
const failureClassSchema = z.enum([
  'quota_exhausted',
  'authentication_rejected',
  'provider_unreachable',
  'provider_timeout',
]);

export const routingDispatchTerminalEvidenceSchema = z
  .object({
    ownerId,
    observationId: boundedId,
    observedAt: z.number().int().finite().nonnegative(),
    evidenceRef: boundedRef,
    catId: ownerId,
    status: z.enum(['succeeded', 'failed', 'canceled', 'interrupted']),
    failureClass: failureClassSchema.optional(),
    preflightDecision: routingPreflightDecisionV1Schema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.status !== 'failed' && evidence.failureClass !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureClass'],
        message: 'only failed dispatch terminals may carry a failure class',
      });
    }
    if (evidence.preflightDecision.ownerId !== evidence.ownerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preflightDecision', 'ownerId'],
        message: 'dispatch terminal and preflight decision must belong to the same owner',
      });
    }
    if (!evidence.preflightDecision.targets.some((target) => target.targetCatId === evidence.catId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preflightDecision', 'targets'],
        message: 'dispatch terminal requires preflight evidence for the exact cat',
      });
    }
    if (evidence.observedAt < evidence.preflightDecision.observedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedAt'],
        message: 'durable dispatch terminal cannot predate its preflight decision',
      });
    }
  });

const CLI_FAILURE_CLASSES: Readonly<Record<string, RoutingDispatchFailureClass>> = {
  quota_exceeded: 'quota_exhausted',
  auth_failed: 'authentication_rejected',
  network_error: 'provider_unreachable',
  cli_response_timeout: 'provider_timeout',
  cli_stall_timeout: 'provider_timeout',
};

const PROVIDER_FAILURE_CLASSES: Readonly<Record<string, RoutingDispatchFailureClass>> = {
  quota_exceeded: 'quota_exhausted',
  quota_exhausted: 'quota_exhausted',
  auth_failed: 'authentication_rejected',
  authentication_rejected: 'authentication_rejected',
  network_error: 'provider_unreachable',
  provider_unreachable: 'provider_unreachable',
  runtime_disconnected: 'provider_unreachable',
  stream_idle_stall: 'provider_timeout',
  turn_budget_exceeded: 'provider_timeout',
  provider_timeout: 'provider_timeout',
};

const TERMINAL_FAILURE_CLASSES: Readonly<Record<string, RoutingDispatchFailureClass>> = {
  invocation_timeout: 'provider_timeout',
};

export function classifyRoutingDispatchFailure(
  evidence: RoutingDispatchFailureEvidence,
): RoutingDispatchFailureClass | undefined {
  if (evidence.cliReasonCode) {
    const classified = CLI_FAILURE_CLASSES[evidence.cliReasonCode];
    if (classified) return classified;
  }
  if (evidence.providerErrorCode) {
    const classified = PROVIDER_FAILURE_CLASSES[evidence.providerErrorCode];
    if (classified) return classified;
  }
  if (evidence.terminalReason) return TERMINAL_FAILURE_CLASSES[evidence.terminalReason];
  return undefined;
}
