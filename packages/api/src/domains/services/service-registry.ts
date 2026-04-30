import type { ServiceManifest, ServiceState, ServiceStatus } from './service-manifest.js';

const KNOWN_SERVICES: ServiceManifest[] = [
  {
    id: 'whisper-stt',
    name: 'Whisper 语音转写',
    type: 'python',
    port: 9876,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/whisper-venv',
      packages: ['mlx-whisper', 'fastapi', 'uvicorn'],
    },
    scripts: {
      start: 'scripts/whisper-server.sh',
    },
    enablesFeatures: ['voice-input', 'connector-stt'],
    configVars: ['WHISPER_URL', 'NEXT_PUBLIC_WHISPER_URL'],
  },
  {
    id: 'mlx-tts',
    name: 'MLX-Audio 语音合成',
    type: 'python',
    port: 9879,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/tts-venv',
      packages: ['mlx-audio', 'fastapi', 'uvicorn'],
    },
    scripts: {
      start: 'scripts/tts-server.sh',
    },
    enablesFeatures: ['voice-output', 'voice-companion'],
    configVars: ['TTS_URL'],
  },
  {
    id: 'embedding-model',
    name: 'Embedding 语义搜索',
    type: 'python',
    port: 9880,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/embed-venv',
      packages: ['sentence-transformers', 'fastapi', 'uvicorn'],
    },
    scripts: {
      start: 'scripts/embed-server.sh',
    },
    enablesFeatures: ['memory-semantic-search'],
    configVars: ['EMBED_URL', 'EMBED_PORT'],
  },
  {
    id: 'llm-postprocess',
    name: 'LLM 转写纠正',
    type: 'python',
    port: 9878,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
    },
    scripts: {
      start: 'scripts/llm-postprocess-server.sh',
    },
    enablesFeatures: ['voice-postprocess'],
    configVars: ['NEXT_PUBLIC_LLM_POSTPROCESS_URL'],
  },
  {
    id: 'playwright',
    name: 'Playwright 浏览器自动化',
    type: 'node',
    prerequisites: {
      packages: ['playwright'],
    },
    scripts: {},
    enablesFeatures: ['browser-automation-mcp'],
    configVars: [],
  },
];

export function resolveHealthUrl(manifest: ServiceManifest): string | null {
  if (!manifest.port || !manifest.healthEndpoint) return null;
  for (const envVar of manifest.configVars) {
    const val = process.env[envVar];
    if (!val) continue;
    if (val.startsWith('http')) return `${val}${manifest.healthEndpoint}`;
    if (/^\d+$/.test(val)) return `http://127.0.0.1:${val}${manifest.healthEndpoint}`;
  }
  return `http://127.0.0.1:${manifest.port}${manifest.healthEndpoint}`;
}

async function probeHealth(
  manifest: ServiceManifest,
): Promise<{ status: ServiceStatus; detail?: Record<string, unknown>; error?: string }> {
  const url = resolveHealthUrl(manifest);
  if (!url) return { status: 'unknown' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
    const detail = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: 'running', detail };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'error', error: 'health probe timeout' };
    }
    const cause = err instanceof Error ? (err as Error & { cause?: { code?: string } }).cause : undefined;
    if (cause?.code === 'ECONNREFUSED') {
      return { status: 'stopped' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED')) {
      return { status: 'stopped' };
    }
    return { status: 'error', error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

export function getKnownServices(): ServiceManifest[] {
  return KNOWN_SERVICES;
}

export function getServiceById(id: string): ServiceManifest | undefined {
  return KNOWN_SERVICES.find((s) => s.id === id);
}

export async function getServiceState(manifest: ServiceManifest): Promise<ServiceState> {
  const probe = await probeHealth(manifest);
  return {
    manifest,
    status: probe.status,
    lastChecked: Date.now(),
    healthDetail: probe.detail,
    error: probe.error,
  };
}

export async function getAllServiceStates(): Promise<ServiceState[]> {
  return Promise.all(KNOWN_SERVICES.map(getServiceState));
}

const cachedStates = new Map<string, ServiceState>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthHeartbeat(intervalMs = 60_000): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(async () => {
    for (const manifest of KNOWN_SERVICES) {
      const state = await getServiceState(manifest);
      cachedStates.set(manifest.id, state);
    }
  }, intervalMs);
  if (typeof heartbeatInterval === 'object' && 'unref' in heartbeatInterval) {
    heartbeatInterval.unref();
  }
}

export function stopHealthHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getCachedServiceState(id: string): ServiceState | undefined {
  return cachedStates.get(id);
}
