import { isTrustedHostCompatibilityEnabled } from './trusted-host-compatibility.js';

/** Only a Host deployment setting can opt into the narrow, root-only exception. */
let initializedMode: 'required' | 'warn-bootstrap-root' | undefined;
export function resolveAcpBootstrapConfigAuditMode(
  env: NodeJS.ProcessEnv = process.env,
): 'required' | 'warn-bootstrap-root' {
  const mode =
    env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE ??
    (env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY === '1' ? 'warn-bootstrap-root' : 'required');
  if (mode !== 'required' && mode !== 'warn-bootstrap-root')
    throw new Error('CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE must be required or warn-bootstrap-root');
  return mode;
}
export function initializeAcpBootstrapConfigAuditMode(): void {
  initializedMode = resolveAcpBootstrapConfigAuditMode();
}
export function allowsAcpBootstrapConfigAuditWarning(): boolean {
  return (
    process.platform === 'win32' &&
    (initializedMode ?? resolveAcpBootstrapConfigAuditMode()) === 'warn-bootstrap-root' &&
    isTrustedHostCompatibilityEnabled()
  );
}
