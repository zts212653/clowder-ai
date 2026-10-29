import { collectiveIdSchema } from '@cat-cafe/shared';
import type { ClientSnapshot, CollectiveMe, RestrictedCollectiveScope } from './client-types.js';

export function currentCollectiveScope(snapshot: ClientSnapshot): RestrictedCollectiveScope | undefined {
  if (snapshot.restrictedScope) return snapshot.restrictedScope;
  const { meta, me, collective } = snapshot;
  return meta && me && collective
    ? {
        serviceInstanceId: meta.serviceInstanceId,
        collectiveId: collective.collectiveId,
        humanId: me.human.humanId,
        reason: 'checking',
      }
    : undefined;
}

export function closeCollectiveScope(
  current: ClientSnapshot,
  scope: RestrictedCollectiveScope,
  reason: RestrictedCollectiveScope['reason'],
  me = current.me,
): ClientSnapshot {
  return {
    ...current,
    me,
    collective: me?.collectives.find((item) => item.collectiveId === scope.collectiveId),
    restrictedScope: { ...scope, reason },
    events: [],
    channels: undefined,
    participants: undefined,
    members: undefined,
    collaboration: undefined,
    delivery: { kind: 'idle' },
    connection: reason === 'checking' || reason === 'unavailable' ? 'offline' : 'online',
    error: undefined,
  };
}

export function missingMembershipScope(serviceInstanceId: string, me: CollectiveMe) {
  const parsed = collectiveIdSchema.safeParse(new URLSearchParams(location.search).get('collectiveId'));
  const collectiveId = parsed.success ? parsed.data : undefined;
  return collectiveId && !me.collectives.some((item) => item.collectiveId === collectiveId)
    ? { serviceInstanceId, collectiveId, humanId: me.human.humanId, reason: 'membership_lost' as const }
    : undefined;
}

/** Read only this Human's own unsent prose; retire all stale recipients and content references. */
export function recoverOwnScopeDrafts(scope: RestrictedCollectiveScope) {
  const prefix = `collective-draft:${scope.serviceInstanceId}:${scope.collectiveId}:${scope.humanId}:`;
  const drafts: { key: string; body: string }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    let value: unknown;
    try {
      value = JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string') continue;
    if (value.body) drafts.push({ key, body: value.body });
    localStorage.setItem(key, JSON.stringify({ body: value.body, recipient: { kind: 'channel' }, recipientLabel: '' }));
  }
  return drafts;
}
