export type FirstEntryPhase = 'idle' | 'entry' | 'browsing' | 'loading' | 'empty' | 'playing' | 'handoff';

export interface FirstEntryConditions {
  readonly embedded: boolean;
  readonly ready: boolean;
  readonly paired: boolean;
  readonly entryDismissed: boolean;
  readonly participantsLoaded: boolean;
  readonly ownCatCount: number;
  readonly viewed: boolean;
  readonly pairStarted: boolean;
  readonly publishedCatCount?: number;
  readonly replaying: boolean;
  readonly handoff: boolean;
}

export function firstEntryPhase(conditions: FirstEntryConditions): FirstEntryPhase {
  if (!conditions.embedded || !conditions.ready) return 'idle';
  if (!conditions.paired) return conditions.entryDismissed ? 'browsing' : 'entry';
  if (!conditions.participantsLoaded) return 'loading';
  if (conditions.ownCatCount === 0) {
    if (conditions.pairStarted && !conditions.viewed && conditions.publishedCatCount !== 0) return 'loading';
    return 'empty';
  }
  if (conditions.replaying || (conditions.pairStarted && !conditions.viewed)) return 'playing';
  return conditions.handoff ? 'handoff' : 'idle';
}

export function firstEntryBrowseKey(identity: {
  readonly serviceInstanceId?: string;
  readonly collectiveId?: string;
  readonly humanId?: string;
}): string | undefined {
  const { serviceInstanceId, collectiveId, humanId } = identity;
  if (!serviceInstanceId || !collectiveId || !humanId) return undefined;
  const owner = [serviceInstanceId, collectiveId, humanId].map(encodeURIComponent).join(':');
  return `collective-first-entry:browse:${owner}`;
}

export function firstEntryKeys(identity: {
  readonly serviceInstanceId?: string;
  readonly collectiveId?: string;
  readonly humanId?: string;
  readonly connectionId?: string;
}): { readonly entry: string; readonly viewed: string; readonly hint: string; readonly baseline: string } | undefined {
  const entry = firstEntryBrowseKey(identity);
  if (!entry || !identity.connectionId) return undefined;
  const connection = `${entry}:${encodeURIComponent(identity.connectionId)}`;
  return {
    entry,
    viewed: `collective-first-entry:viewed:${connection}`,
    hint: `collective-first-entry:reply-hint:${connection}`,
    baseline: `collective-first-entry:reply-baseline:${connection}`,
  };
}

export const firstEntryBeatMs = 3_500;
