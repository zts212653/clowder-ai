import { z } from 'zod';

export const CAPABILITY_TIP_KINDS = ['capability', 'magic_word', 'workflow', 'feature', 'status_help'] as const;
export const CAPABILITY_TIP_CONTEXTS = [
  'thinking',
  'waiting_external',
  'review',
  'feature_dev',
  'merge_gate',
  'eval',
  'long_running',
  'concierge_idle',
  'concierge_open',
  'pet_waiting_for_user',
] as const;
export const CAPABILITY_TIP_AUDIENCES = ['cvo', 'developer', 'maintainer', 'all'] as const;
export const CAPABILITY_TIP_SURFACES = ['assistant_stream_bubble', 'pending_bubble', 'concierge'] as const;

const ACTION_REQUIRED_KINDS = new Set(['capability', 'workflow', 'feature']);
const FAKE_PROGRESS_RE = /就快好了|快好了|马上完成|马上好|马上就好|即将完成/u;

/** 7 days — new tips within this window get display priority. */
const NEW_TIP_BOOST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── Exposure State (Phase D #997) ────────────────────────────────────────────

export interface TipExposureState {
  /** Tip IDs that have been shown in this scope. */
  exposed: ReadonlySet<string>;
  /** tipId → firstSeenAt timestamp for inventory-diff new tips. */
  firstSeen: ReadonlyMap<string, number>;
  /** Hash of the tip ID list when this state was last saved. */
  fingerprint: string;
}

/** Deterministic hash of a string → non-negative int32. */
function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h < 0 ? -h : h;
}

/** Fisher-Yates shuffle driven by a 32-bit LCG seeded with `seed`. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let s = seed & 0x7fffffff;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

/**
 * Canonical scope key for exposure tracking.
 * Contexts are sorted so order in the caller's array doesn't matter.
 */
export function computeExposureScope(
  surface: string,
  audience: string | undefined,
  contexts: readonly string[],
): string {
  const sorted = [...contexts].sort().join(',');
  return `${surface}:${audience ?? 'all'}:${sorted}`;
}

/**
 * Order-independent fingerprint of tip IDs.
 * Changes when tips are added or removed, stable when content changes.
 */
export function computeInventoryFingerprint(tipIds: readonly string[]): string {
  const sorted = [...tipIds].sort();
  return String(simpleHash(sorted.join('\0')));
}

/**
 * Migrate an existing exposure state to match the current inventory.
 * - Deleted tips are pruned from `exposed` and `firstSeen`.
 * - Genuinely new tips (not in old exposed or firstSeen) get `firstSeen = now`.
 * - Fingerprint is recomputed.
 */
export function migrateExposureState(
  existing: TipExposureState,
  currentTipIds: readonly string[],
  now: number,
): TipExposureState {
  const currentSet = new Set(currentTipIds);
  const knownBefore = new Set([...existing.exposed, ...existing.firstSeen.keys()]);

  // Prune deleted from exposed
  const exposed = new Set<string>();
  for (const id of existing.exposed) {
    if (currentSet.has(id)) exposed.add(id);
  }

  // Prune deleted + add new to firstSeen
  const firstSeen = new Map<string, number>();
  for (const [id, ts] of existing.firstSeen) {
    if (currentSet.has(id)) firstSeen.set(id, ts);
  }
  for (const id of currentTipIds) {
    if (!knownBefore.has(id) && !firstSeen.has(id)) {
      firstSeen.set(id, now);
    }
  }

  return { exposed, firstSeen, fingerprint: computeInventoryFingerprint(currentTipIds) };
}

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
    /** When provided, enables #997 exposure-uniform selection. */
    exposure?: TipExposureState;
    /** YYYY-MM-DD date bucket for deterministic daily shuffle. */
    dateSeed?: string;
    /** Opaque scope key for seed diversification (spec: seed = date + scope + fingerprint). */
    scopeKey?: string;
    /** Current timestamp (ms) for new-tip boost window. Defaults to Date.now(). */
    now?: number;
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
    .filter((entry): entry is { tip: CapabilityTip; contextScore: number } => entry !== null);

  if (eligible.length === 0) return null;
  const rotationKey = Math.max(0, Math.floor(options.rotationKey ?? 0));

  // ── Legacy path: no exposure state → deterministic sort + modulo ──────────
  if (!options.exposure) {
    const sorted = [...eligible].sort(
      (a, b) =>
        a.contextScore - b.contextScore ||
        a.tip.contexts.length - b.tip.contexts.length ||
        a.tip.id.localeCompare(b.tip.id),
    );
    return sorted[rotationKey % sorted.length]?.tip ?? null;
  }

  // ── Phase D path: exposure-aware selection with seeded shuffle ─────────────
  const { exposure, dateSeed = '', scopeKey = '', now } = options;
  const currentNow = now ?? Date.now();
  // Spec: seed = date-bucket + scope + inventory-fingerprint (7e4a8855f)
  const seed = simpleHash(dateSeed + scopeKey + exposure.fingerprint);

  // Spec: "同优先級內用 deterministic seeded shuffle 打散排序" — preserve
  // contextScore tiers, shuffle only within each tier.
  const scoreGroups = new Map<number, typeof eligible>();
  for (const entry of eligible) {
    let group = scoreGroups.get(entry.contextScore);
    if (!group) {
      group = [];
      scoreGroups.set(entry.contextScore, group);
    }
    group.push(entry);
  }
  const shuffled = [...scoreGroups.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, group]) => seededShuffle(group, seed));

  // Determine if this looks like a first-install state (all tips are new).
  // If so, suppress boost to avoid "首次安装全量抢占" per spec.
  const allNewFirstSeen =
    eligible.length > 0 && eligible.every((e) => exposure.firstSeen.has(e.tip.id)) && exposure.exposed.size === 0;

  // Partition into exposure tiers (maintaining context-tiered shuffle order)
  const newBoosted: typeof eligible = [];
  const unexposed: typeof eligible = [];
  const exposed: typeof eligible = [];

  for (const entry of shuffled) {
    const isExposed = exposure.exposed.has(entry.tip.id);
    if (isExposed) {
      exposed.push(entry);
      continue;
    }
    const firstSeenAt = exposure.firstSeen.get(entry.tip.id);
    const isNew = !allNewFirstSeen && firstSeenAt !== undefined && currentNow - firstSeenAt < NEW_TIP_BOOST_WINDOW_MS;
    if (isNew) {
      newBoosted.push(entry);
    } else {
      unexposed.push(entry);
    }
  }

  // Tier-based selection: exhaust higher-priority exposure tier before falling
  // through. Flat concat + global modulo allowed rotationKey to index into
  // exposed tips while unexposed remained (cloud P1 on 9bcb6728).
  const tier = newBoosted.length > 0 ? newBoosted : unexposed.length > 0 ? unexposed : exposed;
  return tier[rotationKey % tier.length]?.tip ?? null;
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
