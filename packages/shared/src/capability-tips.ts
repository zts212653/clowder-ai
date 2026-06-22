import { z } from 'zod';

export const CAPABILITY_TIP_KINDS = ['capability', 'magic_word', 'workflow', 'feature', 'status_help'] as const;
export const CAPABILITY_TIP_CONTEXTS = [
  'thinking',
  'waiting_external',
  'review',
  'feature_dev',
  'merge_gate',
  'long_running',
  'concierge_idle',
  'concierge_open',
  'pet_waiting_for_user',
] as const;
export const CAPABILITY_TIP_AUDIENCES = ['cvo', 'developer', 'maintainer', 'all'] as const;
export const CAPABILITY_TIP_SURFACES = ['assistant_stream_bubble', 'pending_bubble', 'concierge'] as const;

const ACTION_REQUIRED_KINDS = new Set(['capability', 'workflow', 'feature']);
const FAKE_PROGRESS_RE = /就快好了|快好了|马上完成|马上好|马上就好|即将完成/u;

export const CapabilityTipSourceRefSchema = z
  .object({
    path: z.string().min(1),
    anchor: z.string().min(1),
  })
  .strict();

export const CapabilityTipActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('open_concierge_draft'),
      label: z.string().min(1),
      draftPrompt: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('open_source'),
      label: z.string().min(1),
      sourceRef: CapabilityTipSourceRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('open_guide'),
      label: z.string().min(1),
      guideId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('open_capability_surface'),
      label: z.string().min(1),
      surfaceId: z.string().min(1),
    })
    .strict(),
]);

export const CapabilityTipSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.enum(CAPABILITY_TIP_KINDS),
    sourceRef: CapabilityTipSourceRefSchema,
    structureSource: CapabilityTipSourceRefSchema,
    bodySource: CapabilityTipSourceRefSchema,
    contexts: z.array(z.enum(CAPABILITY_TIP_CONTEXTS)).min(1),
    audience: z.array(z.enum(CAPABILITY_TIP_AUDIENCES)).min(1),
    body: z.string().min(12).max(140),
    action: CapabilityTipActionSchema.optional(),
    owner: z.string().min(1),
  })
  .strict();

export const CapabilityTipUsageEventSchema = z
  .object({
    event: z.enum(['capability_tip_exposed', 'capability_tip_action', 'capability_tip_dismissed']),
    tipId: z.string().min(1),
    context: z.enum(CAPABILITY_TIP_CONTEXTS),
    surface: z.enum(CAPABILITY_TIP_SURFACES),
    actionType: z.enum(['open_concierge_draft', 'open_source', 'open_guide', 'open_capability_surface']).optional(),
    outcome: z.enum(['shown', 'opened', 'dismissed', 'failed']).optional(),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();

export type CapabilityTipKind = (typeof CAPABILITY_TIP_KINDS)[number];
export type CapabilityTipContext = (typeof CAPABILITY_TIP_CONTEXTS)[number];
export type CapabilityTipAudience = (typeof CAPABILITY_TIP_AUDIENCES)[number];
export type CapabilityTipSurface = (typeof CAPABILITY_TIP_SURFACES)[number];
export type CapabilityTipSourceRef = z.infer<typeof CapabilityTipSourceRefSchema>;
export type CapabilityTipAction = z.infer<typeof CapabilityTipActionSchema>;
export type CapabilityTip = z.infer<typeof CapabilityTipSchema>;
export type CapabilityTipUsageEvent = z.infer<typeof CapabilityTipUsageEventSchema>;

export type CapabilityTipValidationResult =
  | { success: true; tips?: CapabilityTip[]; tip?: CapabilityTip }
  | { success: false; errors: string[] };

export function isActionRequiredTipKind(kind: CapabilityTipKind): boolean {
  return ACTION_REQUIRED_KINDS.has(kind);
}

export function containsFakeProgressPromise(body: string): boolean {
  return FAKE_PROGRESS_RE.test(body);
}

export function validateCapabilityTip(input: unknown): CapabilityTipValidationResult {
  const parsed = CapabilityTipSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }

  const errors: string[] = [];
  if (isActionRequiredTipKind(parsed.data.kind) && !parsed.data.action) {
    errors.push(`${parsed.data.id}: ${parsed.data.kind} requires an action`);
  }
  if (containsFakeProgressPromise(parsed.data.body)) {
    errors.push(`${parsed.data.id}: fake progress wording is not allowed`);
  }

  if (errors.length > 0) return { success: false, errors };
  return { success: true, tip: parsed.data };
}

export function validateCapabilityTipInventory(input: unknown): CapabilityTipValidationResult {
  if (!Array.isArray(input)) return { success: false, errors: ['inventory must be an array'] };

  const errors: string[] = [];
  const tips: CapabilityTip[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const result = validateCapabilityTip(item);
    if (!result.success) {
      errors.push(...result.errors);
      continue;
    }
    const tip = result.tip;
    if (!tip) continue;
    if (seen.has(tip.id)) {
      errors.push(`duplicate tip id: ${tip.id}`);
    }
    seen.add(tip.id);
    tips.push(tip);
  }

  if (errors.length > 0) return { success: false, errors };
  return { success: true, tips };
}

export function selectCapabilityTip(
  tips: readonly CapabilityTip[],
  options: {
    contexts: readonly CapabilityTipContext[];
    audience?: CapabilityTipAudience;
    rotationKey?: number;
  },
): CapabilityTip | null {
  const requestedAudience = options.audience;
  const contextOrder = new Map(options.contexts.map((context, index) => [context, index]));
  const eligible = tips
    .map((tip) => {
      const matchesAudience =
        requestedAudience === undefined || tip.audience.includes('all') || tip.audience.includes(requestedAudience);
      if (!matchesAudience) return null;
      const contextScore = Math.min(
        ...tip.contexts.map((context) => contextOrder.get(context) ?? Number.POSITIVE_INFINITY),
      );
      if (!Number.isFinite(contextScore)) return null;
      return { tip, contextScore };
    })
    .filter((entry): entry is { tip: CapabilityTip; contextScore: number } => entry !== null)
    .sort(
      (a, b) =>
        a.contextScore - b.contextScore ||
        a.tip.contexts.length - b.tip.contexts.length ||
        a.tip.id.localeCompare(b.tip.id),
    );

  if (eligible.length === 0) return null;
  const rotationKey = Math.max(0, Math.floor(options.rotationKey ?? 0));
  return eligible[rotationKey % eligible.length]?.tip ?? null;
}

export function formatSourceRef(sourceRef: CapabilityTipSourceRef): string {
  return `${sourceRef.path}#${sourceRef.anchor}`;
}

export function buildConciergeDraftPrompt(tip: CapabilityTip): string {
  if (tip.action?.type === 'open_concierge_draft' && tip.action.draftPrompt) {
    return tip.action.draftPrompt;
  }

  return [
    '帮我解释这个 tip，并告诉我什么时候该用、下一步怎么做。',
    '',
    `tipId: ${tip.id}`,
    `来源: ${formatSourceRef(tip.sourceRef)}`,
    `内容: ${tip.body}`,
  ].join('\n');
}
