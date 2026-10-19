export const COLLECTIVE_ACCOUNTABILITY_CHANGED_EVENT = 'collective:accountability-changed';

export interface CollectiveAccountabilityChangedDetail {
  readonly workId: string;
  readonly workRevision: number;
  readonly accountabilityRequestId: string;
  readonly status: 'accepted' | 'declined';
}

export function publishCollectiveAccountabilityChanged(detail: CollectiveAccountabilityChangedDetail): void {
  window.dispatchEvent(
    new CustomEvent<CollectiveAccountabilityChangedDetail>(COLLECTIVE_ACCOUNTABILITY_CHANGED_EVENT, {
      detail,
    }),
  );
}
