/** DSH SDK 1.4 sends these provider failures as prose in a JSON-RPC error. */
const CREDENTIAL_MISSING_RE =
  /llm-pi-ai:\s*no credential for provider route\s+"([^"]+)"[\s\S]*?resolves\s+([A-Za-z_][A-Za-z0-9_]*)\s*,\s*which is not set/i;
const MISSING_API_KEY_RE =
  /llm-deepseek:\s*no API key for provider route\s+"([^"]+)"[\s\S]*?store\s+([A-Za-z_][A-Za-z0-9_]*)\s+through the credentials service/i;

export function matchDshMissingCredential(message: string) {
  return CREDENTIAL_MISSING_RE.exec(message) ?? MISSING_API_KEY_RE.exec(message);
}
