import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const keyedDigest = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const REQUEST_GENERATION_RETRY_REASONS = [
  'prompt_token_limit',
  'context_window_overflow',
  'cli_timeout',
  'malformed_toolcall',
  'missing_session',
  'transient_cli_exit',
  'provider_continuation',
  'provider_busy',
  'provider_fallback',
] as const;

export const requestGenerationSourceRefSchema = z
  .object({
    owner: z.enum([
      'message',
      'memory',
      'person_memory',
      'home_state',
      'skill',
      'runtime_context',
      'system_prompt',
      'transcript',
    ]),
    ref: nonEmpty,
  })
  .strict();

export const requestGenerationChannelSchema = z
  .object({
    channel: z.enum(['message', 'native_instruction', 'provider_native_hidden']),
    accuracy: z.enum(['exact', 'unsupported', 'unknown']),
    keyedContentDigest: keyedDigest.optional(),
    byteLength: z.number().int().nonnegative().optional(),
    body: z.string().optional(),
    sourceRefs: z.array(requestGenerationSourceRefSchema).max(64),
    injectionDecision: nonEmpty.optional(),
  })
  .strict()
  .superRefine((channel, context) => {
    if (channel.channel === 'provider_native_hidden' && channel.accuracy === 'exact') {
      context.addIssue({ code: 'custom', message: 'provider-native hidden channels cannot be exact' });
    }
    if (channel.accuracy === 'exact') {
      if (channel.body === undefined || channel.keyedContentDigest === undefined || channel.byteLength === undefined) {
        context.addIssue({ code: 'custom', message: 'exact channels require body, keyed digest, and byte length' });
      } else if (utf8ByteLength(channel.body) !== channel.byteLength) {
        context.addIssue({ code: 'custom', message: 'exact channel byte length does not match body' });
      }
      return;
    }
    if (channel.body !== undefined || channel.keyedContentDigest !== undefined || channel.byteLength !== undefined) {
      context.addIssue({ code: 'custom', message: 'unsupported or unknown channels cannot persist exact fields' });
    }
  });

export const requestGenerationPresentationSchema = z
  .object({
    owner: nonEmpty,
    kind: z.enum(['memory', 'person_memory', 'home_state', 'runtime_context', 'skill_hint']),
    sourceRefs: z.array(requestGenerationSourceRefSchema).max(64),
    decision: z.enum(['admitted', 'omitted']),
    renderedDigest: keyedDigest.optional(),
    reason: nonEmpty.max(160).optional(),
  })
  .strict();

export const sanitizedRequestedRuntimeConfigSchema = z
  .object({
    provider: nonEmpty,
    carrier: nonEmpty,
    model: nonEmpty.optional(),
    protocol: nonEmpty.optional(),
    reasoningEffort: nonEmpty.optional(),
    serviceTier: nonEmpty.optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    toolExecutionPolicy: z.enum(['read_only', 'workspace_write']).optional(),
  })
  .strict();

export const sanitizedObservedRuntimeConfigSchema = z
  .object({
    provider: nonEmpty,
    carrier: nonEmpty,
    model: nonEmpty.optional(),
    runtimeSessionId: nonEmpty.optional(),
    evidenceRef: nonEmpty,
  })
  .strict();

export const requestGenerationToolSurfaceSchema = z
  .object({
    declaredServerSetHash: keyedDigest.optional(),
    catCafeSchemaSetHash: keyedDigest.optional(),
    providerObservedSchemaSetHash: keyedDigest.optional(),
    finalSurface: z.enum(['exact', 'declared_only', 'unsupported', 'unknown']),
  })
  .strict()
  .superRefine((surface, context) => {
    if (surface.finalSurface === 'exact' && !surface.catCafeSchemaSetHash && !surface.providerObservedSchemaSetHash) {
      context.addIssue({ code: 'custom', message: 'exact tool surfaces require a schema-set hash' });
    }
    if (surface.finalSurface === 'declared_only' && !surface.declaredServerSetHash) {
      context.addIssue({ code: 'custom', message: 'declared-only tool surfaces require a server-set hash' });
    }
  });

export const requestGenerationEnvelopeV1Schema = z
  .object({
    v: z.literal(1),
    invocationId: nonEmpty,
    sessionId: nonEmpty,
    generationOrdinal: z.number().int().positive(),
    requestGenerationId: z.string().uuid(),
    promptGenerationId: keyedDigest,
    assembledAt: z.number().int().nonnegative(),
    continuity: z
      .object({
        coordinate: z
          .object({
            provider: nonEmpty,
            carrier: nonEmpty,
          })
          .strict()
          .optional(),
        contextEpoch: z.number().int().nonnegative().optional(),
        mode: z.enum(['cold', 'hot']).optional(),
        transition: nonEmpty.optional(),
        capability: z.enum(['exact', 'unsupported', 'unknown']),
        compactionRefs: z.array(nonEmpty).max(64),
      })
      .strict(),
    channels: z.array(requestGenerationChannelSchema).min(1).max(8),
    presentations: z.array(requestGenerationPresentationSchema).max(128),
    runtime: z
      .object({
        requested: sanitizedRequestedRuntimeConfigSchema,
        observed: sanitizedObservedRuntimeConfigSchema.optional(),
        providerNativeVisibility: z.enum(['unsupported', 'unknown']),
      })
      .strict(),
    tools: requestGenerationToolSurfaceSchema,
    retryBoundary: z
      .object({
        attempt: z.number().int().positive(),
        previousGenerationOrdinal: z.number().int().positive().optional(),
        reason: z.enum(REQUEST_GENERATION_RETRY_REASONS).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.retryBoundary.previousGenerationOrdinal !== undefined) {
      if (envelope.retryBoundary.previousGenerationOrdinal >= envelope.generationOrdinal) {
        context.addIssue({ code: 'custom', message: 'previous generation must precede the current ordinal' });
      }
      if (!envelope.retryBoundary.reason) {
        context.addIssue({ code: 'custom', message: 'retry generations require a bounded reason' });
      }
    } else if (envelope.generationOrdinal !== 1) {
      context.addIssue({ code: 'custom', message: 'non-initial generations require a previous ordinal' });
    }
  });

export const requestGenerationAssembledEventSchema = z
  .object({
    type: z.literal('request_generation_assembled'),
    envelope: requestGenerationEnvelopeV1Schema,
  })
  .strict();

export const requestGenerationObservedEventSchema = z
  .object({
    type: z.literal('request_generation_observed'),
    requestGenerationId: z.string().uuid(),
    generationOrdinal: z.number().int().positive(),
    observedAt: z.number().int().nonnegative(),
    evidence: sanitizedObservedRuntimeConfigSchema,
  })
  .strict();

export const requestGenerationTerminalEventSchema = z
  .object({
    type: z.literal('request_generation_terminal'),
    requestGenerationId: z.string().uuid(),
    generationOrdinal: z.number().int().positive(),
    terminalAt: z.number().int().nonnegative(),
    outcome: z.enum(['accepted', 'replaced', 'rejected', 'error', 'cancelled', 'unknown']),
    reason: nonEmpty.optional(),
  })
  .strict();

export type RequestGenerationRetryReason = (typeof REQUEST_GENERATION_RETRY_REASONS)[number];
export type RequestGenerationSourceRef = z.infer<typeof requestGenerationSourceRefSchema>;
export type RequestGenerationChannelV1 = z.infer<typeof requestGenerationChannelSchema>;
export type RequestGenerationPresentationV1 = z.infer<typeof requestGenerationPresentationSchema>;
export type SanitizedRequestedRuntimeConfigV1 = z.infer<typeof sanitizedRequestedRuntimeConfigSchema>;
export type SanitizedObservedRuntimeConfigV1 = z.infer<typeof sanitizedObservedRuntimeConfigSchema>;
export type RequestGenerationToolSurfaceV1 = z.infer<typeof requestGenerationToolSurfaceSchema>;
export type RequestGenerationEnvelopeV1 = z.infer<typeof requestGenerationEnvelopeV1Schema>;
export type RequestGenerationAssembledEvent = z.infer<typeof requestGenerationAssembledEventSchema>;
export type RequestGenerationObservedEvent = z.infer<typeof requestGenerationObservedEventSchema>;
export type RequestGenerationTerminalEvent = z.infer<typeof requestGenerationTerminalEventSchema>;

export type RequestGenerationSegmentState = 'available' | 'redacted' | 'deleted' | 'unknown';

export interface RequestGenerationChannelProjectionV1 extends Omit<RequestGenerationChannelV1, 'body'> {
  state: RequestGenerationSegmentState | 'unsupported';
  body?: string;
}

export interface RequestGenerationProjectionV1 {
  envelope: Omit<RequestGenerationEnvelopeV1, 'channels'> & {
    channels: RequestGenerationChannelProjectionV1[];
  };
  observed?: RequestGenerationObservedEvent;
  terminal?: RequestGenerationTerminalEvent;
}

export interface RequestGenerationGapV1 {
  kind: 'evidence_gap';
  fromOrdinal: number;
  toOrdinal: number;
  state: 'unknown';
  reason: 'ordinal_gap';
}
