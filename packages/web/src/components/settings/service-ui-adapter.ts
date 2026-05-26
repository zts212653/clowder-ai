type HomeServiceStatus =
  | 'healthy'
  | 'unhealthy'
  | 'not_configured'
  | 'installing'
  | 'starting'
  | 'stopping'
  | 'uninstalling';

interface ModelOption {
  name: string;
  size: string;
  autoDownload: boolean;
  isDefault?: boolean;
  description?: string;
}

export interface ServicePrerequisites {
  runtime?: string;
  packages?: string[];
  models?: ModelOption[];
  estimatedMinutes?: number;
}

export interface HomeServiceState {
  id: string;
  name: string;
  description: string;
  category: 'voice' | 'memory' | 'audio';
  endpoint: string | null;
  configured: boolean;
  status: HomeServiceStatus;
  features: string[];
  installed: boolean;
  enabled: boolean;
  selectedModel?: string;
  port?: number;
  installable: boolean;
  prerequisites?: ServicePrerequisites;
  error?: string | null;
}

export type ServiceUiStatus =
  | 'running'
  | 'stopped'
  | 'not_configured'
  | 'error'
  | 'installing'
  | 'starting'
  | 'stopping'
  | 'uninstalling';

export interface ServiceUiState {
  id: string;
  name: string;
  description: string;
  category: 'voice' | 'memory' | 'audio';
  endpoint: string | null;
  features: string[];
  status: ServiceUiStatus;
  statusLabel: string;
  installed: boolean;
  enabled: boolean;
  selectedModel?: string;
  port?: number;
  installable: boolean;
  running: boolean;
  prerequisites?: ServicePrerequisites;
  error?: string | null;
}

const STATUS_LABELS: Record<ServiceUiStatus, string> = {
  running: '运行中',
  stopped: '未启动',
  not_configured: '未配置',
  error: '异常',
  installing: '安装中',
  starting: '启动中',
  stopping: '停止中',
  uninstalling: '卸载中',
};

const DISPLAY_NAMES: Record<string, string> = {
  'whisper-stt': '语音识别 (Whisper)',
  'mlx-tts': '语音合成 (MLX)',
  'llm-postprocess': 'LLM 后处理',
  'embedding-model': '嵌入模型',
  'audio-capture': '音频采集',
};

export function adaptServiceState(home: HomeServiceState): ServiceUiState {
  const installed = home.installed;
  const enabled = home.enabled;
  const running = home.status === 'healthy';

  let status: ServiceUiStatus;
  if (
    home.status === 'installing' ||
    home.status === 'starting' ||
    home.status === 'stopping' ||
    home.status === 'uninstalling'
  ) {
    status = home.status;
  } else if (!installed) {
    status = 'not_configured';
  } else if (!home.installable) {
    status = running ? 'running' : home.configured ? 'error' : 'not_configured';
  } else if (enabled && running) {
    status = 'running';
  } else if (enabled) {
    status = 'error';
  } else {
    status = 'stopped';
  }

  return {
    id: home.id,
    name: DISPLAY_NAMES[home.id] ?? home.name,
    description: home.description,
    category: home.category,
    endpoint: home.endpoint,
    features: home.features,
    status,
    statusLabel: STATUS_LABELS[status],
    installed,
    enabled,
    selectedModel: home.selectedModel,
    port: home.port,
    installable: home.installable,
    running,
    prerequisites: home.prerequisites,
    error: (installed && enabled) || !home.installable ? home.error : undefined,
  };
}

export type PluginUiStatus = 'active' | 'configured' | 'available';

export interface PluginUiItem {
  id: string;
  name: string;
  description: string;
  source: 'platform' | 'service';
  status: PluginUiStatus;
  statusLabel: string;
  features: string[];
  error?: string | null;
}

export function adaptServiceToPlugin(ui: ServiceUiState): PluginUiItem {
  let pluginStatus: PluginUiStatus;
  if (ui.running) {
    pluginStatus = 'active';
  } else if (ui.installed) {
    pluginStatus = 'configured';
  } else {
    pluginStatus = 'available';
  }

  const statusLabels: Record<PluginUiStatus, string> = {
    active: '运行中',
    configured: '已安装',
    available: '可安装',
  };

  return {
    id: ui.id,
    name: ui.name,
    description: ui.description,
    source: 'service',
    status: pluginStatus,
    statusLabel: statusLabels[pluginStatus],
    features: ui.features,
    error: ui.error,
  };
}
