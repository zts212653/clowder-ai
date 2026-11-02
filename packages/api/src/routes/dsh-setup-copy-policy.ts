import { z } from 'zod';

// A bounded copy contract, not a replacement for DSH's own configuration schema.
// Validate without parsing/stripping: unsupported fields require manual setup.
const number = z.number().finite();
const level = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const budgets = z
  .object({ minimal: number.optional(), low: number.optional(), medium: number.optional(), high: number.optional() })
  .strict();
const compat = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    supportsFinishReason: z.boolean().optional(),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    requiresToolResultName: z.boolean().optional(),
    requiresAssistantAfterToolResult: z.boolean().optional(),
    requiresThinkingAsText: z.boolean().optional(),
    requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    thinkingFormat: z
      .enum([
        'openai',
        'deepseek',
        'openrouter',
        'together',
        'baseten',
        'zai',
        'qwen',
        'chat-template',
        'qwen-chat-template',
        'string-thinking',
        'ant-ling',
      ])
      .optional(),
    supportsThinkingTokenBudget: z.boolean().optional(),
    thinkingTokenBudgetField: z.enum(['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens']).optional(),
    vllmPriority: number.optional(),
    supportsMaxOutputTokens: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
    cacheControlFormat: z.literal('anthropic').optional(),
    supportsLongCacheRetention: z.boolean().optional(),
    supportsEagerToolInputStreaming: z.boolean().optional(),
    supportsCacheControlOnTools: z.boolean().optional(),
    supportsTemperature: z.boolean().optional(),
    forceAdaptiveThinking: z.boolean().optional(),
    allowEmptySignature: z.boolean().optional(),
    supportsStrictTools: z.boolean().optional(),
  })
  .strict();
const modelFields = {
  name: z.string().optional(),
  contextWindow: number.optional(),
  maxTokens: number.optional(),
  input: z.array(z.enum(['text', 'image'])).optional(),
  reasoningEfforts: z.union([z.literal(false), z.record(level, z.string().nullable())]).optional(),
  compat: compat.optional(),
};
const model = z.object({ id: z.string(), ...modelFields }).strict();
const backoff = z
  .object({ initialDelayMs: number.optional(), maxDelayMs: number.optional(), jitterRatio: number.optional() })
  .strict();
const retry = z
  .object({
    mode: z.enum(['normal', 'always']),
    maxRetries: number.optional(),
    retryableCodes: z.array(z.string()).optional(),
    backoff: backoff.optional(),
  })
  .strict();
const endpoint = z.string().refine((value) => {
  try {
    const url = new URL(value);
    // Query/fragment names are arbitrary: a credential denylist cannot prove safety.
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
});
const provider = z
  .object({
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    displayName: z.string().optional(),
    api: z.string().optional(),
    baseURL: endpoint.optional(),
    models: z.array(model).optional(),
    modelOverrides: z.record(z.object(modelFields).strict()).optional(),
    compat: compat.optional(),
    defaultContextWindow: number.optional(),
    defaultMaxTokens: number.optional(),
    defaultInput: z.array(z.enum(['text', 'image'])).optional(),
    // Empty maps are harmless defaults. No custom header name/value is copied.
    headers: z.object({}).strict().optional(),
    reasoning: level.optional(),
    thinkingBudgets: budgets.optional(),
    cacheRetention: z.enum(['none', 'short', 'long']).optional(),
    transport: z.enum(['sse', 'websocket', 'websocket-cached', 'auto']).optional(),
    timeoutMs: number.optional(),
    websocketConnectTimeoutMs: number.optional(),
    streamIdleTimeoutMs: number.optional(),
    maxRequestImageBytes: number.optional(),
    requestImagePixelBudget: number.optional(),
    requestImageMaxBytes: number.optional(),
    retryPolicy: retry.optional(),
  })
  .strict();
const llm = z.object({ providers: z.record(provider) }).strict();
const acp = z
  .object({ provider: z.string().optional(), model: z.string().optional(), sessionListPageSize: number.optional() })
  .strict();

/** Check the entire emitted config, including every retained active provider. */
export function assertDshCopyPolicy(llmConfig: unknown, acpConfig: unknown): void {
  if (!llm.safeParse(llmConfig).success || !acp.safeParse(acpConfig).success) {
    // Do not return Zod issues: they can include private field names or values.
    throw Error('dsh_config_manual');
  }
}
