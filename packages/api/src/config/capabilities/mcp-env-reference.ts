const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT_ENV_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

interface McpEnvReferenceCarrier {
  name?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export class MissingMcpEnvironmentVariableError extends Error {
  readonly serverName: string;
  readonly variableNames: string[];

  constructor(serverName: string, variableNames: string[]) {
    const uniqueNames = [...new Set(variableNames)].sort();
    super(`MCP "${serverName}" requires missing environment variable(s): ${uniqueNames.join(', ')}`);
    this.name = 'MissingMcpEnvironmentVariableError';
    this.serverName = serverName;
    this.variableNames = uniqueNames;
  }
}

function resolveValue(value: string, env: Readonly<Record<string, string | undefined>>, missing: string[]): string {
  return value.replace(ENV_REFERENCE_PATTERN, (placeholder, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      missing.push(name);
      return placeholder;
    }
    return resolved;
  });
}

function resolveRecord(
  record: Record<string, string> | undefined,
  env: Readonly<Record<string, string | undefined>>,
  missing: string[],
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolveValue(value, env, missing)]));
}

function renderRecord(
  record: Record<string, string> | undefined,
  render: (name: string) => string,
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      value.replace(ENV_REFERENCE_PATTERN, (_placeholder, name: string) => render(name)),
    ]),
  );
}

export function readExactMcpEnvironmentReference(value: string): string | undefined {
  return EXACT_ENV_REFERENCE_PATTERN.exec(value)?.[1];
}

/**
 * Resolve `${ENV_VAR}` references only at MCP invocation/probe time.
 *
 * Persistent capability and CLI configs keep references, never resolved values.
 * Missing or empty variables fail closed instead of emitting empty credentials.
 */
export function resolveMcpServerEnvReferences<T extends McpEnvReferenceCarrier>(
  descriptor: T,
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicitServerName?: string,
): T {
  const serverName = explicitServerName ?? descriptor.name ?? '(unknown)';
  const missing: string[] = [];
  const resolvedEnv = resolveRecord(descriptor.env, env, missing);
  const resolvedHeaders = resolveRecord(descriptor.headers, env, missing);
  if (missing.length > 0) {
    throw new MissingMcpEnvironmentVariableError(serverName, missing);
  }

  return {
    ...descriptor,
    ...(resolvedEnv ? { env: resolvedEnv } : {}),
    ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
  } as T;
}

/**
 * Verify that every reference is present without materializing any secret.
 *
 * Providers with native interpolation (Claude Code and OpenCode) use this
 * before persisting an invocation config that still contains references.
 */
export function assertMcpServerEnvReferencesAvailable<T extends McpEnvReferenceCarrier>(
  descriptor: T,
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicitServerName?: string,
): void {
  resolveMcpServerEnvReferences(descriptor, env, explicitServerName);
}

/**
 * Validate references, then rewrite each carrier value as a whole.
 *
 * Unlike `renderMcpServerEnvReferences` (name-level placeholder rewrite), this
 * hands the renderer the full value string, so partial references like
 * `Bearer ${TOKEN}` can be rewritten into a single replacement expression.
 * Values without references are passed through untouched.
 */
export function renderMcpServerEnvReferenceValues<T extends McpEnvReferenceCarrier>(
  descriptor: T,
  renderValue: (value: string) => string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicitServerName?: string,
): T {
  assertMcpServerEnvReferencesAvailable(descriptor, env, explicitServerName);
  const mapRecord = (record: Record<string, string> | undefined) =>
    record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, renderValue(value)])) : undefined;
  const renderedEnv = mapRecord(descriptor.env);
  const renderedHeaders = mapRecord(descriptor.headers);
  return {
    ...descriptor,
    ...(renderedEnv ? { env: renderedEnv } : {}),
    ...(renderedHeaders ? { headers: renderedHeaders } : {}),
  } as T;
}

/**
 * Validate references, then rewrite only their placeholder syntax.
 *
 * OpenCode uses `{env:NAME}` rather than `${NAME}` in persisted config. This
 * keeps the secret out of the invocation-scoped file while preserving the
 * capabilities schema's provider-neutral reference format.
 */
export function renderMcpServerEnvReferences<T extends McpEnvReferenceCarrier>(
  descriptor: T,
  render: (name: string) => string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicitServerName?: string,
): T {
  assertMcpServerEnvReferencesAvailable(descriptor, env, explicitServerName);
  const renderedEnv = renderRecord(descriptor.env, render);
  const renderedHeaders = renderRecord(descriptor.headers, render);
  return {
    ...descriptor,
    ...(renderedEnv ? { env: renderedEnv } : {}),
    ...(renderedHeaders ? { headers: renderedHeaders } : {}),
  } as T;
}
