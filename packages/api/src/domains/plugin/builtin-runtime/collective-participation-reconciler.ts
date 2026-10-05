import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ChannelHostRoute,
  type CollectiveConnector,
  type DesiredParticipation,
  defaultDesiredParticipation,
  type HostRouteConfig,
  type ObservedCatEligibility,
} from '@cat-cafe/collective-connector';
import type { CatId } from '@cat-cafe/shared';
import { collectiveAvatarRoots, publicCollectiveAvatar } from './collective-public-avatar.js';

export interface ParticipationCat {
  readonly id: string;
  readonly displayName: string;
  readonly supported: boolean;
  readonly avatar?: string;
  readonly roleDescription?: string;
  readonly defaultModel?: string;
}

interface ReconcileOptions {
  readonly connector: Pick<CollectiveConnector, 'setHostRoute' | 'publishParticipation'>;
  readonly threads: {
    get(
      threadId: string,
    ):
      | { id: string; createdBy: string; participants: readonly string[]; deletedAt?: number | null }
      | null
      | Promise<{ id: string; createdBy: string; participants: readonly string[]; deletedAt?: number | null } | null>;
    create(
      userId: string,
      title?: string,
    ): Promise<{ id: string; participants: readonly string[] }> | { id: string; participants: readonly string[] };
    addParticipants(threadId: string, catIds: CatId[]): void | Promise<void>;
  };
  readonly connectionId: string;
  readonly ownerUserId: string;
  readonly route?: HostRouteConfig;
  readonly expectedRevision: number;
  readonly channelIds: readonly string[];
  readonly cats: readonly ParticipationCat[];
  readonly policy?: DesiredParticipation;
  readonly initialExcludedCatIds?: readonly string[];
}

export async function reconcileParticipation(options: ReconcileOptions): Promise<HostRouteConfig> {
  if ((options.route?.revision ?? 0) !== options.expectedRevision) throw conflict();
  const channelIds = uniqueSorted(options.channelIds);
  if (!channelIds.length)
    throw Object.assign(new Error('At least one authorized Channel is required'), {
      code: 'INVALID_PARTICIPATION_REQUEST',
    });
  const desiredParticipation = normalizePolicy(
    preserveInitialExclusions(
      options.policy ??
        legacyAwarePolicy(options.route, channelIds) ??
        options.route?.desiredParticipation ??
        defaultDesiredParticipation(),
      options.route,
      options.initialExcludedCatIds,
    ),
  );
  const observedEligibility = observeEligibility(options.route?.observedEligibility ?? {}, options.cats);
  const publicProfiles = await collectPublicProfiles(options.cats);
  const channelRoutes: Record<string, ChannelHostRoute> = {};
  for (const channelId of channelIds) {
    const participants = materializedParticipants(desiredParticipation, observedEligibility, channelId);
    const threadId = await endpointThread(
      options,
      options.route?.channelRoutes?.[channelId]?.threadId,
      channelId,
      Object.keys(participants),
    );
    channelRoutes[channelId] = { channelId, threadId, participants };
  }
  const firstThreadId = channelRoutes[channelIds[0] ?? '']?.threadId;
  if (!firstThreadId)
    throw Object.assign(new Error('Channel endpoint was not materialized'), { code: 'PARTICIPATION_UNAVAILABLE' });
  const next = {
    localOwnerUserId: options.ownerUserId,
    defaultIngressThreadId: await retainedOwnerThread(options, options.route?.defaultIngressThreadId, firstThreadId),
    humanNotificationThreadId: await retainedOwnerThread(
      options,
      options.route?.humanNotificationThreadId,
      firstThreadId,
    ),
    agentRoutes: options.route?.agentRoutes ?? {},
    desiredParticipation,
    observedEligibility,
    publicProfiles,
    channelRoutes,
    standingInterests: options.route?.standingInterests ?? {},
    attentionRevision: options.route?.attentionRevision ?? 0,
  };
  const route =
    options.route && sameRouteInput(options.route, next)
      ? options.route
      : await options.connector.setHostRoute(options.connectionId, next, options.expectedRevision);
  await options.connector.publishParticipation(options.connectionId);
  return route;
}

export function currentParticipationCats(
  observed: Readonly<Record<string, ObservedCatEligibility>>,
  cats: readonly ParticipationCat[],
) {
  const current = observeEligibility(observed, cats);
  return Object.entries(current)
    .map(([id, eligibility]) => ({ id, ...eligibility }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}

function observeEligibility(
  previous: Readonly<Record<string, ObservedCatEligibility>>,
  cats: readonly ParticipationCat[],
): Record<string, ObservedCatEligibility> {
  const observed: Record<string, ObservedCatEligibility> = {};
  for (const [catId, prior] of Object.entries(previous)) {
    observed[catId] = { ...prior, configured: false, eligible: false };
  }
  for (const cat of cats) {
    observed[cat.id] = {
      displayName: cat.displayName,
      configured: true,
      eligible: cat.supported,
      profileFingerprint: profileFingerprint(cat),
    };
  }
  return sortRecord(observed);
}

function profileFingerprint(cat: ParticipationCat) {
  return createHash('sha256')
    .update(JSON.stringify([cat.displayName, cat.avatar, cat.roleDescription]))
    .digest('hex');
}

async function collectPublicProfiles(cats: readonly ParticipationCat[]) {
  const roots = collectiveAvatarRoots();
  return sortRecord(
    Object.fromEntries(
      await Promise.all(
        cats
          .filter((cat) => cat.supported)
          .map(async (cat) => {
            const avatarDataUrl = await publicCollectiveAvatar(cat.avatar, roots);
            const description = cat.roleDescription?.trim().slice(0, 120);
            return [
              cat.id,
              {
                ...(description ? { description } : {}),
                ...(avatarDataUrl ? { avatarDataUrl } : {}),
              },
            ] as const;
          }),
      ),
    ),
  );
}

function materializedParticipants(
  policy: DesiredParticipation,
  observed: Readonly<Record<string, ObservedCatEligibility>>,
  channelId: string,
) {
  const globalExclusions = new Set(policy.excludedCatIds);
  const channelExclusions = new Set(policy.channelOverrides[channelId]?.excludedCatIds ?? []);
  return sortRecord(
    Object.fromEntries(
      Object.entries(observed).flatMap(([catId, cat]) =>
        cat.configured && cat.eligible && !globalExclusions.has(catId) && !channelExclusions.has(catId)
          ? [[catId, { displayName: cat.displayName }]]
          : [],
      ),
    ),
  );
}

function normalizePolicy(policy: DesiredParticipation): DesiredParticipation {
  return {
    defaultMode: 'include',
    excludedCatIds: uniqueSorted(policy.excludedCatIds),
    channelOverrides: sortRecord(
      Object.fromEntries(
        Object.entries(policy.channelOverrides).map(([channelId, override]) => [
          channelId,
          { excludedCatIds: uniqueSorted(override.excludedCatIds) },
        ]),
      ),
    ),
  };
}

export function preserveInitialExclusions(
  policy: DesiredParticipation,
  route: HostRouteConfig | undefined,
  initialExcludedCatIds: readonly string[] = [],
): DesiredParticipation {
  if (Object.keys(route?.channelRoutes ?? {}).length) return policy;
  return {
    ...policy,
    excludedCatIds: uniqueSorted([
      ...policy.excludedCatIds,
      ...(route?.desiredParticipation?.excludedCatIds ?? []),
      ...initialExcludedCatIds,
    ]),
  };
}

function legacyAwarePolicy(route: HostRouteConfig | undefined, channelIds: readonly string[]) {
  if (!route || Object.keys(route.observedEligibility ?? {}).length || Object.keys(route.channelRoutes ?? {}).length)
    return undefined;
  const bindings = Object.values(route.agentRoutes);
  if (!bindings.length) return undefined;
  const excludedCatIds = bindings.filter((binding) => !binding.participation).map((binding) => binding.catId);
  const channelOverrides = Object.fromEntries(
    channelIds.flatMap((channelId) => {
      const excluded = bindings
        .filter((binding) => binding.participation && !binding.participation.channelIds.includes(channelId))
        .map((binding) => binding.catId);
      return excluded.length ? [[channelId, { excludedCatIds: uniqueSorted(excluded) }]] : [];
    }),
  );
  return { defaultMode: 'include' as const, excludedCatIds: uniqueSorted(excludedCatIds), channelOverrides };
}

async function endpointThread(
  options: ReconcileOptions,
  existingId: string | undefined,
  channelId: string,
  participantIds: readonly string[],
) {
  const existing = existingId ? await options.threads.get(existingId) : undefined;
  const thread =
    existing && !existing.deletedAt && existing.createdBy === options.ownerUserId
      ? existing
      : await options.threads.create(options.ownerUserId, `Collective #${channelId} 公共参与`);
  const missing = participantIds.filter((catId) => !thread.participants?.includes(catId));
  if (missing.length) await options.threads.addParticipants(thread.id, missing as CatId[]);
  return thread.id;
}

async function retainedOwnerThread(options: ReconcileOptions, existingId: string | undefined, fallbackId: string) {
  const existing = existingId ? await options.threads.get(existingId) : undefined;
  return existing && !existing.deletedAt && existing.createdBy === options.ownerUserId ? existing.id : fallbackId;
}

function sameRouteInput(
  route: HostRouteConfig,
  next: Omit<HostRouteConfig, 'connectionId' | 'revision' | 'updatedAt' | 'scopeStarts'>,
) {
  return isDeepStrictEqual(
    {
      localOwnerUserId: route.localOwnerUserId,
      defaultIngressThreadId: route.defaultIngressThreadId,
      humanNotificationThreadId: route.humanNotificationThreadId,
      agentRoutes: route.agentRoutes,
      desiredParticipation: route.desiredParticipation,
      observedEligibility: route.observedEligibility,
      publicProfiles: route.publicProfiles,
      channelRoutes: route.channelRoutes,
      standingInterests: route.standingInterests,
      attentionRevision: route.attentionRevision,
    },
    next,
  );
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function sortRecord<Value>(record: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function conflict() {
  return Object.assign(new Error('Collective participation changed'), { code: 'PARTICIPATION_REVISION_CONFLICT' });
}
