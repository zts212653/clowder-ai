import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';

const modelSchema = z.object({
  model: z.string().optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
  overrides: z.object({ default_effort: z.string().optional() }).optional(),
});
const metadataSchema = z.object({
  default_model: z.string().optional(),
  default_thinking: z.boolean().optional(),
  thinking: z.object({ enabled: z.boolean().optional(), effort: z.string().optional() }).optional(),
  models: z.record(modelSchema).default({}),
});

/** One read boundary for Kimi's declared tiers. Credentials and provider config are stripped. */
export function readKimiModelMetadata(configPath: string) {
  try {
    const result = metadataSchema.safeParse(parse(readFileSync(configPath, 'utf8')));
    if (!result.success) return undefined;
    const config = result.data;
    const thinkingEnabled = config.thinking?.enabled ?? config.default_thinking;
    return {
      defaultModel: config.default_model,
      thinkingEnabled,
      models: Object.entries(config.models).map(([alias, model]) => {
        const efforts = model.support_efforts;
        const nativeDefault = model.overrides?.default_effort ?? model.default_effort;
        const defaultEffort = [config.thinking?.effort, nativeDefault].find(
          (value) => value !== undefined && efforts?.includes(value),
        );
        return {
          alias,
          model: model.model ?? alias,
          efforts,
          defaultEffort: thinkingEnabled === false ? undefined : defaultEffort,
        };
      }),
    };
  } catch {
    return undefined;
  }
}
