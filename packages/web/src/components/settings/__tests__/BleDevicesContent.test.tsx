import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, confirm } = vi.hoisted(() => ({ apiFetch: vi.fn(), confirm: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => confirm }));

import { BleDevicesContent } from '../BleDevicesContent';

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

describe('BleDevicesContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
    confirm.mockReset();
    confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders the unsupported state without offering a scan action', async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        platform: 'linux',
        available: false,
        state: 'unsupported',
        reason: 'BLE helper is only available on macOS in Phase A',
        restartAttempts: 0,
        bindingCount: 0,
      }),
    );

    await act(async () => root.render(<BleDevicesContent />));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('当前平台暂不支持 BLE');
    expect(container.textContent).toContain('BLE helper is only available on macOS');
    expect(container.textContent).not.toContain('扫描附近设备');
  });

  it('renders scanning results and binds using opaque IDs only', async () => {
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const requestKey = `${init?.method ?? 'GET'} ${path}`;
      switch (requestKey) {
        case 'GET /api/limb/ble/status':
          return jsonResponse({
            platform: 'darwin',
            available: true,
            state: 'ready',
            reason: null,
            restartAttempts: 0,
            bindingCount: 0,
          });
        case 'GET /api/limb/ble/bindings':
          return jsonResponse({ bindings: [] });
        case 'GET /api/limb/ble/scan':
          return jsonResponse({
            active: true,
            sessionId: 'scan-opaque',
            startedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
            discoveries: [
              {
                discoveryId: 'discovery-opaque',
                name: 'Desk Sensor',
                rssi: -47,
                serviceUuids: ['181a'],
              },
            ],
          });
        case 'POST /api/limb/ble/bindings':
          return jsonResponse(
            {
              bindingId: 'binding-1',
              displayName: 'Desk Sensor',
              adapterId: 'standard.environmental',
              commands: ['ble.temperature.read'],
              nodeId: 'ble:binding-1',
              createdAt: Date.now(),
              lastConnectedAt: Date.now(),
            },
            true,
            201,
          );
        default:
          throw new Error(`Unexpected request: ${requestKey}`);
      }
    });

    await act(async () => root.render(<BleDevicesContent />));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('Desk Sensor');
    expect(container.textContent).toContain('正在扫描');

    const bindButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('绑定设备'),
    );
    expect(bindButton).toBeTruthy();
    await act(async () => bindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const bindCall = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(bindCall?.[1]?.body as string)).toEqual({
      sessionId: 'scan-opaque',
      discoveryId: 'discovery-opaque',
    });
    expect(bindCall?.[1]?.body).not.toContain('deviceId');
  });

  it('shows degraded helper state and keeps existing bindings visible', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) {
        return jsonResponse({
          platform: 'darwin',
          available: true,
          state: 'degraded',
          reason: 'helper restart attempts exhausted',
          restartAttempts: 3,
          bindingCount: 1,
        });
      }
      if (path.endsWith('/bindings')) {
        return jsonResponse({
          bindings: [
            {
              bindingId: 'binding-1',
              displayName: 'Desk Sensor',
              adapterId: 'standard.environmental',
              commands: ['ble.temperature.read'],
              nodeId: 'ble:binding-1',
              createdAt: 100,
              lastConnectedAt: 100,
            },
          ],
        });
      }
      if (path.endsWith('/scan')) {
        return jsonResponse({ active: false, sessionId: null, startedAt: null, expiresAt: null, discoveries: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => root.render(<BleDevicesContent />));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('BLE helper 已降级');
    expect(container.textContent).toContain('helper restart attempts exhausted');
    expect(container.textContent).toContain('Desk Sensor');
    expect(container.textContent).toContain('重试并扫描');
    expect(
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('重试并扫描'))
        ?.disabled,
    ).toBe(false);
  });

  it('tests an unreachable binding and explicitly rebinds it using opaque discovery IDs', async () => {
    const binding = {
      bindingId: 'binding-1',
      displayName: 'Desk Sensor',
      adapterId: 'standard.environmental',
      commands: ['ble.temperature.read'],
      nodeId: 'ble:binding-1',
      createdAt: 100,
      lastConnectedAt: 100,
    };
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const requestKey = `${init?.method ?? 'GET'} ${path}`;
      switch (requestKey) {
        case 'GET /api/limb/ble/status':
          return jsonResponse({
            platform: 'darwin',
            available: true,
            state: 'ready',
            reason: null,
            restartAttempts: 0,
            bindingCount: 1,
          });
        case 'GET /api/limb/ble/bindings':
          return jsonResponse({ bindings: [binding] });
        case 'GET /api/limb/ble/scan':
          return jsonResponse({
            active: true,
            sessionId: 'scan-rotated',
            startedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
            discoveries: [
              {
                discoveryId: 'discovery-rotated',
                name: 'Desk Sensor',
                rssi: -45,
                serviceUuids: ['181a'],
              },
            ],
          });
        case 'POST /api/limb/ble/bindings/binding-1/probe':
          return jsonResponse({
            bindingId: 'binding-1',
            state: 'unreachable',
            reason: 'timeout',
            checkedAt: 200,
          });
        case 'POST /api/limb/ble/bindings/binding-1/rebind':
          return jsonResponse({ ...binding, lastConnectedAt: 300 });
        default:
          throw new Error(`Unexpected request: ${requestKey}`);
      }
    });

    await act(async () => root.render(<BleDevicesContent />));
    await act(async () => Promise.resolve());
    const probeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('测试绑定状态'),
    );
    expect(probeButton).toBeTruthy();
    await act(async () => probeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('不可连接');

    const beginRebindButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重新关联'),
    );
    expect(beginRebindButton).toBeTruthy();
    await act(async () => beginRebindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const candidateButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '重新关联到此设备',
    );
    expect(candidateButton).toBeTruthy();
    confirm.mockResolvedValueOnce(false);
    await act(async () => candidateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(
      apiFetch.mock.calls.some(
        ([path, init]) => path === '/api/limb/ble/bindings/binding-1/rebind' && init?.method === 'POST',
      ),
    ).toBe(false);
    confirm.mockResolvedValueOnce(true);
    await act(async () => candidateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const rebindCall = apiFetch.mock.calls.find(
      ([path, init]) => path === '/api/limb/ble/bindings/binding-1/rebind' && init?.method === 'POST',
    );
    expect(JSON.parse(rebindCall?.[1]?.body as string)).toEqual({
      sessionId: 'scan-rotated',
      discoveryId: 'discovery-rotated',
    });
    expect(rebindCall?.[1]?.body).not.toContain('deviceId');
    expect(confirm).toHaveBeenCalledWith({
      title: '重新关联 BLE 设备',
      message: '把「Desk Sensor」重新关联到「Desk Sensor」？原节点和审计关联会保留。',
      confirmLabel: '确认重新关联',
    });
    expect(container.textContent).toContain('可连接');
    expect(container.textContent).toContain('最近测试');
  });
});
