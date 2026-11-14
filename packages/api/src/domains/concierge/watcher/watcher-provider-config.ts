/** config/read includes optional nulls; native config overrides are TOML and cannot carry JSON null. */
export function watcherProviderOverrides(value: Record<string, unknown>): Record<string, unknown> {
  const present = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.filter((item) => item !== null && item !== undefined).map(present);
    if (entry !== null && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([, item]) => item !== null && item !== undefined)
          .map(([key, item]) => [key, present(item)]),
      );
    return entry;
  };
  return present(value) as Record<string, unknown>;
}
