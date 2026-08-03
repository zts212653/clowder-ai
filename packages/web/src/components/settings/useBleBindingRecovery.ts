'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useConfirm } from '../useConfirm';
import type { BleBindingCheckView, BleBindingView, BleScanSnapshot } from './ble-device-types';

interface BleBindingRecoveryOptions {
  scan: BleScanSnapshot;
  startScan: () => Promise<void>;
  refreshBindings: () => Promise<void>;
  setBusyKey: (key: string | null) => void;
  setError: (error: string | null) => void;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error ?? `${fallback} (${response.status})`;
}

export function useBleBindingRecovery(options: BleBindingRecoveryOptions) {
  const confirm = useConfirm();
  const [checks, setChecks] = useState<Record<string, BleBindingCheckView>>({});
  const [rebindTarget, setRebindTarget] = useState<BleBindingView | null>(null);

  const probeBinding = useCallback(
    async (binding: BleBindingView) => {
      options.setBusyKey(`probe:${binding.bindingId}`);
      options.setError(null);
      try {
        const response = await apiFetch(`/api/limb/ble/bindings/${encodeURIComponent(binding.bindingId)}/probe`, {
          method: 'POST',
        });
        if (!response.ok) throw new Error(await responseError(response, '绑定状态测试失败'));
        const result = (await response.json()) as BleBindingCheckView;
        setChecks((current) => ({ ...current, [binding.bindingId]: result }));
      } catch (probeError) {
        options.setError(probeError instanceof Error ? probeError.message : '绑定状态测试失败');
      } finally {
        options.setBusyKey(null);
      }
    },
    [options],
  );

  const beginRebind = useCallback(
    async (binding: BleBindingView) => {
      setRebindTarget(binding);
      options.setError(null);
      if (!options.scan.active) await options.startScan();
    },
    [options],
  );

  const rebindDiscovery = useCallback(
    async (discoveryId: string, discoveryName: string | null) => {
      if (!rebindTarget || !options.scan.sessionId) return;
      const accepted = await confirm({
        title: '重新关联 BLE 设备',
        message: `把「${rebindTarget.displayName}」重新关联到「${discoveryName ?? '未命名 BLE 设备'}」？原节点和审计关联会保留。`,
        confirmLabel: '确认重新关联',
      });
      if (!accepted) return;
      options.setBusyKey(`rebind:${rebindTarget.bindingId}`);
      options.setError(null);
      try {
        const response = await apiFetch(`/api/limb/ble/bindings/${encodeURIComponent(rebindTarget.bindingId)}/rebind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: options.scan.sessionId, discoveryId }),
        });
        if (!response.ok) throw new Error(await responseError(response, '重新关联失败'));
        const binding = (await response.json()) as BleBindingView;
        await options.refreshBindings();
        setChecks((current) => ({
          ...current,
          [binding.bindingId]: {
            bindingId: binding.bindingId,
            state: 'reachable',
            checkedAt: binding.lastConnectedAt ?? Date.now(),
          },
        }));
        setRebindTarget(null);
      } catch (rebindError) {
        options.setError(rebindError instanceof Error ? rebindError.message : '重新关联失败');
      } finally {
        options.setBusyKey(null);
      }
    },
    [confirm, options, rebindTarget],
  );

  return {
    checks,
    rebindTarget,
    probeBinding,
    beginRebind,
    cancelRebind: () => setRebindTarget(null),
    rebindDiscovery,
  };
}
