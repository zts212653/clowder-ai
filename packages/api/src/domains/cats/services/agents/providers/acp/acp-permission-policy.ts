import { z } from 'zod';

const permissionOptions = z.array(
  z.object({
    optionId: z.string().min(1),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  }),
);

/** Both transports deny by default; an explicit policy can only select an offered option. */
export function resolveAcpPermissionDecision(params: Record<string, unknown>, policy: 'allow' | 'reject' = 'reject') {
  const parsed = permissionOptions.safeParse(params.options);
  if (!parsed.success) return { cancelled: true as const };
  const kinds = policy === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const selected = kinds.map((kind) => parsed.data.find((option) => option.kind === kind)).find((option) => option);
  return selected ? { optionId: selected.optionId } : { cancelled: true as const };
}
