import { z } from 'zod';

export const claudeQuotaWindowSchema = z.object({
  utilization: z.number().finite().min(0).max(1).optional(),
  /** Official CLI Unix seconds, not milliseconds. */
  resetsAt: z.number().finite().nonnegative().optional(),
  status: z.string().max(80).optional(),
});
export const claudeQuotaSampleSchema = z.object({
  observedAt: z.number().finite().nonnegative(),
  windows: z.record(z.string(), claudeQuotaWindowSchema),
});
export const claudeQuotaObservationSchema = z.object({
  v: z.literal(1),
  accountRef: z.string().min(1),
  credentialVersion: z.string().regex(/^[a-f0-9]{64}$/),
  samples: z.record(z.string().min(1).max(200), claudeQuotaSampleSchema),
});
export type ClaudeQuotaWindow = z.infer<typeof claudeQuotaWindowSchema>;
export type ClaudeQuotaSample = z.infer<typeof claudeQuotaSampleSchema>;
export type ClaudeQuotaObservation = z.infer<typeof claudeQuotaObservationSchema>;
export type ClaudeQuotaView = Pick<ClaudeQuotaObservation, 'samples'>;

/** Shared windows are account-wide; every other key remains model-scoped and named. */
export const isClaudeSharedWindow = (key: string) => key === 'five_hour' || key === 'seven_day';

export function claudeQuotaWindows(samples: ClaudeQuotaView['samples']) {
  const result = new Map<string, ClaudeQuotaWindow & { key: string; model: string; observedAt: number }>();
  for (const [model, sample] of Object.entries(samples)) {
    for (const [key, window] of Object.entries(sample.windows)) {
      const identity = isClaudeSharedWindow(key) ? key : `${model}:${key}`;
      if ((result.get(identity)?.observedAt ?? -1) > sample.observedAt) continue;
      result.set(identity, { ...window, key, model, observedAt: sample.observedAt });
    }
  }
  return [...result.values()];
}
