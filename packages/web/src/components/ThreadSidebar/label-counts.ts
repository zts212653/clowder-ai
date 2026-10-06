/** Count assignable threads once per label, independently of the current search/filter. */
export function countThreadsByLabel(threads: readonly { labels?: readonly string[] }[]) {
  const byLabel = new Map<string, number>();
  let uncategorized = 0;
  for (const thread of threads) {
    if (!thread.labels || thread.labels.length === 0) {
      uncategorized += 1;
      continue;
    }
    for (const id of new Set(thread.labels)) {
      byLabel.set(id, (byLabel.get(id) ?? 0) + 1);
    }
  }
  return { byLabel, uncategorized };
}
