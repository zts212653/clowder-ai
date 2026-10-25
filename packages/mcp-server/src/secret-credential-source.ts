import { isCredentialSource } from './secret-runtime.js';

/** Call after symbolic/workspace resolution, before opening file contents. */
export async function credentialReadDenial(path: string): Promise<string | null> {
  return isCredentialSource(path) ? 'credential_source_blocked_before_read' : null;
}
