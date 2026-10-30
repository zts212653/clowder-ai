import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { OverviewPanel } from '../HubObservabilityOverview';
import { HubObservabilityTab } from '../HubObservabilityTab';
import type { HealthData } from '../observability-helpers';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../HubCallbackAuthPanel', () => ({ HubCallbackAuthPanel: () => null }));
vi.mock('../HubTraceTree', () => ({ TraceBrowser: () => null }));
vi.mock('../HubEvalTab', () => ({ HubEvalTab: () => null }));

const degraded: HealthData = {
  status: 'degraded',
  uptime: 120,
  otelEnabled: true,
  errorRate: 0.125,
  readiness: { status: 'degraded', checks: { redis: { ok: false, ms: 15, error: 'Redis unavailable' } } },
  traceStore: null,
  metricsSnapshotStore: null,
  timestamp: 1,
};

describe('HealthPanel degraded responses', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a 503 body with failed readiness and the actual error rate', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(degraded), { status: 503 }));
    await act(async () => root.render(<HubObservabilityTab initialSubTab="health" />));
    expect(apiFetch).toHaveBeenCalledWith('/api/telemetry/health');
    expect(host.textContent).toContain('Degraded');
    expect(host.textContent).toContain('Readiness Checks');
    expect(host.textContent).toContain('Redis unavailable');
    expect(host.textContent).toContain('12.5%');
    expect(host.textContent).not.toContain('Unable to load');
  });

  it('does not present an unrelated error response as valid health data', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(degraded), { status: 500 }));
    await act(async () => root.render(<HubObservabilityTab initialSubTab="health" />));
    expect(host.textContent).toContain('Unable to load health data.');
    expect(host.textContent).not.toContain('Readiness Checks');
  });
  it('#1672 renders canceled counts without diluting the error percentage', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const path = String(url);
      const body = path.includes('metrics/history')
        ? {
            snapshots: [
              {
                timestamp: 1,
                metrics: {
                  'cat_cafe_invocation_completed{status="ok"}': 2,
                  'cat_cafe_invocation_completed{status="error"}': 1,
                  'cat_cafe_invocation_completed{status="canceled"}': 10,
                },
              },
            ],
          }
        : path.includes('env-summary')
          ? { variables: [] }
          : degraded;
      return new Response(JSON.stringify(body));
    });
    await act(async () => root.render(<OverviewPanel />));
    const label = [...host.querySelectorAll('div')].find((node) => node.textContent === 'Invocation (canceled)');
    expect(label?.parentElement?.textContent).toBe('Invocation (canceled)10');
    expect(host.textContent).toContain('33.3% error');
  });
});
