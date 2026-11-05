/** Explicit owner-visible DTO for the shell's synthetic read scenarios, including unknown counts. */
export function visibleAttentionFixture(read) {
  const known = Number.isSafeInteger(read.totalCount) && Number.isSafeInteger(read.attentionCount);
  const mentions = read.items.filter((item) => item.kind === 'user_mention').length;
  const empty = { decisions: 0, userMentions: 0, other: 0 };
  const visible = known
    ? {
        decisions: read.attentionCount,
        userMentions: mentions,
        other: read.totalCount - read.attentionCount - mentions,
      }
    : undefined;
  return {
    ...read,
    // Missing totals remain unknown rather than being replaced with the number of visible rows.
    ...(!known ? { totalCount: undefined, attentionCount: undefined } : {}),
    sources: {
      ...read.sources,
      personalPreferences: {
        status: 'available',
        startedAt: 1,
        observedAt: 2,
        coverage: 'owner_personal_ignored_items',
        exhaustiveness: 'complete',
      },
    },
    items: read.items.map((item) => ({
      ...item,
      preferenceCoordinate: { kind: 'mailbox', decisionRef: item.decisionRef, version: `fixture:${item.decisionRef}` },
    })),
    personalView: {
      mode: 'visible',
      preferenceRevision: 0,
      ...(known
        ? {
            originalTotalCount: read.totalCount,
            visibleTotalCount: read.totalCount,
            ignoredTotalCount: 0,
            originalAttentionCount: read.attentionCount,
            visibleAttentionCount: read.attentionCount,
            ignoredAttentionCount: 0,
            groupCounts: { original: visible, visible, ignored: empty },
          }
        : {}),
    },
  };
}
