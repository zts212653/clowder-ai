export interface ServiceManifest {
  id: string;
  name: string;
  type: 'python' | 'node' | 'binary';
  port?: number;
  healthEndpoint?: string;

  prerequisites: {
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

  scripts: {
    install?: string;
    start?: string;
    stop?: string;
    uninstall?: string;
  };

  enablesFeatures: string[];
  configVars: string[];
}

export type ServiceStatus = 'running' | 'starting' | 'installing' | 'stopped' | 'unknown' | 'error';

export interface ServiceConfig {
  enabled: boolean;
  selectedModel?: string;
  port?: number;
}

export const MODEL_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_MODEL',
  'mlx-tts': 'TTS_MODEL',
  'embedding-model': 'EMBED_MODEL',
  'llm-postprocess': 'LLM_POSTPROCESS_MODEL',
};

export interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  installed: boolean;
  enabled: boolean;
  selectedModel?: string;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
}
