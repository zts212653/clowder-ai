// The only CODEX_*/OPENAI_* inputs a managed launch carries: our own routing/identity fields.
const MANAGED_RUNTIME_OWNED_ENV = new Set(['CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_AUTH_MODE']);
const MANAGED_RUNTIME_OWNED_PREFIX = 'CODEX_CAT_';
const NATIVE_ENV_NAMESPACE = /^(?:CODEX|OPENAI)_/;
/**
 * Managed OAuth launches take no other CODEX_* / OPENAI_* input from the parent or account env.
 * ALTERNATIVE_CREDENTIAL_ENV was read from one version's source; a later Codex can add another
 * endpoint/token/issuer knob. Nulling the whole namespace keeps such a knob out of a credentialed
 * launch on any version, so version admission no longer has to stand in for that review.
 */
export function withoutUnreviewedCodexEnvironment<T extends Record<string, string | null>>(
  env: T,
  inherited: NodeJS.ProcessEnv = process.env,
): T {
  const result: Record<string, string | null> = { ...env };
  for (const key of new Set([...Object.keys(inherited), ...Object.keys(env)]))
    if (
      NATIVE_ENV_NAMESPACE.test(key) &&
      !MANAGED_RUNTIME_OWNED_ENV.has(key) &&
      !key.startsWith(MANAGED_RUNTIME_OWNED_PREFIX)
    )
      result[key] = null;
  return result as T;
}
