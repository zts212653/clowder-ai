import profiles from './deployment-profiles.json' with { type: 'json' };

export interface DeploymentBrand {
  name: string;
  displayName: string;
  shortName: string;
  hubName: string;
  tagline: string;
}

export interface DeploymentProfile {
  apiPort: number;
  webPort: number;
  envRegistryFrontendPort: number;
  corsOrigins: string[];
  roadmapPath: string;
  brand: DeploymentBrand;
  repositoryFullName: string;
}

interface DeploymentProfiles {
  schemaVersion: 1;
  activeProfile: string;
  profiles: Record<string, DeploymentProfile>;
  startupProfiles: Record<string, unknown>;
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

function repository(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error('Invalid deployment configuration: repositoryFullName must be owner/repo');
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

function brand(value: unknown): DeploymentBrand {
  const input = record(value, 'brand');
  const text = (key: keyof DeploymentBrand): string => {
    const item = input[key];
    if (
      typeof item !== 'string' ||
      !item.trim() ||
      item.length > 512 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: configuration labels must stay single-line.
      /[\u0000-\u001f\u007f]/.test(item)
    )
      throw new Error(`Invalid deployment configuration: brand.${key} must be nonempty single-line text`);
    return item;
  };
  return {
    name: text('name'),
    displayName: text('displayName'),
    shortName: text('shortName'),
    hubName: text('hubName'),
    tagline: text('tagline'),
  };
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
      brand: brand(selected.brand),
      repositoryFullName: repository(selected.repositoryFullName),
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
    repositoryUrl: `https://github.com/${profile.repositoryFullName}`,
  };
}

/** Public build projection changes data, never the shared consumers' source code. */
export function projectDeploymentProfiles(input: unknown, requested: string): DeploymentProfiles {
  const { name, profile } = selectProfile(input, requested);
  const startupProfiles = record(record(input, 'file').startupProfiles, 'startupProfiles');
  for (const startup of ['dev', 'production', 'opensource', 'unprofiled']) {
    for (const platform of ['posix', 'win32'] as const) resolveStartupDefaults(startup, platform, input);
  }
  return {
    schemaVersion: 1,
    activeProfile: name,
    profiles: { [name]: profile },
    startupProfiles: structuredClone(startupProfiles),
  };
}

const STARTUP_KEYS = [
  'ANTHROPIC_PROXY_ENABLED',
  'ASR_ENABLED',
  'TTS_ENABLED',
  'LLM_POSTPROCESS_ENABLED',
  'AUDIO_SERVICE_ENABLED',
  'MESSAGE_TTL_SECONDS',
  'THREAD_TTL_SECONDS',
  'TASK_TTL_SECONDS',
  'SUMMARY_TTL_SECONDS',
  'REDIS_PROFILE',
] as const;
type StartupKey = (typeof STARTUP_KEYS)[number];

/** Startup defaults only; explicit env and lifecycle/isolation guards keep precedence. */
export function resolveStartupDefaults(
  name: string,
  platform: 'posix' | 'win32',
  input: unknown = profiles,
): Partial<Record<StartupKey, string>> {
  if (!['dev', 'production', 'opensource', 'unprofiled'].includes(name) || !['posix', 'win32'].includes(platform)) {
    throw new Error('Invalid startup profile or platform');
  }
  const file = record(input, 'file');
  if (file.schemaVersion !== 1) throw new Error('Unsupported deployment configuration schemaVersion');
  const available = record(file.startupProfiles, 'startupProfiles');
  const selected = record(available[name], `startup profile ${name}`);
  const common = record(selected.common, 'startup common defaults');
  const overrides = record(selected[platform], `startup ${platform} defaults`);
  const output: Partial<Record<StartupKey, string>> = {};
  for (const [key, value] of Object.entries({ ...common, ...overrides })) {
    if (!STARTUP_KEYS.includes(key as StartupKey) || typeof value !== 'string')
      throw new Error(`Invalid startup setting ${key}`);
    const valid = key.endsWith('_ENABLED')
      ? /^[01]$/.test(value)
      : key.endsWith('_TTL_SECONDS')
        ? /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
        : ['dev', 'opensource'].includes(value);
    if (!valid) throw new Error(`Invalid startup value ${key}`);
    output[key as StartupKey] = value;
  }
  for (const key of STARTUP_KEYS) {
    if (platform === 'win32' && (key === 'AUDIO_SERVICE_ENABLED' || name === 'unprofiled')) continue;
    if (!(key in output)) throw new Error(`Missing startup setting ${key}`);
  }
  return output;
}

export const deploymentDefaults = resolveDeploymentDefaults();

/** Profile ports are independent; isolated frontend overrides keep the adjacent API convention. */
export function resolveDirectApiPort(frontendPort: number, defaults: Pick<DeploymentProfile, 'webPort' | 'apiPort'>) {
  return frontendPort === defaults.webPort ? defaults.apiPort : frontendPort + 1;
}
