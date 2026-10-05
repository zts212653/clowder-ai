/** Canonical message passages use UTC ISO strings with millisecond precision. */
export function normalizeMessageSearchDates<T extends { dateFrom?: string; dateTo?: string }>(options: T): T {
  const normalize = (value: string, endOfDay: boolean): string => {
    const instant = value.length === 10 && endOfDay ? `${value}T23:59:59.999Z` : value;
    const timestamp = Date.parse(instant);
    if (!Number.isFinite(timestamp)) throw new Error('Invalid message search date');
    return new Date(timestamp).toISOString();
  };
  return {
    ...options,
    ...(options.dateFrom ? { dateFrom: normalize(options.dateFrom, false) } : {}),
    ...(options.dateTo ? { dateTo: normalize(options.dateTo, true) } : {}),
  };
}
