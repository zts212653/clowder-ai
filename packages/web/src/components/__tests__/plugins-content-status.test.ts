import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  API_URL: 'http://localhost:3102',
}));

import { resolvePluginStatuses } from '../settings/PluginsContent';

describe('resolvePluginStatuses', () => {
  it('platform plugins are active when API is reachable', () => {
    const result = resolvePluginStatuses([], true);
    const platform = result.filter((p) => p.source === 'platform');

    expect(platform.length).toBe(3);
    for (const p of platform) {
      expect(p.status).toBe('active');
      expect(p.statusLabel).toBe('已连接');
    }
  });

  it('platform plugins show unreachable when API is down', () => {
    const result = resolvePluginStatuses([], false);
    const platform = result.filter((p) => p.source === 'platform');

    for (const p of platform) {
      expect(p.status).toBe('available');
      expect(p.statusLabel).toBe('API 不可达');
    }
  });

  it('service plugins show active when their features are running', () => {
    const services = [
      {
        manifest: { id: 'whisper-stt', enablesFeatures: ['voice-input', 'connector-stt'] },
        status: 'running' as const,
      },
      {
        manifest: { id: 'mlx-tts', enablesFeatures: ['voice-output', 'voice-companion'] },
        status: 'running' as const,
      },
    ];
    const result = resolvePluginStatuses(services, true);
    const voice = result.find((p) => p.id === 'voice-companion');

    expect(voice?.status).toBe('active');
    expect(voice?.statusLabel).toBe('已连接');
  });

  it('service plugins show configured when features known but not running', () => {
    const services = [
      {
        manifest: { id: 'whisper-stt', enablesFeatures: ['voice-input', 'connector-stt'] },
        status: 'stopped' as const,
      },
    ];
    const result = resolvePluginStatuses(services, true);
    const voice = result.find((p) => p.id === 'voice-companion');

    expect(voice?.status).toBe('configured');
    expect(voice?.statusLabel).toBe('已配置');
  });

  it('service plugins show available when no matching features exist', () => {
    const result = resolvePluginStatuses([], true);
    const voice = result.find((p) => p.id === 'voice-companion');
    const browser = result.find((p) => p.id === 'browser-automation');

    expect(voice?.status).toBe('available');
    expect(voice?.statusLabel).toBe('未连接');
    expect(browser?.status).toBe('available');
    expect(browser?.statusLabel).toBe('未连接');
  });

  it('platform status is independent of service registry contents', () => {
    const services = [
      {
        manifest: { id: 'whisper-stt', enablesFeatures: ['voice-input'] },
        status: 'running' as const,
      },
    ];
    const result = resolvePluginStatuses(services, true);

    const prTracking = result.find((p) => p.id === 'pr-tracking');
    const reviewRouter = result.find((p) => p.id === 'review-router');
    const ciCd = result.find((p) => p.id === 'ci-cd-monitor');

    expect(prTracking?.status).toBe('active');
    expect(reviewRouter?.status).toBe('active');
    expect(ciCd?.status).toBe('active');
  });
});
