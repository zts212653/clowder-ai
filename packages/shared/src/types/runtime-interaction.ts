import { z } from 'zod';
import { entrustedWorkTaskRefV1Schema } from './growing.js';

const nonBlank = z.string().trim().min(1);
const optionalProviderCoordinate = z.string().nullable().optional();

export const runtimeInteractionOwnerSchema = z
  .object({
    userId: nonBlank,
    threadId: nonBlank,
    catId: nonBlank,
    invocationId: nonBlank,
  })
  .strict();

export const runtimeInteractionProviderRefSchema = z
  .object({
    providerId: nonBlank,
    method: nonBlank,
    requestId: z.union([nonBlank, z.number().int()]),
    threadId: optionalProviderCoordinate,
    turnId: optionalProviderCoordinate,
    itemId: optionalProviderCoordinate,
  })
  .strict();

export const runtimeInteractionDecisionSchema = z
  .object({
    id: nonBlank,
    label: nonBlank,
    description: z.string().optional(),
    outcome: z.enum(['accept', 'decline', 'cancel']),
  })
  .strict();

const questionOptionSchema = z
  .object({
    label: nonBlank,
    description: z.string().optional(),
  })
  .strict();

const runtimeQuestionSchema = z
  .object({
    id: nonBlank,
    header: nonBlank,
    question: nonBlank,
    isOther: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    options: z.array(questionOptionSchema).min(1).optional(),
  })
  .strict();

const primitiveValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const runtimeInteractionPrimitivePropertySchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    title: z.string().optional(),
    description: z.string().optional(),
    default: primitiveValueSchema.optional(),
    enum: z.array(primitiveValueSchema).min(1).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((property, context) => {
    if (property.default !== undefined && !matchesPropertyType(property.type, property.default)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `property default must match declared ${property.type} type`,
      });
    }
    if (property.enum?.some((value) => !matchesPropertyType(property.type, value))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `property enum values must match declared ${property.type} type`,
      });
    }
  });

export const runtimeInteractionObjectSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(nonBlank, runtimeInteractionPrimitivePropertySchema),
    required: z.array(nonBlank).optional(),
    additionalProperties: z.literal(false),
  })
  .strict()
  .superRefine((schema, context) => {
    const propertyIds = new Set(Object.keys(schema.properties));
    const required = schema.required ?? [];
    if (new Set(required).size !== required.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'schema required ids must be unique' });
    }
    for (const id of required) {
      if (!propertyIds.has(id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `schema required property ${id} is missing` });
      }
    }
  });

const baseRequestSchema = z.object({
  version: z.literal(1),
  interactionId: nonBlank,
  owner: runtimeInteractionOwnerSchema,
  provider: runtimeInteractionProviderRefSchema,
  createdAt: z.number().int().nonnegative(),
  title: nonBlank,
  description: z.string().optional(),
  entrustedWorkTaskRef: entrustedWorkTaskRefV1Schema.optional(),
});

const approvalRequestSchema = baseRequestSchema
  .extend({
    kind: z.literal('approval'),
    decisions: z.array(runtimeInteractionDecisionSchema).min(1),
  })
  .strict();

const questionRequestSchema = baseRequestSchema
  .extend({
    kind: z.literal('question'),
    questions: z.array(runtimeQuestionSchema).min(1),
  })
  .strict();

const formElicitationRequestSchema = baseRequestSchema
  .extend({
    kind: z.literal('elicitation'),
    mode: z.literal('form'),
    message: nonBlank,
    requestedSchema: runtimeInteractionObjectSchema,
    decisions: z.array(runtimeInteractionDecisionSchema).min(1),
  })
  .strict();

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL must use http or https');

const urlElicitationRequestSchema = baseRequestSchema
  .extend({
    kind: z.literal('elicitation'),
    mode: z.literal('url'),
    message: nonBlank,
    elicitationId: nonBlank,
    url: httpUrlSchema,
    decisions: z.array(runtimeInteractionDecisionSchema).min(1),
  })
  .strict();

export const runtimeInteractionRequestSchema = z
  .union([approvalRequestSchema, questionRequestSchema, formElicitationRequestSchema, urlElicitationRequestSchema])
  .superRefine((request, context) => {
    if (request.kind === 'question') {
      assertUniqueIds(
        request.questions.map((question) => question.id),
        'question',
        context,
      );
      return;
    }
    assertUniqueIds(
      request.decisions.map((decision) => decision.id),
      'decision',
      context,
    );
  });

const decisionResponseSchema = z
  .object({
    kind: z.literal('decision'),
    decisionId: nonBlank,
    content: z.record(nonBlank, primitiveValueSchema).optional(),
  })
  .strict();

const answersResponseSchema = z
  .object({
    kind: z.literal('answers'),
    answers: z.record(nonBlank, z.array(z.string()).min(1)),
  })
  .strict();

export const runtimeInteractionResponseSchema = z.discriminatedUnion('kind', [
  decisionResponseSchema,
  answersResponseSchema,
]);

export type RuntimeInteractionOwner = z.infer<typeof runtimeInteractionOwnerSchema>;
export type RuntimeInteractionProviderRef = z.infer<typeof runtimeInteractionProviderRefSchema>;
export type RuntimeInteractionDecision = z.infer<typeof runtimeInteractionDecisionSchema>;
export type RuntimeInteractionObjectSchema = z.infer<typeof runtimeInteractionObjectSchema>;
export type RuntimeInteractionRequest = z.infer<typeof runtimeInteractionRequestSchema>;
export type RuntimeInteractionResponse = z.infer<typeof runtimeInteractionResponseSchema>;

export type RuntimeInteractionStatus = 'staged' | 'pending' | 'answered' | 'declined' | 'cancelled' | 'invalidated';

export type RuntimeInteractionTerminalReasonCode =
  | 'answered'
  | 'user_rejected'
  | 'user_cancelled'
  | 'confirmation_unavailable'
  | 'host_restarted'
  | 'transport_lost'
  | 'provider_cancelled'
  | 'surface_publication_failed';

export type RuntimeInteractionRedactedResponse =
  | { kind: 'decision'; decisionId: string; submittedFieldIds?: string[] }
  | { kind: 'answers'; answeredQuestionIds: string[]; secretQuestionIds: string[] };

export interface RuntimeInteractionCardRef {
  readonly threadId: string;
  readonly messageId: string;
  readonly blockId: string;
}

export interface RuntimeInteractionTerminal {
  readonly status: Exclude<RuntimeInteractionStatus, 'staged' | 'pending'>;
  readonly reasonCode: RuntimeInteractionTerminalReasonCode;
  readonly settledAt: number;
  readonly response?: RuntimeInteractionRedactedResponse;
}

export interface RuntimeInteractionRecord {
  readonly request: RuntimeInteractionRequest;
  readonly status: RuntimeInteractionStatus;
  readonly hostEpoch: string;
  readonly cardRef?: RuntimeInteractionCardRef;
  readonly terminal?: RuntimeInteractionTerminal;
  readonly updatedAt: number;
}

export function parseRuntimeInteractionRequest(input: unknown): RuntimeInteractionRequest {
  return runtimeInteractionRequestSchema.parse(input);
}

export function parseRuntimeInteractionResponse(
  request: RuntimeInteractionRequest,
  input: unknown,
): RuntimeInteractionResponse {
  const response = runtimeInteractionResponseSchema.parse(input);
  if (request.kind === 'question') return parseQuestionResponse(request, response);
  return parseDecisionResponse(request, response);
}

function parseQuestionResponse(
  request: Extract<RuntimeInteractionRequest, { kind: 'question' }>,
  response: RuntimeInteractionResponse,
): RuntimeInteractionResponse {
  if (response.kind !== 'answers') throw new Error('question interaction requires answers response');
  const expected = request.questions.map((question) => question.id).sort();
  const actual = Object.keys(response.answers).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`question response ids must exactly match: ${expected.join(', ')}`);
  }
  return response;
}

function parseDecisionResponse(
  request: Exclude<RuntimeInteractionRequest, { kind: 'question' }>,
  response: RuntimeInteractionResponse,
): RuntimeInteractionResponse {
  if (response.kind !== 'decision') throw new Error('decision interaction requires a decision response');
  const decision = request.decisions.find((candidate) => candidate.id === response.decisionId);
  if (!decision) throw new Error(`decision ${response.decisionId} is not allowed`);
  if (request.kind === 'approval') {
    if (response.content !== undefined) throw new Error('approval decision cannot contain form content');
    return response;
  }
  validateElicitationResponse(request, response, decision);
  return response;
}

function validateElicitationResponse(
  request: Extract<RuntimeInteractionRequest, { kind: 'elicitation' }>,
  response: Extract<RuntimeInteractionResponse, { kind: 'decision' }>,
  decision: RuntimeInteractionDecision,
): void {
  if (request.mode === 'url') {
    if (response.content !== undefined) throw new Error('URL elicitation decision cannot contain form content');
    return;
  }
  const needsContent = decision.outcome === 'accept';
  if (needsContent && response.content === undefined) throw new Error('accepted form elicitation requires content');
  if (!needsContent && response.content !== undefined)
    throw new Error('declined form elicitation cannot contain content');
  if (response.content) validateFormContent(request.requestedSchema, response.content);
}

export function redactRuntimeInteractionResponse(
  request: RuntimeInteractionRequest,
  response: RuntimeInteractionResponse,
): RuntimeInteractionRedactedResponse {
  if (response.kind === 'decision') {
    const submittedFieldIds = response.content ? Object.keys(response.content) : undefined;
    return { kind: 'decision', decisionId: response.decisionId, ...(submittedFieldIds ? { submittedFieldIds } : {}) };
  }
  const secretQuestionIds =
    request.kind === 'question'
      ? request.questions.filter((question) => question.isSecret).map((question) => question.id)
      : [];
  return { kind: 'answers', answeredQuestionIds: Object.keys(response.answers), secretQuestionIds };
}

function assertUniqueIds(ids: string[], label: string, context: z.RefinementCtx): void {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} ids must be unique` });
  }
}

function validateFormContent(
  schema: RuntimeInteractionObjectSchema,
  content: Record<string, string | number | boolean>,
): void {
  const allowed = new Set(Object.keys(schema.properties));
  for (const id of Object.keys(content)) {
    if (!allowed.has(id)) throw new Error(`form content property ${id} is not allowed`);
  }
  for (const id of schema.required ?? []) {
    if (!(id in content)) throw new Error(`form content property ${id} is required`);
  }
  for (const [id, value] of Object.entries(content)) {
    const property = schema.properties[id];
    if (property) validatePropertyValue(id, property, value);
  }
}

function validatePropertyValue(
  id: string,
  property: RuntimeInteractionObjectSchema['properties'][string],
  value: string | number | boolean,
): void {
  if (!matchesPropertyType(property.type, value)) throw new Error(`form content property ${id} has invalid type`);
  if (property.enum && !property.enum.includes(value)) throw new Error(`form content property ${id} is outside enum`);
  validateNumberBounds(id, property, value);
  validateStringBounds(id, property, value);
}

function matchesPropertyType(type: string, value: string | number | boolean): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && (type !== 'integer' || Number.isInteger(value));
}

function validateNumberBounds(
  id: string,
  property: RuntimeInteractionObjectSchema['properties'][string],
  value: string | number | boolean,
): void {
  if (typeof value !== 'number') return;
  if (property.minimum !== undefined && value < property.minimum) {
    throw new Error(`form content property ${id} is below minimum`);
  }
  if (property.maximum !== undefined && value > property.maximum) {
    throw new Error(`form content property ${id} is above maximum`);
  }
}

function validateStringBounds(
  id: string,
  property: RuntimeInteractionObjectSchema['properties'][string],
  value: string | number | boolean,
): void {
  if (typeof value !== 'string') return;
  if (property.minLength !== undefined && value.length < property.minLength) {
    throw new Error(`form content property ${id} is shorter than minLength`);
  }
  if (property.maxLength !== undefined && value.length > property.maxLength) {
    throw new Error(`form content property ${id} is longer than maxLength`);
  }
}
