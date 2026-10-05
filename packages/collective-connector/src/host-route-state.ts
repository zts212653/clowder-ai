import { type CollectiveStandingWork, collectiveStandingWorkSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const catIdSchema = z.string().trim().min(1).max(120);
const channelIdSchema = z.string().trim().min(1).max(160);
const displayNameSchema = z.string().trim().min(1).max(120);

const agentHostRouteSchema = z
  .object({
    catId: catIdSchema,
    threadId: z.string().trim().min(1).max(240),
    standingWork: collectiveStandingWorkSchema.optional(),
    standingWorkRevision: z.number().int().positive().optional(),
    participation: z
      .object({
        displayName: displayNameSchema,
        channelIds: z.array(channelIdSchema).min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

const channelParticipationOverrideSchema = z.object({ excludedCatIds: z.array(catIdSchema).max(100) }).strict();

export const desiredParticipationSchema = z
  .object({
    defaultMode: z.literal('include'),
    excludedCatIds: z.array(catIdSchema).max(100),
    channelOverrides: z.record(channelIdSchema, channelParticipationOverrideSchema),
  })
  .strict();

const observedEligibilitySchema = z
  .object({
    displayName: displayNameSchema,
    configured: z.boolean(),
    eligible: z.boolean(),
    profileFingerprint: z.string().length(64).optional(),
  })
  .strict();

const publicProfileSchema = z
  .object({
    description: z.string().trim().min(1).max(120).optional(),
    avatarDataUrl: z
      .string()
      .max(1_200)
      .regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
  })
  .strict();

const channelHostRouteSchema = z
  .object({
    channelId: channelIdSchema,
    threadId: z.string().trim().min(1).max(240),
    participants: z.record(catIdSchema, z.object({ displayName: displayNameSchema }).strict()),
  })
  .strict();

const standingInterestSchema = z
  .object({
    catId: catIdSchema,
    kind: z.literal('response_requests'),
    status: z.enum(['active', 'withdrawn']),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const channelListeningSchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('mentions'), revision: z.number().int().positive(), updatedAt: z.string().datetime() })
    .strict(),
  z
    .object({
      mode: z.literal('all'),
      dutyCatId: catIdSchema,
      revision: z.number().int().positive(),
      updatedAt: z.string().datetime(),
    })
    .strict(),
]);
export type ChannelListening = z.infer<typeof channelListeningSchema>;

export const defaultDesiredParticipation = () => ({
  defaultMode: 'include' as const,
  excludedCatIds: [],
  channelOverrides: {},
});

export const hostRouteConfigSchema = z
  .object({
    connectionId: z.string(),
    localOwnerUserId: z.string().trim().min(1).max(240),
    defaultIngressThreadId: z.string().trim().min(1).max(240),
    humanNotificationThreadId: z.string().trim().min(1).max(240),
    agentRoutes: z.record(z.string(), agentHostRouteSchema),
    desiredParticipation: desiredParticipationSchema.default(defaultDesiredParticipation),
    observedEligibility: z.record(catIdSchema, observedEligibilitySchema).default({}),
    publicProfiles: z.record(catIdSchema, publicProfileSchema).default({}),
    channelRoutes: z.record(channelIdSchema, channelHostRouteSchema).default({}),
    standingInterests: z.record(channelIdSchema, z.record(catIdSchema, standingInterestSchema)).default({}),
    channelListening: z.record(channelIdSchema, channelListeningSchema).default({}),
    attentionRevision: z.number().int().nonnegative().default(0),
    scopeStarts: z.record(z.string(), z.number().int().positive()).default({}),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const setHostRouteInputSchema = hostRouteConfigSchema
  .omit({ connectionId: true, revision: true, updatedAt: true })
  .extend({
    desiredParticipation: desiredParticipationSchema.optional(),
    observedEligibility: z.record(catIdSchema, observedEligibilitySchema).optional(),
    publicProfiles: z.record(catIdSchema, publicProfileSchema).optional(),
    channelRoutes: z.record(channelIdSchema, channelHostRouteSchema).optional(),
    standingInterests: z.record(channelIdSchema, z.record(catIdSchema, standingInterestSchema)).optional(),
    channelListening: z.record(channelIdSchema, channelListeningSchema).optional(),
    attentionRevision: z.number().int().nonnegative().optional(),
    scopeStarts: z.record(z.string(), z.number().int().positive()).optional(),
  });

export interface AgentHostRoute {
  readonly catId: string;
  readonly threadId: string;
  readonly standingWork?: CollectiveStandingWork;
  readonly standingWorkRevision?: number;
  readonly participation?: { readonly displayName: string; readonly channelIds: readonly string[] };
}

export interface DesiredParticipation {
  readonly defaultMode: 'include';
  readonly excludedCatIds: readonly string[];
  readonly channelOverrides: Readonly<Record<string, { readonly excludedCatIds: readonly string[] }>>;
}

export interface ObservedCatEligibility {
  readonly displayName: string;
  readonly configured: boolean;
  readonly eligible: boolean;
  readonly profileFingerprint?: string;
}

export interface PublicParticipationProfile {
  readonly description?: string;
  readonly avatarDataUrl?: string;
}

export interface ChannelHostRoute {
  readonly channelId: string;
  readonly threadId: string;
  readonly participants: Readonly<Record<string, { readonly displayName: string }>>;
}

export interface StandingInterest {
  readonly catId: string;
  readonly kind: 'response_requests';
  readonly status: 'active' | 'withdrawn';
  readonly revision: number;
  readonly updatedAt: string;
}

export interface HostRouteConfig {
  readonly connectionId: string;
  readonly localOwnerUserId: string;
  readonly defaultIngressThreadId: string;
  readonly humanNotificationThreadId: string;
  readonly agentRoutes: Readonly<Record<string, AgentHostRoute>>;
  readonly desiredParticipation: DesiredParticipation;
  readonly observedEligibility: Readonly<Record<string, ObservedCatEligibility>>;
  readonly publicProfiles: Readonly<Record<string, PublicParticipationProfile>>;
  readonly channelRoutes: Readonly<Record<string, ChannelHostRoute>>;
  readonly standingInterests: Readonly<Record<string, Readonly<Record<string, StandingInterest>>>>;
  readonly channelListening?: Readonly<Record<string, ChannelListening>>;
  readonly attentionRevision: number;
  readonly scopeStarts: Readonly<Record<string, number>>;
  readonly revision: number;
  readonly updatedAt: string;
}

export type SetHostRouteInput = Omit<
  HostRouteConfig,
  | 'connectionId'
  | 'revision'
  | 'updatedAt'
  | 'desiredParticipation'
  | 'observedEligibility'
  | 'publicProfiles'
  | 'channelRoutes'
  | 'standingInterests'
  | 'channelListening'
  | 'attentionRevision'
  | 'scopeStarts'
> &
  Partial<
    Pick<
      HostRouteConfig,
      | 'desiredParticipation'
      | 'observedEligibility'
      | 'channelRoutes'
      | 'standingInterests'
      | 'channelListening'
      | 'attentionRevision'
    >
  >;
