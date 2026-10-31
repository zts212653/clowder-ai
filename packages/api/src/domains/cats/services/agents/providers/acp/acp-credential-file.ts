/**
 * ACP compatibility surface for provider-neutral session credential files.
 *
 * Keep this module path stable for existing ACP callers and tests while the
 * shared implementation namespaces bindings under `acp`.
 */

import {
  bindSessionCredentialFile as bindProviderSessionCredentialFile,
  type PreparedCredentialEnv,
  prepareSessionCredentialFile as prepareProviderSessionCredentialFile,
  resolveSessionCredentialFile as resolveProviderSessionCredentialFile,
  writeSessionCredentialFile,
} from '../session-credential-file.js';

const ACP_CREDENTIAL_NAMESPACE = 'acp';

export type { PreparedCredentialEnv };
export { writeSessionCredentialFile };

export function resolveSessionCredentialFile(
  callbackEnv: Record<string, string> | undefined,
  resumeSessionId?: string,
): PreparedCredentialEnv | null {
  return resolveProviderSessionCredentialFile(ACP_CREDENTIAL_NAMESPACE, callbackEnv, resumeSessionId);
}

export function prepareSessionCredentialFile(
  callbackEnv: Record<string, string> | undefined,
  resumeSessionId?: string,
): PreparedCredentialEnv | null {
  return prepareProviderSessionCredentialFile(ACP_CREDENTIAL_NAMESPACE, callbackEnv, resumeSessionId);
}

export function bindSessionCredentialFile(sessionId: string | undefined, path: string): void {
  bindProviderSessionCredentialFile(ACP_CREDENTIAL_NAMESPACE, sessionId, path);
}
