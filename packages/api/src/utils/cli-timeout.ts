export const DEFAULT_CLI_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CLI_TIMEOUT_LABEL = `${DEFAULT_CLI_TIMEOUT_MS} (30分钟)`;

export function parseCliTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function readCliTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return parseCliTimeoutMs(env.CLI_TIMEOUT_MS);
}

export function resolveCliTimeoutMs(overrideMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  return overrideMs ?? readCliTimeoutMsFromEnv(env) ?? DEFAULT_CLI_TIMEOUT_MS;
}
