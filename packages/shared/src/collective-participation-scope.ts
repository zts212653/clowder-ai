type Participation = {
  readonly revision: number;
  readonly agents: readonly { readonly catId: string; readonly channelIds: readonly string[] }[];
  readonly scopeStarts?: Readonly<Record<string, number>>;
};

/** Tracks uninterrupted participation in each existing Café/Cat/Channel relation, independent of profile edits. */
export function participationScopeStarts(previous: Participation | undefined, current: Participation) {
  const previousKeys = new Set(
    previous?.agents.flatMap((agent) => agent.channelIds.map((channel) => participationScopeKey(agent.catId, channel))),
  );
  return Object.fromEntries(
    current.agents.flatMap((agent) =>
      agent.channelIds.map((channel) => {
        const key = participationScopeKey(agent.catId, channel);
        const since =
          previousKeys.has(key) && previous ? (previous.scopeStarts?.[key] ?? previous.revision) : current.revision;
        return [key, since];
      }),
    ),
  );
}

export function participationScopeKey(catId: string, channelId: string) {
  return JSON.stringify([catId, channelId]);
}

export function participationSourceIsCurrent(
  current: Pick<Participation, 'revision' | 'scopeStarts'>,
  catId: string,
  channelId: string,
  sourceRevision: number,
) {
  const since = current.scopeStarts?.[participationScopeKey(catId, channelId)] ?? current.revision;
  return sourceRevision >= since && sourceRevision <= current.revision;
}
