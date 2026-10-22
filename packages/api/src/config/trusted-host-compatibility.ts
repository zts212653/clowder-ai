/** Host deployment opt-in; never derived from an agent or plugin's environment. */
let initializedMode: 'strict' | 'trusted-host' | undefined;
export function resolveWindowsAcpBootstrapMode(env: NodeJS.ProcessEnv = process.env): 'strict' | 'trusted-host' {
  const mode = env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
  if (mode !== undefined) {
    if (mode !== 'strict' && mode !== 'trusted-host')
      throw new Error('CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE must be strict or trusted-host');
    return mode;
  }
  return env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY === '1' ? 'trusted-host' : 'strict';
}
export function initializeWindowsAcpBootstrapMode(): void {
  initializedMode = resolveWindowsAcpBootstrapMode();
}
export function isTrustedHostCompatibilityEnabled(): boolean {
  return (initializedMode ?? resolveWindowsAcpBootstrapMode()) === 'trusted-host';
}
