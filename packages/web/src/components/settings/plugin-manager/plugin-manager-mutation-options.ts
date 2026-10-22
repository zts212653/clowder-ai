// Installation includes dependency preparation; lifecycle writes may restart a runtime.
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const LIFECYCLE_TIMEOUT_MS = 5 * 60_000;

export function mutationRequestOptions(path: string): { mutationTimeoutMs: number } | undefined {
  if (path.endsWith('/install') || path.endsWith('/update')) return { mutationTimeoutMs: INSTALL_TIMEOUT_MS };
  if (path.endsWith('/set-enabled') || path.endsWith('/uninstall') || path.endsWith('/contributions/configuration')) {
    return { mutationTimeoutMs: LIFECYCLE_TIMEOUT_MS };
  }
  return undefined;
}
