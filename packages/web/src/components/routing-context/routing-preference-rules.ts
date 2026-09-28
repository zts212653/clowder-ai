import type { RoutingPreferenceRevisionV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';

export const DAY_MS = 86_400_000;

/** Parse the comma-separated owner input into typed routing subjects, de-duplicated. */
export function routingSubjects(csv: string): RoutingSubjectRefV1[] {
  return [
    ...new Set(
      csv
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].map((value) => {
    if (value.startsWith('provider:'))
      return { type: 'provider' as const, providerId: value.slice('provider:'.length) };
    if (value.startsWith('pool:')) return { type: 'quota_pool' as const, poolId: value.slice('pool:'.length) };
    if (value.startsWith('quota_pool:')) {
      return { type: 'quota_pool' as const, poolId: value.slice('quota_pool:'.length) };
    }
    return { type: 'cat' as const, catId: value };
  });
}

export function subjectLabel(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return subject.catId;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `pool:${subject.poolId}`;
}

export function lifecycleLabel(head: RoutingPreferenceRevisionV1, now: number): string {
  if (head.lifecycle === 'retired') return '已退休';
  if (head.reviewAfter !== undefined && head.reviewAfter <= now) return '待复核';
  return '有效';
}
