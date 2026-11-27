import { z } from 'zod';

export const AGENT_ADAPTER_DECLARATION_FILE = 'agent-adapter.json';

const requiredOperations = ['describe', 'detect', 'openSession', 'startTurn', 'cancel', 'release'] as const;
export const AGENT_ADAPTER_OPTIONAL_OPERATIONS = [
  'login',
  'modelCatalog',
  'quota',
  'input',
  'inspectInput',
  'compact',
] as const;
const operationSchema = z.enum([...requiredOperations, ...AGENT_ADAPTER_OPTIONAL_OPERATIONS]);

const declarationSchema = z.strictObject({
  protocolVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  operations: z
    .array(operationSchema)
    .readonly()
    .refine((operations) => {
      const unique = new Set(operations);
      return unique.size === operations.length && requiredOperations.every((required) => unique.has(required));
    }, 'Required operations must be present and unique'),
});

export type AgentAdapterDeclaration = z.infer<typeof declarationSchema>;

export function parseAgentAdapterDeclaration(input: unknown) {
  return declarationSchema.safeParse(input);
}

function capability<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('supported'), data }),
    z.strictObject({ status: z.literal('unsupported') }),
    z.strictObject({ status: z.literal('unknown'), reason: z.string().trim().min(1).max(256) }),
  ]);
}

const notReported = { status: 'unknown', reason: 'not_reported' } as const;

const descriptionSchema = z.strictObject({
  protocolVersion: z.literal(1),
  label: z.string().trim().min(1).max(120),
  capabilities: z.strictObject({
    resume: capability(z.strictObject({ mode: z.literal('native') })),
    tools: capability(z.strictObject({ approval: z.enum(['host', 'client', 'none']) })),
    login: capability(z.strictObject({ mode: z.enum(['native', 'browser', 'device-code']) })).default(notReported),
    input: capability(z.strictObject({ duringTurn: z.literal(true) })).default(notReported),
    inspectInput: capability(z.strictObject({ deliveryReceipt: z.literal(true) })).default(notReported),
    compact: capability(z.strictObject({ mode: z.literal('native'), observesResult: z.boolean() })).default(
      notReported,
    ),
    modelCatalog: capability(z.strictObject({ source: z.literal('client') })),
    quota: capability(
      z.strictObject({
        source: z.enum(['native-command', 'provider-response', 'account-api']),
        units: z
          .array(z.enum(['ratio', 'tokens', 'requests']))
          .min(1)
          .max(3)
          .refine((units) => new Set(units).size === units.length),
      }),
    ),
  }),
});

export type AgentAdapterDescription = z.infer<typeof descriptionSchema>;

export function parseAgentAdapterDescription(input: unknown) {
  return descriptionSchema.safeParse(input);
}

const detectionSchema = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(128),
        label: z.string().trim().min(1).max(120),
        state: z.discriminatedUnion('status', [
          z.strictObject({ status: z.literal('ready'), version: z.string().min(1).max(120).optional() }),
          z.strictObject({ status: z.literal('not-installed') }),
          z.strictObject({ status: z.literal('login-required') }),
          z.strictObject({ status: z.literal('unavailable'), reason: z.string().trim().min(1).max(256) }),
        ]),
      }),
    )
    .max(100)
    .refine((candidates) => new Set(candidates.map((candidate) => candidate.id)).size === candidates.length),
});

export type AgentAdapterDetection = z.infer<typeof detectionSchema>;

export function parseAgentAdapterDetection(input: unknown) {
  return detectionSchema.safeParse(input);
}
