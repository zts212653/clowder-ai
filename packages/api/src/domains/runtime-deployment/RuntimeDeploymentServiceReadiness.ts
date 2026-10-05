import type { DeploymentService } from '@cat-cafe/shared';

/** Samples current API and Web health for one deployment observation. */
export async function readRuntimeServiceReadiness(input: {
  readonly isApiReady: () => Promise<boolean>;
  readonly webPort: number;
}): Promise<readonly DeploymentService[]> {
  const services: DeploymentService[] = [];
  try {
    if (await input.isApiReady()) services.push('api');
  } catch {
    // Missing API health is an unknown current service, not a ready fact.
  }
  if (!Number.isInteger(input.webPort) || input.webPort <= 0 || input.webPort > 65535) return services;
  try {
    const response = await fetch(`http://127.0.0.1:${input.webPort}/`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (response.status >= 200 && response.status < 400) services.push('web');
    await response.body?.cancel();
  } catch {
    // A historical Web ready event does not prove current readiness.
  }
  return services;
}
