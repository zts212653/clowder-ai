import { maskUrlCredentials } from '../../config/env-registry.js';
import { normalizeLoopbackUrl } from './loopback-url.js';
import { getServiceConfig } from './service-config.js';

export type ServiceLifecycleStateAction = 'install' | 'start' | 'stop' | 'uninstall' | 'toggle';
export type ServiceStatus =
  | 'healthy'
  | 'unhealthy'
  | 'not_configured'
  | 'installing'
  | 'starting'
  | 'stopping'
  | 'uninstalling';

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
  installed?: boolean;
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
  installed: boolean;
  enabled: boolean;
  selectedModel?: string;
  // Persisted port (from services.json); the reconfigure modal needs this
  // to pre-fill the port input. endpoint already encodes the port in its
  // URL, but parsing strings client-side just to recover an int we already
  // have is fragile under masked endpoints and portFallback hosts.
  port?: number;
  installable: boolean;
  prerequisites?: Omit<NonNullable<ServiceManifest['prerequisites']>, 'venvPath'>;
}

export const MODEL_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_MODEL',
  'qwen3-asr': 'QWEN3_ASR_MODEL',
  'mlx-tts': 'TTS_MODEL',
  'embedding-model': 'EMBED_MODEL',
  'llm-postprocess': 'LLM_POSTPROCESS_MODEL',
};

/** Env var each server script reads to bind its listening port. */
export const PORT_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_PORT',
  'qwen3-asr': 'WHISPER_PORT',
  'mlx-tts': 'TTS_PORT',
  'embedding-model': 'EMBED_PORT',
  'llm-postprocess': 'LLM_POSTPROCESS_PORT',
  'audio-capture': 'AUDIO_SERVICE_PORT',
};

export const LEGACY_SERVICE_ENABLED_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'ASR_ENABLED',
  'qwen3-asr': 'QWEN3_ASR_ENABLED',
  'mlx-tts': 'TTS_ENABLED',
  'embedding-model': 'EMBED_ENABLED',
  'llm-postprocess': 'LLM_POSTPROCESS_ENABLED',
  'audio-capture': 'AUDIO_SERVICE_ENABLED',
};

export const API_SERVICE_ENABLED_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'CAT_CAFE_SERVICE_ASR_ENABLED',
  'qwen3-asr': 'CAT_CAFE_SERVICE_QWEN3_ASR_ENABLED',
  'mlx-tts': 'CAT_CAFE_SERVICE_TTS_ENABLED',
  'embedding-model': 'CAT_CAFE_SERVICE_EMBED_ENABLED',
  'llm-postprocess': 'CAT_CAFE_SERVICE_LLM_POSTPROCESS_ENABLED',
  'audio-capture': 'CAT_CAFE_SERVICE_AUDIO_ENABLED',
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
    id: 'qwen3-asr',
    name: 'Qwen3 ASR',
    description: 'Local speech-to-text endpoint (Qwen3-ASR, drop-in whisper replacement)',
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
      venvPath: '~/.cat-cafe/asr-venv',
      packages: ['mlx-audio', 'fastapi', 'uvicorn', 'python-multipart'],
      models: [
        serviceModel('mlx-community/Qwen3-ASR-1.7B-8bit', '~2.5GB', 'High-quality Qwen3 ASR (default)', true),
        serviceModel('mlx-community/Qwen3-ASR-1.7B-4bit', '~1.5GB', 'Smaller quantization, lower memory'),
      ],
      estimatedMinutes: 5,
    },
    scripts: {
      install: 'scripts/services/qwen3-asr-install.sh',
      start: 'scripts/services/qwen3-asr-server.sh',
      uninstall: 'scripts/services/qwen3-asr-uninstall.sh',
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
    type: 'python',
    port: 9881,
    features: ['meeting-copilot', 'live-transcript'],
    envVars: ['AUDIO_SERVICE_URL'],
    endpointEnvVars: ['AUDIO_SERVICE_URL'],
    defaultEndpoint: 'http://127.0.0.1:9881',
    healthPath: '/status',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/audio-capture-venv',
      packages: ['sounddevice', 'fastapi', 'uvicorn', 'numpy'],
      // No models — audio-capture has no ML inference. Modal still shows
      // install button (allModels.length === 0 short-circuits canConfirm).
      models: [],
      estimatedMinutes: 2,
    },
    scripts: {
      install: 'scripts/services/audio-capture-install.sh',
      start: 'scripts/services/audio-capture-server.sh',
      uninstall: 'scripts/services/audio-capture-uninstall.sh',
    },
  },
];

export type FetchServiceHealth = (url: string, service: ServiceManifest) => Promise<ServiceHealthResult>;

export function getServiceManifest(id: string): ServiceManifest | null {
  for (const service of SERVICE_MANIFESTS) {
    if (service.id === id) return service;
  }
  return null;
}

export function parseServicePort(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const port = Number.parseInt(value, 10);
  return port > 0 && port <= 65535 ? port : null;
}

function parseEnabledEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  return null;
}

export function deriveLegacyServiceConfig(
  service: ServiceManifest,
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig | undefined {
  const apiKey = API_SERVICE_ENABLED_ENV_VARS[service.id];
  const legacyKey = LEGACY_SERVICE_ENABLED_ENV_VARS[service.id];
  const apiEnabled = parseEnabledEnv(apiKey ? env[apiKey] : undefined);
  // start-dev/start-windows set CAT_CAFE_SERVICE_* only for explicit .env
  // legacy flags. When a profile is active, ignore raw *_ENABLED values so
  // profile defaults do not unexpectedly auto-start ML sidecars.
  const legacyEnabled =
    apiEnabled ?? (env.CAT_CAFE_PROFILE ? null : parseEnabledEnv(legacyKey ? env[legacyKey] : undefined));
  if (legacyEnabled !== true) return undefined;

  const config: ServiceConfig = { installed: true, enabled: true };
  const modelKey = MODEL_ENV_VARS[service.id];
  const model = modelKey ? env[modelKey]?.trim() : undefined;
  if (model) {
    config.selectedModel = model;
  } else {
    // Fall back to manifest's recommended default model so that legacy
    // env bridge users (ENABLED=1 without MODEL) get a working service
    // instead of a "MODEL required" startup failure.  The manifest's
    // isDefault model is the single source of truth for defaults (see
    // b29c04d05 — hardcoded script defaults were removed intentionally).
    const defaultModel = service.prerequisites?.models?.find((m) => m.isDefault) ?? service.prerequisites?.models?.[0];
    if (defaultModel) config.selectedModel = defaultModel.name;
  }
  const portKey = PORT_ENV_VARS[service.id];
  const port = parseServicePort(portKey ? env[portKey]?.trim() : undefined);
  if (port) config.port = port;
  return config;
}

export function resolveEffectiveServiceConfig(
  service: ServiceManifest,
  config: ServiceConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig | undefined {
  return config ?? deriveLegacyServiceConfig(service, env);
}

function replaceEndpointPort(endpoint: string | null, port: number): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    const hadTrailingSlash = endpoint.endsWith('/');
    url.port = String(port);
    const serialized = url.toString();
    return !hadTrailingSlash && url.pathname === '/' ? serialized.replace(/\/$/, '') : serialized;
  } catch {
    return endpoint.replace(/:\d+($|[/?#])/, `:${port}$1`);
  }
}

export function resolveServiceEndpoint(
  service: ServiceManifest,
  env: NodeJS.ProcessEnv = process.env,
  config: ServiceConfig | undefined = getServiceConfig(service.id),
): string | null {
  for (const key of service.endpointEnvVars) {
    const value = env[key]?.trim();
    if (value) return normalizeLoopbackUrl(value);
  }
  // Persisted user-chosen port (from install modal) takes precedence over
  // static env port overrides, while explicit URL envs above remain highest
  // priority. This must apply to every scripted service, not just embedding,
  // otherwise start/stop use cfg.port but /api/services health probes the
  // manifest default and reports a healthy custom-port sidecar as broken.
  const configuredPort =
    typeof config?.port === 'number' && config.port > 0 && config.port <= 65535 ? config.port : null;
  const portEnvKey = PORT_ENV_VARS[service.id];
  const envPort = parseServicePort(portEnvKey ? env[portEnvKey]?.trim() : undefined);
  const effectivePort = configuredPort ?? envPort;
  if (effectivePort) {
    if (service.portFallback) {
      return `${service.portFallback.host.replace(/\/+$/, '')}:${effectivePort}`;
    }
    const endpoint = replaceEndpointPort(service.defaultEndpoint, effectivePort);
    return endpoint ? normalizeLoopbackUrl(endpoint) : null;
  }
  return service.defaultEndpoint ? normalizeLoopbackUrl(service.defaultEndpoint) : null;
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

// Endpoint map returned by `/api/services/endpoints`. By default the
// returned URLs are credential-masked so they are safe for display surfaces
// (status panels, audit logs). Callers that need to actually issue a request
// against the endpoint must pass `{ mask: false }` so URL auth (e.g.
// `https://user:pass@host`) survives intact — otherwise the masked
// `***@host` value will be sent to the wire and the request will fail even
// though the configured upstream is healthy (codex P2 2026-05-26).
export function resolveServiceEndpointMap(
  env: NodeJS.ProcessEnv = process.env,
  getConfig: (id: string) => ServiceConfig | undefined = getServiceConfig,
  options: { mask?: boolean } = {},
): Record<string, string | null> {
  const mask = options.mask !== false;
  return Object.fromEntries(
    SERVICE_MANIFESTS.map((service) => {
      const endpoint = resolveServiceEndpoint(service, env, getConfig(service.id));
      return [service.id, mask ? maskServiceEndpoint(endpoint) : endpoint];
    }),
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
    config?: ServiceConfig;
    lifecycleAction?: ServiceLifecycleStateAction | null;
  } = {},
): Promise<ServiceState> {
  const configExists = options.config !== undefined;
  const config = options.config ?? { enabled: false };
  const installable = !!service.scripts?.install;
  const installed =
    config.installed ??
    (installable
      ? configExists && (config.enabled || (config.selectedModel === undefined && config.port === undefined))
      : true);
  const enabled = config.enabled;
  const endpoint = resolveServiceEndpoint(service, options.env, options.config);
  const selectedModel =
    typeof config.selectedModel === 'string' && config.selectedModel.trim().length > 0
      ? config.selectedModel
      : undefined;
  const persistedPort =
    typeof config.port === 'number' && config.port > 0 && config.port <= 65535 ? config.port : undefined;
  const clientPrerequisites = service.prerequisites
    ? { prerequisites: (({ venvPath: _, ...r }) => r)(service.prerequisites) }
    : {};
  const lifecycleStatus: Partial<Record<ServiceLifecycleStateAction, ServiceStatus>> = {
    install: 'installing',
    start: 'starting',
    stop: 'stopping',
    uninstall: 'uninstalling',
  };
  const activeLifecycleStatus = options.lifecycleAction ? lifecycleStatus[options.lifecycleAction] : undefined;
  if (activeLifecycleStatus) {
    return {
      ...buildClientServiceManifest(service),
      endpoint: endpoint ? maskServiceEndpoint(endpoint) : null,
      configured: !!endpoint,
      status: activeLifecycleStatus,
      httpStatus: null,
      error: null,
      installed:
        options.lifecycleAction === 'start'
          ? true
          : options.lifecycleAction === 'install'
            ? Boolean(config.installed)
            : installed,
      enabled:
        options.lifecycleAction === 'start'
          ? true
          : options.lifecycleAction === 'stop' || options.lifecycleAction === 'uninstall'
            ? false
            : enabled,
      ...(selectedModel ? { selectedModel } : {}),
      ...(persistedPort ? { port: persistedPort } : {}),
      installable,
      ...clientPrerequisites,
    };
  }
  if (!endpoint) {
    return {
      ...buildClientServiceManifest(service),
      endpoint: null,
      configured: false,
      status: 'not_configured',
      httpStatus: null,
      error: null,
      installed,
      enabled,
      ...(selectedModel ? { selectedModel } : {}),
      ...(persistedPort ? { port: persistedPort } : {}),
      installable,
      ...clientPrerequisites,
    };
  }

  if (installable && !(installed && enabled)) {
    return {
      ...buildClientServiceManifest(service),
      endpoint: maskServiceEndpoint(endpoint),
      configured: true,
      status: 'not_configured',
      httpStatus: null,
      error: null,
      installed,
      enabled,
      ...(selectedModel ? { selectedModel } : {}),
      ...(persistedPort ? { port: persistedPort } : {}),
      installable,
      ...clientPrerequisites,
    };
  }

  const healthProbe = options.fetchHealth ?? fetchServiceHealth;
  const health = await healthProbe(resolveServiceHealthUrl(service, endpoint), service);
  const status: ServiceStatus = health.ok ? 'healthy' : 'unhealthy';
  return {
    ...buildClientServiceManifest(service),
    endpoint: maskServiceEndpoint(endpoint),
    configured: true,
    status,
    httpStatus: typeof health.status === 'number' ? health.status : null,
    error: typeof health.error === 'string' ? health.error : null,
    installed,
    enabled,
    ...(selectedModel ? { selectedModel } : {}),
    ...(persistedPort ? { port: persistedPort } : {}),
    installable,
    ...clientPrerequisites,
  };
}

export async function resolveServiceStates(options: {
  env?: NodeJS.ProcessEnv;
  fetchHealth?: FetchServiceHealth;
  getConfig?: (id: string) => ServiceConfig | undefined;
  getLifecycleAction?: (id: string) => ServiceLifecycleStateAction | null;
}): Promise<ServiceState[]> {
  const getConfig = options.getConfig;
  return Promise.all(
    SERVICE_MANIFESTS.map((service) =>
      resolveServiceState(service, {
        env: options.env,
        fetchHealth: options.fetchHealth,
        config: getConfig?.(service.id),
        lifecycleAction: options.getLifecycleAction?.(service.id),
      }),
    ),
  );
}
