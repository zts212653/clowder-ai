import { maskUrlCredentials } from '../../config/env-registry.js';

export type ServiceStatus = 'healthy' | 'unhealthy' | 'not_configured';

export interface ServiceManifest {
  id: string;
  name: string;
  description: string;
  category: 'voice' | 'memory' | 'audio';
  type?: 'python' | 'node' | 'binary';
  port?: number;
  features: string[];
  envVars: string[];
  endpointEnvVars: string[];
  portFallback?: {
    envVar: string;
    host: string;
  };
  defaultEndpoint: string | null;
  healthPath: '/health' | '/status';
  prerequisites?: {
    runtime?: string;
    venvPath?: string;
    packages?: string[];
    models?: {
      name: string;
      size: string;
      autoDownload: boolean;
      isDefault?: boolean;
      description?: string;
    }[];
    estimatedMinutes?: number;
  };
  scripts?: {
    install?: string;
    start?: string;
    uninstall?: string;
  };
}

export interface ServiceHealthResult {
  ok: boolean;
  status?: number;
  error?: string | null;
}

export interface ServiceConfig {
  enabled: boolean;
  selectedModel?: string;
  port?: number;
}

export interface ServiceState {
  id: string;
  name: string;
  description: string;
  category: 'voice' | 'memory' | 'audio';
  features: string[];
  envVars: string[];
  endpointEnvVars: string[];
  portFallback?: {
    envVar: string;
    host: string;
  };
  defaultEndpoint: string | null;
  healthPath: '/health' | '/status';
  endpoint: string | null;
  configured: boolean;
  status: ServiceStatus;
  httpStatus: number | null;
  error: string | null;
  availableActions: ('install' | 'start' | 'stop' | 'uninstall')[];
  prerequisites?: Omit<NonNullable<ServiceManifest['prerequisites']>, 'venvPath'>;
}

export const MODEL_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_MODEL',
  'mlx-tts': 'TTS_MODEL',
  'embedding-model': 'EMBED_MODEL',
  'llm-postprocess': 'LLM_POSTPROCESS_MODEL',
};

type ServiceModel = NonNullable<NonNullable<ServiceManifest['prerequisites']>['models']>[number];

function serviceModel(name: string, size: string, description: string, isDefault = false): ServiceModel {
  const model: ServiceModel = { name, size, autoDownload: true, description };
  if (isDefault) model.isDefault = true;
  return model;
}

export const SERVICE_MANIFESTS: readonly ServiceManifest[] = [
  {
    id: 'whisper-stt',
    name: 'Whisper STT',
    description: 'Local speech-to-text endpoint',
    category: 'voice',
    type: 'python',
    port: 9876,
    features: ['voice-input', 'connector-stt'],
    envVars: ['WHISPER_URL', 'NEXT_PUBLIC_WHISPER_URL'],
    endpointEnvVars: ['WHISPER_URL', 'NEXT_PUBLIC_WHISPER_URL'],
    defaultEndpoint: 'http://localhost:9876',
    healthPath: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/whisper-venv',
      packages: ['mlx-whisper', 'fastapi', 'uvicorn'],
      models: [
        serviceModel('mlx-community/whisper-large-v3-turbo', '~1.5GB', 'Fast, high-quality local transcription', true),
        serviceModel('mlx-community/whisper-large-v3-mlx', '~3GB', 'Highest quality, slower startup'),
        serviceModel('mlx-community/whisper-small-mlx', '~500MB', 'Smaller local model for lower-memory machines'),
      ],
      estimatedMinutes: 5,
    },
    scripts: {
      install: 'scripts/services/whisper-install.sh',
      start: 'scripts/services/whisper-server.sh',
      uninstall: 'scripts/services/whisper-uninstall.sh',
    },
  },
  {
    id: 'mlx-tts',
    name: 'MLX TTS',
    description: 'Local text-to-speech endpoint',
    category: 'voice',
    type: 'python',
    port: 9879,
    features: ['voice-output', 'voice-companion'],
    envVars: ['TTS_URL'],
    endpointEnvVars: ['TTS_URL'],
    defaultEndpoint: 'http://localhost:9879',
    healthPath: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/tts-venv',
      packages: ['mlx-audio', 'fastapi', 'uvicorn'],
      models: [serviceModel('mlx-community/Kokoro-82M-bf16', '~160MB', 'Lightweight local speech synthesis', true)],
      estimatedMinutes: 3,
    },
    scripts: {
      install: 'scripts/services/tts-install.sh',
      start: 'scripts/services/tts-server.sh',
      uninstall: 'scripts/services/tts-uninstall.sh',
    },
  },
  {
    id: 'embedding-model',
    name: 'Embedding Model',
    description: 'Semantic memory embedding endpoint',
    category: 'memory',
    type: 'python',
    port: 9880,
    features: ['memory-semantic-search'],
    envVars: ['EMBED_URL', 'EMBED_PORT'],
    endpointEnvVars: ['EMBED_URL'],
    portFallback: { envVar: 'EMBED_PORT', host: 'http://127.0.0.1' },
    defaultEndpoint: 'http://127.0.0.1:9880',
    healthPath: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/embed-venv',
      packages: ['sentence-transformers', 'fastapi', 'uvicorn'],
      models: [
        serviceModel(
          'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
          '~400MB',
          'Lightweight semantic embedding model',
          true,
        ),
      ],
      estimatedMinutes: 3,
    },
    scripts: {
      install: 'scripts/services/embed-install.sh',
      start: 'scripts/services/embed-server.sh',
      uninstall: 'scripts/services/embed-uninstall.sh',
    },
  },
  {
    id: 'llm-postprocess',
    name: 'LLM Postprocess',
    description: 'Voice post-processing endpoint',
    category: 'voice',
    type: 'python',
    port: 9878,
    features: ['voice-postprocess'],
    envVars: ['NEXT_PUBLIC_LLM_POSTPROCESS_URL'],
    endpointEnvVars: ['NEXT_PUBLIC_LLM_POSTPROCESS_URL'],
    defaultEndpoint: 'http://localhost:9878',
    healthPath: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/llm-venv',
      packages: ['mlx-vlm', 'fastapi', 'uvicorn', 'pydantic'],
      models: [
        serviceModel(
          'mlx-community/Qwen3.5-35B-A3B-4bit',
          '~20GB',
          'High-quality correction, large-memory machines recommended',
          true,
        ),
        serviceModel('mlx-community/Qwen2.5-7B-Instruct-4bit', '~4GB', 'Lightweight correction model'),
        serviceModel('mlx-community/Qwen2.5-14B-Instruct-4bit', '~8GB', 'Balanced correction model'),
      ],
      estimatedMinutes: 30,
    },
    scripts: {
      install: 'scripts/services/llm-postprocess-install.sh',
      start: 'scripts/services/llm-postprocess-server.sh',
      uninstall: 'scripts/services/llm-postprocess-uninstall.sh',
    },
  },
  {
    id: 'audio-capture',
    name: 'Audio Capture',
    description: 'Meeting audio capture and transcript endpoint',
    category: 'audio',
    type: 'node',
    port: 9881,
    features: ['meeting-copilot', 'live-transcript'],
    envVars: ['AUDIO_SERVICE_URL'],
    endpointEnvVars: ['AUDIO_SERVICE_URL'],
    defaultEndpoint: 'http://127.0.0.1:9881',
    healthPath: '/status',
  },
];

export type FetchServiceHealth = (url: string, service: ServiceManifest) => Promise<ServiceHealthResult>;

export function getServiceManifest(id: string): ServiceManifest | null {
  for (const service of SERVICE_MANIFESTS) {
    if (service.id === id) return service;
  }
  return null;
}

export function resolveServiceEndpoint(service: ServiceManifest, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of service.endpointEnvVars) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  if (service.portFallback) {
    const port = env[service.portFallback.envVar]?.trim();
    if (port) return `${service.portFallback.host.replace(/\/+$/, '')}:${port}`;
  }
  return service.defaultEndpoint;
}

function buildClientServiceManifest(service: ServiceManifest) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category,
    features: service.features,
    envVars: service.envVars,
    endpointEnvVars: service.endpointEnvVars,
    portFallback: service.portFallback,
    defaultEndpoint: service.defaultEndpoint,
    healthPath: service.healthPath,
  };
}

export function maskServiceEndpoint(endpoint: string | null): string | null {
  return endpoint ? maskUrlCredentials(endpoint) : null;
}

export function resolveServiceHealthUrl(service: ServiceManifest, endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath.endsWith(service.healthPath) ? basePath : `${basePath}${service.healthPath}`;
    url.hash = '';
    return url.toString();
  } catch {
    const baseEndpoint = endpoint.replace(/\/+$/, '');
    return baseEndpoint.endsWith(service.healthPath) ? baseEndpoint : `${baseEndpoint}${service.healthPath}`;
  }
}

export function resolveServiceEndpointMap(env: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  return Object.fromEntries(
    SERVICE_MANIFESTS.map((service) => [service.id, maskServiceEndpoint(resolveServiceEndpoint(service, env))]),
  );
}

export async function fetchServiceHealth(url: string): Promise<ServiceHealthResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Service health check failed',
    };
  }
}

export async function resolveServiceState(
  service: ServiceManifest,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchHealth?: FetchServiceHealth;
  } = {},
): Promise<ServiceState> {
  const hasScripts = !!service.scripts;
  const endpoint = resolveServiceEndpoint(service, options.env);
  if (!endpoint) {
    return {
      ...buildClientServiceManifest(service),
      endpoint: null,
      configured: false,
      status: 'not_configured',
      httpStatus: null,
      error: null,
      availableActions: hasScripts ? ['install'] : [],
      ...(service.prerequisites ? { prerequisites: (({ venvPath: _, ...r }) => r)(service.prerequisites) } : {}),
    };
  }

  const healthProbe = options.fetchHealth ?? fetchServiceHealth;
  const health = await healthProbe(resolveServiceHealthUrl(service, endpoint), service);
  const status: ServiceStatus = health.ok ? 'healthy' : 'unhealthy';
  const actions: ServiceState['availableActions'] = hasScripts
    ? status === 'healthy'
      ? ['stop', 'uninstall']
      : ['install', 'start', 'uninstall']
    : [];
  return {
    ...buildClientServiceManifest(service),
    endpoint: maskServiceEndpoint(endpoint),
    configured: true,
    status,
    httpStatus: typeof health.status === 'number' ? health.status : null,
    error: typeof health.error === 'string' ? health.error : null,
    availableActions: actions,
    ...(service.prerequisites ? { prerequisites: (({ venvPath: _, ...r }) => r)(service.prerequisites) } : {}),
  };
}

export async function resolveServiceStates(options: {
  env?: NodeJS.ProcessEnv;
  fetchHealth?: FetchServiceHealth;
}): Promise<ServiceState[]> {
  return Promise.all(SERVICE_MANIFESTS.map((service) => resolveServiceState(service, options)));
}
