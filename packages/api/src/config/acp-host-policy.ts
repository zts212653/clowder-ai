export const ACP_BOOTSTRAP_MODES = ['strict', 'trusted-host'] as const;
export const ACP_CONFIG_AUDIT_MODES = ['required', 'warn-bootstrap-root'] as const;

function choice<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`${name} must be ${allowed.join(' or ')}; update the Host deployment configuration and restart API`);
}

export function resolveAcpHostPolicy(policyEnv: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const legacy = policyEnv.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY === '1';
  const bootstrap = choice(
    'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
    policyEnv.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE,
    ACP_BOOTSTRAP_MODES,
  );
  const audit = choice(
    'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
    policyEnv.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE,
    ACP_CONFIG_AUDIT_MODES,
  );
  const bootstrapMode = bootstrap ?? (legacy ? 'trusted-host' : 'strict');
  const requestedAuditMode = audit ?? (legacy ? 'warn-bootstrap-root' : 'required');
  const auditWarningAllowed =
    platform === 'win32' && bootstrapMode === 'trusted-host' && requestedAuditMode === 'warn-bootstrap-root';
  return {
    bootstrapMode,
    requestedAuditMode,
    effectiveAuditMode: auditWarningAllowed ? 'warn-bootstrap-root' : 'required',
    auditWarningAllowed,
    legacy,
    legacyBootstrap: legacy && bootstrap === undefined,
    legacyAudit: legacy && audit === undefined,
    suppressedReason:
      requestedAuditMode !== 'warn-bootstrap-root'
        ? undefined
        : auditWarningAllowed
          ? undefined
          : platform !== 'win32'
            ? 'non-Windows Host'
            : 'bootstrap mode is strict',
  } as const;
}

/** Called once by API startup, before any plugin recovery or listener. Never writes configuration. */
export function reportAcpHostPolicy(
  logger: {
    info(fields: Record<string, unknown>, message: string): unknown;
    warn(fields: Record<string, unknown>, message: string): unknown;
  },
  policy: ReturnType<typeof resolveAcpHostPolicy>,
): void {
  logger.info({ code: 'ACP_HOST_POLICY', ...policy }, 'ACP Host deployment policy (restart-only)');
  if (policy.legacy)
    logger.warn(
      { code: 'ACP_LEGACY_POLICY', ...policy },
      policy.legacyAudit && policy.auditWarningAllowed
        ? 'Legacy exact-one setting enables a restricted audit exception: existing Windows ACP bootstrap roots only; migrate to the two explicit Host settings'
        : 'Legacy ACP setting is deprecated; explicit new settings win and audit exceptions may be inactive (see effectiveAuditMode/suppressedReason)',
    );
}
