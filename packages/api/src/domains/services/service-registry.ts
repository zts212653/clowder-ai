import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getServiceConfig, setServiceConfig } from './service-config.js';
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
      models: [
        {
          name: 'mlx-community/whisper-large-v3-turbo',
          size: '~1.5GB',
          autoDownload: true,
          isDefault: true,
          description: '速度快、质量高（推荐）',
        },
        {
          name: 'mlx-community/whisper-large-v3-mlx',
          size: '~3GB',
          autoDownload: true,
          description: '最高质量，速度较慢',
        },
        {
          name: 'mlx-community/whisper-small-mlx',
          size: '~500MB',
          autoDownload: true,
          description: '轻量版，适合低配机器',
        },
      ],
      estimatedMinutes: 5,
    },
    scripts: {
      install: 'scripts/services/whisper-install.sh',
      start: 'scripts/services/whisper-server.sh',
      uninstall: 'scripts/services/whisper-uninstall.sh',
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
      models: [
        {
          name: 'mlx-community/Kokoro-82M-bf16',
          size: '~160MB',
          autoDownload: true,
          isDefault: true,
          description: '轻量高质量语音合成',
        },
      ],
      estimatedMinutes: 3,
    },
    scripts: {
      install: 'scripts/services/tts-install.sh',
      start: 'scripts/services/tts-server.sh',
      uninstall: 'scripts/services/tts-uninstall.sh',
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
      models: [
        {
          name: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
          size: '~400MB',
          autoDownload: true,
          isDefault: true,
          description: '轻量语义向量模型',
        },
      ],
      estimatedMinutes: 3,
    },
    scripts: {
      install: 'scripts/services/embed-install.sh',
      start: 'scripts/services/embed-server.sh',
      uninstall: 'scripts/services/embed-uninstall.sh',
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
      venvPath: '~/.cat-cafe/llm-venv',
      packages: ['mlx-vlm', 'fastapi', 'uvicorn', 'pydantic'],
      models: [
        {
          name: 'mlx-community/Qwen3.5-35B-A3B-4bit',
          size: '~20GB',
          autoDownload: true,
          isDefault: true,
          description: '高质量纠错，需大内存(48GB+)',
        },
        {
          name: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
          size: '~4GB',
          autoDownload: true,
          description: '轻量版，16GB内存可用',
        },
        {
          name: 'mlx-community/Qwen2.5-14B-Instruct-4bit',
          size: '~8GB',
          autoDownload: true,
          description: '中等质量，32GB内存推荐',
        },
      ],
      estimatedMinutes: 30,
    },
    scripts: {
      install: 'scripts/services/llm-postprocess-install.sh',
      start: 'scripts/services/llm-postprocess-server.sh',
      uninstall: 'scripts/services/llm-postprocess-uninstall.sh',
    },
    enablesFeatures: ['voice-postprocess'],
    configVars: ['NEXT_PUBLIC_LLM_POSTPROCESS_URL'],
  },
];

export function resolveServicePort(manifest: ServiceManifest): number | null {
  const cfg = getServiceConfig(manifest.id);
  if (cfg.port) return cfg.port;
  if (manifest.port) return manifest.port;
  return null;
}

export function resolveServiceEndpoint(idOrManifest: string | ServiceManifest): string | null {
  const manifest = typeof idOrManifest === 'string' ? KNOWN_SERVICES.find((s) => s.id === idOrManifest) : idOrManifest;
  if (!manifest) return null;

  for (const envVar of manifest.configVars) {
    const val = process.env[envVar];
    if (val?.startsWith('http')) return val;
    const parsed = val ? Number.parseInt(val, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return `http://127.0.0.1:${parsed}`;
  }

  const port = resolveServicePort(manifest);
  if (port) return `http://127.0.0.1:${port}`;

  return null;
}

export function resolveHealthUrl(manifest: ServiceManifest): string | null {
  if (!manifest.healthEndpoint) return null;
  const endpoint = resolveServiceEndpoint(manifest);
  if (!endpoint) return null;
  return `${endpoint}${manifest.healthEndpoint}`;
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
    if (detail.status === 'loading') return { status: 'starting', detail };
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

function resolveVenvPath(venvPath: string): string {
  if (venvPath.startsWith('~/')) return resolve(homedir(), venvPath.slice(2));
  return resolve(venvPath);
}

export function checkInstalled(manifest: ServiceManifest): boolean {
  const venv = manifest.prerequisites?.venvPath;
  if (!venv) return true;
  return existsSync(resolveVenvPath(venv));
}

function isScriptRunning(scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `wmic process where "CommandLine like '%${scriptPath.replace(/'/g, "\\'")}%'" get ProcessId /FORMAT:LIST`,
        { encoding: 'utf-8', timeout: 3000 },
      );
      return /ProcessId=\d+/.test(out);
    } catch {
      return false;
    }
  }
  try {
    const out = execSync(`pgrep -f "${scriptPath}"`, { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function detectProcessStatus(manifest: ServiceManifest): ServiceStatus | null {
  if (isScriptRunning(manifest.scripts.install)) return 'installing';
  if (isScriptRunning(manifest.scripts.start)) return 'starting';
  return null;
}

export function getKnownServices(): ServiceManifest[] {
  return KNOWN_SERVICES;
}

export function getServiceById(id: string): ServiceManifest | undefined {
  return KNOWN_SERVICES.find((s) => s.id === id);
}

export async function getServiceState(manifest: ServiceManifest): Promise<ServiceState> {
  const probe = await probeHealth(manifest);
  let { status } = probe;
  if (status === 'stopped' || status === 'unknown') {
    const processStatus = detectProcessStatus(manifest);
    if (processStatus) status = processStatus;
  }
  const config = getServiceConfig(manifest.id);
  return {
    manifest,
    status,
    installed: checkInstalled(manifest),
    enabled: config.enabled,
    selectedModel: config.selectedModel,
    lastChecked: Date.now(),
    healthDetail: probe.detail,
    error: probe.error,
  };
}

export async function getAllServiceStates(): Promise<ServiceState[]> {
  return Promise.all(KNOWN_SERVICES.map(getServiceState));
}
