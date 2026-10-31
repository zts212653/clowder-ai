export function resolveLayoutThreadId(
  pathnameThreadId: string,
  browserThreadId: string | null,
  immediateBrowserThreadId: string | null = null,
): string {
  if (immediateBrowserThreadId !== null) return immediateBrowserThreadId;
  if (browserThreadId !== null) return browserThreadId;
  return pathnameThreadId;
}
