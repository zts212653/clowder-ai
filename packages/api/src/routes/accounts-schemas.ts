import { z } from 'zod';
import { CLAUDE_TOKEN_PATTERN } from '../config/claude-token-account.js';

const claudeTokenSchema = z.string().trim().regex(CLAUDE_TOKEN_PATTERN, 'claude_token_invalid').optional();

/** F171: POSIX env key — must start with uppercase or _, rest alphanumeric + _. CAT_CAFE_ reserved. */
const envKeySchema = z.string().regex(/^[A-Z_][A-Za-z0-9_]*$/, 'env key must match [A-Z_][A-Za-z0-9_]*');
const envVarsSchema = z
  .record(envKeySchema, z.string())
  .optional()
  .transform((vars) => {
    if (!vars) return vars;
    // Strip CAT_CAFE_ reserved keys server-side
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (!k.startsWith('CAT_CAFE_')) filtered[k] = v;
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  });
const modelAliasKeySchema = z.string().refine((key) => key.trim().length > 0, 'model alias key cannot be blank');
const modelAliasesSchema = z
  .record(modelAliasKeySchema, z.string().trim().min(1))
  .superRefine((aliases, ctx) => {
    const normalizedKeys = new Set<string>();
    for (const key of Object.keys(aliases)) {
      const normalizedKey = key.trim();
      if (normalizedKeys.has(normalizedKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'model alias keys must be unique after trimming',
        });
      }
      normalizedKeys.add(normalizedKey);
    }
  })
  .transform((aliases) =>
    Object.fromEntries(Object.entries(aliases).map(([key, upstreamId]) => [key.trim(), upstreamId])),
  )
  .optional();

const authTypeEnum = z.enum(['oauth', 'api_key']);
const modeEnum = z.enum(['subscription', 'api_key']);
/** F171: restrict clientId to known clients — prevents silent data rot when frontend truststhis as enum. */
const accountClientEnum = z.enum(['anthropic', 'openai', 'google', 'kimi', 'pi', 'opencode', 'acp']);

export const projectQuerySchema = z.object({
  projectPath: z.string().optional(),
});

export const createBodySchema = z
  .object({
    projectPath: z.string().optional(),
    provider: z.string().trim().min(1).optional(),
    /** F171: Explicit client identity for API key accounts. */
    clientId: accountClientEnum.optional(),
    name: z.string().trim().max(200).optional(),
    displayName: z.string().trim().max(200).optional(),
    mode: modeEnum.optional(),
    authType: authTypeEnum.optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    claudeToken: claudeTokenSchema,
    modelOverride: z.string().optional(),
    models: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .transform((v) => v.replace(/\/+$/, ''))
          .pipe(z.string().min(1)),
      )
      .optional(),
    modelAliases: modelAliasesSchema,
    /** F171: User-defined env vars injected into agent subprocess. */
    envVars: z.record(envKeySchema, z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.authType === 'oauth' && value.clientId === 'openai') {
      for (const field of ['apiKey', 'baseUrl', 'envVars'] as const) {
        if (value[field] !== undefined)
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'codex_managed_account_fields_owned' });
      }
    }
    if (
      value.claudeToken !== undefined &&
      (value.authType !== 'oauth' ||
        value.clientId !== 'anthropic' ||
        value.apiKey !== undefined ||
        value.baseUrl !== undefined ||
        value.envVars !== undefined)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'claude_token_account_fields_owned' });
    if ((value.authType ?? 'api_key') === 'api_key' && !value.clientId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clientId'], message: 'API key accounts require clientId' });
    }
    if (!value.name && !value.displayName && !(value.authType === 'oauth' && value.clientId === 'openai')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displayName'],
        message: 'displayName or name is required',
      });
    }
  })
  .transform((value) => ({ ...value, envVars: envVarsSchema.parse(value.envVars) }));

export const updateBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
  clientId: accountClientEnum.optional(),
  name: z.string().trim().max(200).optional(),
  displayName: z.string().trim().max(200).optional(),
  mode: modeEnum.optional(),
  authType: authTypeEnum.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  claudeToken: claudeTokenSchema,
  modelOverride: z.string().nullable().optional(),
  models: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .transform((v) => v.replace(/\/+$/, ''))
        .pipe(z.string().min(1)),
    )
    .optional(),
  modelAliases: modelAliasesSchema,
  /** F171: User-defined env vars injected into agent subprocess. */
  envVars: envVarsSchema,
});

export const deleteBodySchema = z.object({
  projectPath: z.string().optional(),
  force: z.boolean().optional(),
});
