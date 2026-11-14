export const TTS_ENDPOINT: {
  readonly id: string;
  readonly port: number;
  readonly defaultEndpoint: string;
  readonly endpointEnvVars: readonly string[];
  readonly portEnvKey: string;
};
export function resolveServiceConfigPath(repoRoot: string, env?: NodeJS.ProcessEnv): string;
export function readServiceConfigFile(path: string): Record<string, unknown>;
export function normalizeLoopbackUrl(endpoint: string): string;
export function parseServicePort(value: string | undefined): number | null;
export function resolveConfiguredServiceEndpoint(
  service: { endpointEnvVars: readonly string[]; defaultEndpoint: string | null; portFallback?: { host: string } },
  env: NodeJS.ProcessEnv,
  config: { port?: number } | undefined,
  portEnvKey?: string,
): string | null;
