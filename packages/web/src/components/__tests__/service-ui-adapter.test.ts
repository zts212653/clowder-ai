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
    installed: true,
    enabled: true,
    installable: true,
    ...overrides,
  };
}

describe('adaptServiceState', () => {
  it('maps healthy to running (installed=true, enabled=true)', () => {
    const result = adaptServiceState(makeHome({ status: 'healthy' }));
    expect(result.status).toBe('running');
    expect(result.statusLabel).toBe('运行中');
    expect(result.running).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.enabled).toBe(true);
  });

  it('maps installed + enabled + unhealthy to error', () => {
    const result = adaptServiceState(
      makeHome({ status: 'unhealthy', installed: true, enabled: true, error: 'HTTP 503' }),
    );
    expect(result.status).toBe('error');
    expect(result.statusLabel).toBe('异常');
    expect(result.running).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.error).toBe('HTTP 503');
  });

  it('maps installed + disabled to stopped', () => {
    const result = adaptServiceState(makeHome({ status: 'unhealthy', installed: true, enabled: false }));
    expect(result.status).toBe('stopped');
    expect(result.statusLabel).toBe('未启动');
    expect(result.running).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.enabled).toBe(false);
  });

  it('suppresses error when installed but disabled', () => {
    const result = adaptServiceState(
      makeHome({ status: 'unhealthy', installed: true, enabled: false, error: 'fetch failed' }),
    );
    expect(result.error).toBeUndefined();
  });

  it('maps not installed to not_configured', () => {
    const result = adaptServiceState(
      makeHome({ status: 'not_configured', configured: false, endpoint: null, installed: false, enabled: false }),
    );
    expect(result.status).toBe('not_configured');
    expect(result.statusLabel).toBe('未配置');
    expect(result.running).toBe(false);
    expect(result.installed).toBe(false);
  });

  it('suppresses error when not installed', () => {
    const result = adaptServiceState(
      makeHome({
        status: 'not_configured',
        configured: false,
        endpoint: null,
        installed: false,
        enabled: false,
        error: 'fetch failed',
      }),
    );
    expect(result.error).toBeUndefined();
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
    expect(result.name).toBe('语音合成 (MLX)');
    expect(result.category).toBe('voice');
    expect(result.features).toEqual(['voice-output']);
  });

  it('passes through installable flag', () => {
    const result = adaptServiceState(makeHome({ installable: false }));
    expect(result.installable).toBe(false);
  });

  it('passes through selected model metadata', () => {
    const result = adaptServiceState(makeHome({ selectedModel: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ' }));
    expect(result.selectedModel).toBe('mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ');
  });

  it('passes through persisted port so the reconfigure modal can pre-fill it', () => {
    const result = adaptServiceState(makeHome({ port: 19999 }));
    expect(result.port).toBe(19999);
  });

  it('omits port when service config does not persist one', () => {
    const result = adaptServiceState(makeHome());
    expect(result.port).toBeUndefined();
  });

  it('healthy does not override installed/enabled from API', () => {
    const result = adaptServiceState(makeHome({ status: 'healthy', installed: false, enabled: false }));
    expect(result.running).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.status).toBe('not_configured');
  });

  it('scriptless healthy maps to running regardless of enabled', () => {
    const result = adaptServiceState(
      makeHome({ id: 'audio-capture', status: 'healthy', installable: false, enabled: false }),
    );
    expect(result.status).toBe('running');
    expect(result.running).toBe(true);
  });

  it('scriptless unhealthy+configured maps to error with message', () => {
    const result = adaptServiceState(
      makeHome({
        id: 'audio-capture',
        status: 'unhealthy',
        installable: false,
        enabled: false,
        configured: true,
        error: 'ECONNREFUSED',
      }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('scriptless unconfigured maps to not_configured', () => {
    const result = adaptServiceState(
      makeHome({
        id: 'audio-capture',
        status: 'not_configured',
        installable: false,
        enabled: false,
        configured: false,
        endpoint: null,
      }),
    );
    expect(result.status).toBe('not_configured');
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
      installed: true,
      enabled: true,
      installable: true,
      running: true,
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
    const result = adaptServiceToPlugin(makeUi({ running: false, installed: true }));
    expect(result.status).toBe('configured');
    expect(result.statusLabel).toBe('已安装');
  });

  it('maps not-installed service to available plugin', () => {
    const result = adaptServiceToPlugin(makeUi({ running: false, installed: false }));
    expect(result.status).toBe('available');
    expect(result.statusLabel).toBe('可安装');
  });

  it('passes through error from service', () => {
    const result = adaptServiceToPlugin(makeUi({ error: 'HTTP 503' }));
    expect(result.error).toBe('HTTP 503');
  });
});

describe('explicit state fields', () => {
  it('no availableActions in adapter types', () => {
    const result = adaptServiceState(makeHome());
    expect('availableActions' in result).toBe(false);
  });

  it('exposes installed and enabled fields', () => {
    const result = adaptServiceState(makeHome({ installed: true, enabled: false }));
    expect('installed' in result).toBe(true);
    expect('enabled' in result).toBe(true);
  });
});

describe('end-to-end: home service → plugin status', () => {
  it('healthy home service becomes active plugin', () => {
    const plugin = adaptServiceToPlugin(adaptServiceState(makeHome({ status: 'healthy' })));
    expect(plugin.status).toBe('active');
    expect(plugin.statusLabel).toBe('运行中');
  });

  it('installed disabled home service becomes configured plugin', () => {
    const plugin = adaptServiceToPlugin(
      adaptServiceState(makeHome({ status: 'unhealthy', installed: true, enabled: false })),
    );
    expect(plugin.status).toBe('configured');
    expect(plugin.statusLabel).toBe('已安装');
  });

  it('not installed home service becomes available plugin', () => {
    const plugin = adaptServiceToPlugin(
      adaptServiceState(makeHome({ status: 'not_configured', configured: false, installed: false, enabled: false })),
    );
    expect(plugin.status).toBe('available');
    expect(plugin.statusLabel).toBe('可安装');
  });
});
