interface CredentialSources {
  isCredentialSource(path: string): boolean;
}

const scriptUrl = new URL('../../../scripts/lib/secret-credential-paths.mjs', import.meta.url).href;

/** Call after symbolic/workspace resolution, before opening file contents. */
export async function credentialReadDenial(path: string): Promise<string | null> {
  const sources = (await import(scriptUrl)) as CredentialSources;
  return sources.isCredentialSource(path) ? 'credential_source_blocked_before_read' : null;
}
