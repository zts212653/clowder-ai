import profiles from './deployment-profiles.json' with { type: 'json' };

export interface DeploymentProfile {
  apiPort: number;
  webPort: number;
  envRegistryFrontendPort: number;
  corsOrigins: string[];
  roadmapPath: string;
}

interface DeploymentProfiles {
  schemaVersion: 1;
  activeProfile: string;
  profiles: Record<string, DeploymentProfile>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid deployment configuration: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function port(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid deployment configuration: ${label} must be a valid port`);
  }
  return value;
}

function roadmapPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('docs/') ||
    !value.endsWith('.md') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: configuration paths must reject control bytes.
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid deployment configuration: roadmapPath must be a relative Markdown path under docs/');
  }
  return value;
}

function selectProfile(input: unknown, requested?: string): { name: string; profile: DeploymentProfile } {
  const file = record(input, 'file');
  if (file.schemaVersion !== 1) throw new Error('Unsupported deployment configuration schemaVersion');
  const name = requested ?? file.activeProfile;
  if (typeof name !== 'string' || !name.trim()) throw new Error('Missing active deployment profile');
  const available = record(file.profiles, 'profiles');
  const selected = record(available[name], `profile ${name}`);
  const corsOrigins = selected.corsOrigins;
  if (
    !Array.isArray(corsOrigins) ||
    !corsOrigins.every((origin: unknown) => {
      if (typeof origin !== 'string') return false;
      try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
      } catch {
        return false;
      }
    })
  ) {
    throw new Error('Invalid deployment configuration: corsOrigins must contain HTTP(S) origins');
  }
  return {
    name,
    profile: {
      apiPort: port(selected.apiPort, 'apiPort'),
      webPort: port(selected.webPort, 'webPort'),
      envRegistryFrontendPort: port(selected.envRegistryFrontendPort, 'envRegistryFrontendPort'),
      corsOrigins: [...corsOrigins],
      roadmapPath: roadmapPath(selected.roadmapPath),
    },
  };
}

/** Defaults only: each consumer retains its existing environment override order. */
export function resolveDeploymentDefaults(input: unknown = profiles) {
  const { profile } = selectProfile(input);
  return {
    ...profile,
    apiBaseUrl: `http://localhost:${profile.apiPort}`,
    apiLoopbackUrl: `http://127.0.0.1:${profile.apiPort}`,
    frontendBaseUrl: `http://localhost:${profile.webPort}`,
  };
}

/** Public build projection changes data, never the shared consumers' source code. */
export function projectDeploymentProfiles(input: unknown, requested: string): DeploymentProfiles {
  const { name, profile } = selectProfile(input, requested);
  return { schemaVersion: 1, activeProfile: name, profiles: { [name]: profile } };
}

export const deploymentDefaults = resolveDeploymentDefaults();

/** Profile ports are independent; isolated frontend overrides keep the adjacent API convention. */
export function resolveDirectApiPort(frontendPort: number, defaults: Pick<DeploymentProfile, 'webPort' | 'apiPort'>) {
  return frontendPort === defaults.webPort ? defaults.apiPort : frontendPort + 1;
}
