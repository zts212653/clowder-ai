/** Snapshot admitted JSON data before any await or package code can retain its references. */
export function snapshotModuleAuthority<T>(value: T): T {
  const snapshot = structuredClone(value);
  const pending: unknown[] = [snapshot];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    pending.push(...Object.values(current));
    Object.freeze(current);
  }
  return snapshot;
}
