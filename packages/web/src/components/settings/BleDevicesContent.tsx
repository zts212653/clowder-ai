'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useConfirm } from '../useConfirm';
import { BleDeviceSections } from './BleDeviceSections';
import { type BleBindingView, type BleScanSnapshot, type BleStatus, EMPTY_BLE_SCAN } from './ble-device-types';
import { SettingsStatusStrip } from './primitives';
import { useBleBindingRecovery } from './useBleBindingRecovery';

async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error ?? `${fallback} (${response.status})`;
}

export function BleDevicesContent() {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<BleStatus | null>(null);
  const [bindings, setBindings] = useState<BleBindingView[]>([]);
  const [scan, setScan] = useState<BleScanSnapshot>(EMPTY_BLE_SCAN);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<BleStatus> => {
    const response = await apiFetch('/api/limb/ble/status');
    if (!response.ok) throw new Error(await responseError(response, 'BLE 状态加载失败'));
    const nextStatus = (await response.json()) as BleStatus;
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  const refreshBindings = useCallback(async () => {
    const response = await apiFetch('/api/limb/ble/bindings');
    if (!response.ok) throw new Error(await responseError(response, '设备绑定加载失败'));
    const payload = (await response.json()) as { bindings: BleBindingView[] };
    setBindings(payload.bindings);
  }, []);

  const refreshScan = useCallback(async () => {
    const response = await apiFetch('/api/limb/ble/scan');
    if (!response.ok) throw new Error(await responseError(response, '扫描状态加载失败'));
    setScan((await response.json()) as BleScanSnapshot);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextStatus = await refreshStatus();
      if (nextStatus.available) await Promise.all([refreshBindings(), refreshScan()]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'BLE 状态加载失败');
    } finally {
      setLoading(false);
    }
  }, [refreshBindings, refreshScan, refreshStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!scan.active) return;
    const timer = window.setInterval(() => {
      void refreshScan().catch((pollError) => {
        setError(pollError instanceof Error ? pollError.message : '扫描状态刷新失败');
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [refreshScan, scan.active]);

  const startScan = useCallback(async () => {
    setBusyKey('scan');
    setError(null);
    try {
      const response = await apiFetch('/api/limb/ble/scan', { method: 'POST' });
      if (!response.ok) throw new Error(await responseError(response, '扫描启动失败'));
      const started = (await response.json()) as Omit<BleScanSnapshot, 'active' | 'discoveries'>;
      setScan({ active: true, discoveries: [], ...started });
      await refreshStatus();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : '扫描启动失败');
    } finally {
      setBusyKey(null);
    }
  }, [refreshStatus]);

  const stopScan = useCallback(async () => {
    setBusyKey('scan');
    try {
      const response = await apiFetch('/api/limb/ble/scan', { method: 'DELETE' });
      if (!response.ok) throw new Error(await responseError(response, '扫描停止失败'));
      setScan(EMPTY_BLE_SCAN);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : '扫描停止失败');
    } finally {
      setBusyKey(null);
    }
  }, []);

  const bind = useCallback(
    async (discoveryId: string) => {
      if (!scan.sessionId) return;
      setBusyKey(discoveryId);
      setError(null);
      try {
        const response = await apiFetch('/api/limb/ble/bindings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: scan.sessionId, discoveryId }),
        });
        if (!response.ok) throw new Error(await responseError(response, '设备绑定失败'));
        await Promise.all([refreshBindings(), refreshScan()]);
      } catch (bindError) {
        setError(bindError instanceof Error ? bindError.message : '设备绑定失败');
      } finally {
        setBusyKey(null);
      }
    },
    [refreshBindings, refreshScan, scan.sessionId],
  );

  const unbind = useCallback(
    async (binding: BleBindingView) => {
      const accepted = await confirm({
        title: '解除 BLE 绑定',
        message: `解除「${binding.displayName}」后，相关 Limb 能力会立即失效。`,
        confirmLabel: '解除绑定',
        variant: 'danger',
      });
      if (!accepted) return;
      setBusyKey(binding.bindingId);
      try {
        const response = await apiFetch(`/api/limb/ble/bindings/${encodeURIComponent(binding.bindingId)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error(await responseError(response, '解除绑定失败'));
        await refreshBindings();
      } catch (unbindError) {
        setError(unbindError instanceof Error ? unbindError.message : '解除绑定失败');
      } finally {
        setBusyKey(null);
      }
    },
    [confirm, refreshBindings],
  );

  const recovery = useBleBindingRecovery({
    scan,
    startScan,
    refreshBindings,
    setBusyKey,
    setError,
  });

  if (loading) {
    return <SettingsStatusStrip tone="muted">正在加载 BLE 状态...</SettingsStatusStrip>;
  }
  if (!status) {
    return <SettingsStatusStrip tone="error">{error ?? 'BLE 状态不可用'}</SettingsStatusStrip>;
  }

  return (
    <BleDeviceSections
      status={status}
      bindings={bindings}
      scan={scan}
      busyKey={busyKey}
      error={error}
      bindingChecks={recovery.checks}
      rebindTarget={recovery.rebindTarget}
      onStartScan={() => void startScan()}
      onStopScan={() => void stopScan()}
      onBind={(discoveryId) => void bind(discoveryId)}
      onProbe={(binding) => void recovery.probeBinding(binding)}
      onBeginRebind={(binding) => void recovery.beginRebind(binding)}
      onCancelRebind={recovery.cancelRebind}
      onRebind={(discoveryId, discoveryName) => void recovery.rebindDiscovery(discoveryId, discoveryName)}
      onUnbind={(binding) => void unbind(binding)}
    />
  );
}
