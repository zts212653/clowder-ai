// Installation includes dependency preparation; lifecycle writes may restart a runtime.
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const LIFECYCLE_TIMEOUT_MS = 5 * 60_000;
// The Host gives an owner's plugin request 180s; wait a little longer so its own answer arrives first.
const PLUGIN_OWNER_TIMEOUT_MS = 185_000;

export function mutationRequestOptions(path: string): { mutationTimeoutMs: number } | undefined {
  if (path.startsWith('/api/plugins/')) return { mutationTimeoutMs: PLUGIN_OWNER_TIMEOUT_MS };
  if (path.endsWith('/install') || path.endsWith('/install/upload') || path.endsWith('/update'))
    return { mutationTimeoutMs: INSTALL_TIMEOUT_MS };
  if (
    path.endsWith('/set-enabled') ||
    path.endsWith('/uninstall') ||
    path.endsWith('/repair') ||
    path.endsWith('/contributions/configuration')
  ) {
    return { mutationTimeoutMs: LIFECYCLE_TIMEOUT_MS };
  }
  return undefined;
}
