import type { RuntimeInteractionObjectSchema } from '@cat-cafe/shared';
import { runtimeInteractionObjectSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const nonBlank = z.string().trim().min(1);
const exactCoordinate = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());
const providerCoordinates = { threadId: nonBlank, turnId: nonBlank };

export const commandParamsSchema = z
  .object({
    ...providerCoordinates,
    itemId: nonBlank,
    startedAtMs: z.number().int().nonnegative(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
    proposedNetworkPolicyAmendments: z
      .array(z.object({ host: nonBlank, action: z.enum(['allow', 'deny']) }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough();

export const fileParamsSchema = z
  .object({
    ...providerCoordinates,
    itemId: nonBlank,
    startedAtMs: z.number().int().nonnegative(),
    reason: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
  })
  .passthrough();

export const questionParamsSchema = z
  .object({
    ...providerCoordinates,
    itemId: nonBlank,
    isBlocking: z.literal(true),
    questions: z.array(
      z
        .object({
          id: nonBlank,
          header: nonBlank,
          question: nonBlank,
          isOther: z.boolean().optional(),
          isSecret: z.boolean().optional(),
          options: z
            .array(z.object({ label: nonBlank, description: z.string().optional() }).passthrough())
            .nullable()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const mcpBase = { serverName: nonBlank, threadId: nonBlank, turnId: nonBlank.nullable().optional(), message: nonBlank };

export const mcpFormParamsSchema = z
  .object({ ...mcpBase, mode: z.literal('form'), requestedSchema: z.unknown() })
  .passthrough();
export type CodexMcpFormParams = z.infer<typeof mcpFormParamsSchema>;

/**
 * Provider-authored capability consent provenance. The human-facing message is
 * deliberately excluded: presentation text must never grant authority or
 * decide whether an elicitation bypasses the human interaction surface.
 */
export const mcpCapabilityApprovalMetaSchema = z
  .object({
    callId: exactCoordinate.optional(),
    codex_approval_kind: z.literal('mcp_tool_call'),
    connector_id: exactCoordinate,
    tool_name: exactCoordinate,
    tool_params: z.object({ app: exactCoordinate }).passthrough(),
  })
  .passthrough();

export function isMcpCapabilityApprovalMarker(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>).codex_approval_kind === 'mcp_tool_call'
  );
}

export const mcpUrlParamsSchema = z
  .object({ ...mcpBase, mode: z.literal('url'), elicitationId: nonBlank, url: z.string().url() })
  .passthrough();

export function normalizeCodexMcpFormSchema(input: unknown): RuntimeInteractionObjectSchema {
  const schema = z
    .object({
      type: z.literal('object'),
      properties: z.record(nonBlank, z.record(z.string(), z.unknown())),
      required: z.array(nonBlank).nullable().optional(),
      additionalProperties: z.literal(false).optional(),
      $schema: z.string().nullable().optional(),
    })
    .strict()
    .parse(input);
  return runtimeInteractionObjectSchema.parse({
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([id, property]) => [id, normalizePrimitiveProperty(property)]),
    ),
    ...(schema.required ? { required: schema.required } : {}),
    additionalProperties: false,
  });
}

function normalizePrimitiveProperty(property: Record<string, unknown>): Record<string, unknown> {
  const advisory = new Set(['format', 'enumNames']);
  const allowed = new Set([
    'type',
    'title',
    'description',
    'default',
    'enum',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
  ]);
  for (const [key, value] of Object.entries(property)) {
    if (!allowed.has(key) && !advisory.has(key) && value != null) {
      throw new Error(`unsupported form property keyword ${key}`);
    }
  }
  return Object.fromEntries(Object.entries(property).filter(([key, value]) => value !== null && !advisory.has(key)));
}
