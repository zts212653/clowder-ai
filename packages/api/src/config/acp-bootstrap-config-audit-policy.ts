import { resolveAcpHostPolicy } from './acp-host-policy.js';

/** Only a Host deployment setting can opt into the narrow, root-only exception. */
export function allowsAcpBootstrapConfigAuditWarning(): boolean {
  return resolveAcpHostPolicy().auditWarningAllowed;
}
