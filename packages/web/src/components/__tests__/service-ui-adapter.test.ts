import { describe, expect, it } from 'vitest';
import {
  adaptServiceState,
  adaptServiceToPlugin,
  type HomeServiceState,
  type ServiceUiState,
} from '../settings/service-ui-adapter';

function makeHome(overrides: Partial<HomeServiceState> = {}): HomeServiceState {
  return {
    id: 'whisper-stt',
    name: 'Whisper STT',
    description: 'Speech to text',
    category: 'voice',
    endpoint: 'http://localhost:9876',
    configured: true,
    status: 'healthy',
    features: ['voice-input'],
    availableActions: [],
    ...overrides,
  };
}

describe('adaptServiceState', () => {
  it('maps healthy to running', () => {
    const result = adaptServiceState(makeHome({ status: 'healthy' }));
    expect(result.status).toBe('running');
    expect(result.statusLabel).toBe('运行中');
    expect(result.running).toBe(true);
    expect(result.installedKnown).toBe(true);
  });

  it('maps unhealthy + configured to error', () => {
    const result = adaptServiceState(makeHome({ status: 'unhealthy', configured: true, error: 'HTTP 503' }));
    expect(result.status).toBe('error');
    expect(result.statusLabel).toBe('异常');
    expect(result.running).toBe(false);
    expect(result.installedKnown).toBe(true);
    expect(result.error).toBe('HTTP 503');
  });

  it('maps not_configured to not_configured', () => {
    const result = adaptServiceState(makeHome({ status: 'not_configured', configured: false, endpoint: null }));
    expect(result.status).toBe('not_configured');
    expect(result.statusLabel).toBe('未配置');
    expect(result.running).toBe(false);
    expect(result.installedKnown).toBe(false);
  });

  it('passes through availableActions unchanged', () => {
    const result = adaptServiceState(makeHome({ availableActions: ['start', 'uninstall'] }));
    expect(result.availableActions).toEqual(['start', 'uninstall']);
  });

  it('passes through prerequisites', () => {
    const prereqs = { runtime: 'python3', models: [{ name: 'base', size: '74MB', autoDownload: true }] };
    const result = adaptServiceState(makeHome({ prerequisites: prereqs }));
    expect(result.prerequisites).toEqual(prereqs);
  });

  it('preserves all identity fields', () => {
    const home = makeHome({ id: 'mlx-tts', name: 'MLX TTS', category: 'voice', features: ['voice-output'] });
    const result = adaptServiceState(home);
    expect(result.id).toBe('mlx-tts');
    expect(result.name).toBe('MLX TTS');
    expect(result.category).toBe('voice');
    expect(result.features).toEqual(['voice-output']);
  });
});

describe('adaptServiceToPlugin', () => {
  function makeUi(overrides: Partial<ServiceUiState> = {}): ServiceUiState {
    return {
      id: 'whisper-stt',
      name: 'Whisper STT',
      description: 'Speech to text',
      category: 'voice',
      endpoint: 'http://localhost:9876',
      features: ['voice-input'],
      status: 'running',
      statusLabel: '运行中',
      installedKnown: true,
      running: true,
      availableActions: [],
      ...overrides,
    };
  }

  it('maps running service to active plugin', () => {
    const result = adaptServiceToPlugin(makeUi({ running: true }));
    expect(result.status).toBe('active');
    expect(result.statusLabel).toBe('运行中');
    expect(result.source).toBe('service');
  });

  it('maps installed-but-stopped service to configured plugin', () => {
    const result = adaptServiceToPlugin(makeUi({ running: false, installedKnown: true }));
    expect(result.status).toBe('configured');
    expect(result.statusLabel).toBe('已安装');
  });

  it('maps unconfigured service to available plugin', () => {
    const result = adaptServiceToPlugin(makeUi({ running: false, installedKnown: false }));
    expect(result.status).toBe('available');
    expect(result.statusLabel).toBe('可安装');
  });

  it('passes through error from service', () => {
    const result = adaptServiceToPlugin(makeUi({ error: 'HTTP 503' }));
    expect(result.error).toBe('HTTP 503');
  });
});

describe('adapter does not expose enabled', () => {
  it('ServiceUiState has no enabled field from home data', () => {
    const result = adaptServiceState(makeHome());
    expect('enabled' in result).toBe(false);
  });
});

describe('end-to-end: home service → plugin status', () => {
  it('healthy home service becomes active plugin', () => {
    const plugin = adaptServiceToPlugin(adaptServiceState(makeHome({ status: 'healthy' })));
    expect(plugin.status).toBe('active');
    expect(plugin.statusLabel).toBe('运行中');
  });

  it('unhealthy configured home service becomes configured plugin', () => {
    const plugin = adaptServiceToPlugin(adaptServiceState(makeHome({ status: 'unhealthy', configured: true })));
    expect(plugin.status).toBe('configured');
    expect(plugin.statusLabel).toBe('已安装');
  });

  it('not_configured home service becomes available plugin', () => {
    const plugin = adaptServiceToPlugin(adaptServiceState(makeHome({ status: 'not_configured', configured: false })));
    expect(plugin.status).toBe('available');
    expect(plugin.statusLabel).toBe('可安装');
  });
});
