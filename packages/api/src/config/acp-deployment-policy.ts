import {
  initializeAcpBootstrapConfigAuditMode,
  resolveAcpBootstrapConfigAuditMode,
} from './acp-bootstrap-config-audit-policy.js';
import { initializeWindowsAcpBootstrapMode, resolveWindowsAcpBootstrapMode } from './trusted-host-compatibility.js';

export function initializeAcpDeploymentPolicy(log: {
  info(value: unknown, message: string): void;
  warn(value: unknown, message: string): void;
}): void {
  // Validate both enums before freezing either policy, plugin recovery or listening.
  const bootstrap = resolveWindowsAcpBootstrapMode();
  const requestedAudit = resolveAcpBootstrapConfigAuditMode();
  initializeWindowsAcpBootstrapMode();
  initializeAcpBootstrapConfigAuditMode();
  const audit = process.platform === 'win32' && bootstrap === 'trusted-host' ? requestedAudit : 'required';
  log.info(
    {
      bootstrap,
      requestedAudit,
      effectiveAudit: audit,
      bootstrapSource:
        process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE !== undefined
          ? 'explicit'
          : process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY === '1'
            ? 'legacy'
            : 'default',
      auditSource:
        process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE !== undefined
          ? 'explicit'
          : process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY === '1'
            ? 'legacy'
            : 'default',
      ...(audit !== requestedAudit ? { reason: 'Audit recovery requires Windows trusted-host bootstrap policy' } : {}),
    },
    'ACP Host deployment policies (restart required to change)',
  );
  if (process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY !== undefined)
    log.warn(
      {},
      'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY is deprecated; its exact 1 alias enables only Windows directory compatibility and restricted existing-client bootstrap-root audit recovery. Migrate to the two explicit modes.',
    );
}
