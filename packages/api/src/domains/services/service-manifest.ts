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
    models?: { name: string; size: string; autoDownload: boolean }[];
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

export type ServiceStatus = 'running' | 'stopped' | 'unknown' | 'error';

export interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
}
