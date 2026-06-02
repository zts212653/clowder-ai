export function resolveLayoutThreadId(
  pathnameThreadId: string,
  browserThreadId: string | null,
  immediateBrowserThreadId: string | null = null,
): string {
  if (browserThreadId !== null) return browserThreadId;
  if (immediateBrowserThreadId !== null) return immediateBrowserThreadId;
  return pathnameThreadId;
}
