import type { BleBindingCheckView, BleBindingView, BleDiscoveryView, BleStatus } from './ble-device-types';
import {
  SettingsBadge,
  SettingsCard,
  SettingsDeleteButton,
  SettingsPrimaryButton,
  SettingsSecondaryButton,
  SettingsText,
} from './primitives';

function signalLabel(rssi: number): string {
  if (rssi >= -55) return '信号强';
  if (rssi >= -70) return '信号中等';
  return '信号较弱';
}

export function bleStatusBadge(status: BleStatus): {
  tone: 'emerald' | 'amber' | 'red' | 'slate';
  label: string;
} {
  if (status.state === 'ready') return { tone: 'emerald', label: 'BLE 就绪' };
  if (status.state === 'starting') return { tone: 'amber', label: '正在启动 helper' };
  if (status.state === 'degraded') return { tone: 'red', label: 'BLE 已降级' };
  if (status.state === 'unsupported') return { tone: 'slate', label: '当前不支持' };
  return { tone: 'slate', label: '按需启动' };
}

export function BleDiscoveryCard({
  discovery,
  disabled,
  onBind,
  actionLabel = '绑定设备',
}: {
  discovery: BleDiscoveryView;
  disabled: boolean;
  onBind: () => void;
  actionLabel?: string;
}) {
  return (
    <SettingsCard className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <SettingsText as="p" variant="sm" tone="default" className="truncate font-semibold">
          {discovery.name ?? '未命名 BLE 设备'}
        </SettingsText>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <SettingsBadge tone={discovery.rssi >= -70 ? 'blue' : 'amber'}>{signalLabel(discovery.rssi)}</SettingsBadge>
          <SettingsText className="hidden sm:inline">
            {discovery.serviceUuids.length > 0 ? discovery.serviceUuids.join(' · ') : '服务待检查'}
          </SettingsText>
        </div>
      </div>
      <SettingsPrimaryButton onClick={onBind} disabled={disabled}>
        {actionLabel}
      </SettingsPrimaryButton>
    </SettingsCard>
  );
}

function bindingCheckPresentation(check?: BleBindingCheckView): {
  tone: 'emerald' | 'amber' | 'red';
  label: string;
  reason: string | null;
} {
  if (!check) return { tone: 'emerald', label: '已绑定', reason: null };
  if (check.state === 'reachable') return { tone: 'emerald', label: '可连接', reason: null };
  if (check.state === 'profile_mismatch') {
    return { tone: 'amber', label: '配置不匹配', reason: '设备可连接，但类型化能力与原绑定不一致。' };
  }
  if (check.reason === 'timeout') {
    return { tone: 'red', label: '不可连接', reason: '连接超时，设备身份可能已轮换。' };
  }
  if (check.reason === 'busy') {
    return { tone: 'red', label: '不可连接', reason: '设备当前正忙，请稍后重试。' };
  }
  return { tone: 'red', label: '不可连接', reason: '当前无法连接到已保存的设备身份。' };
}

function bindingCheckTime(checkedAt: number): string {
  return new Date(checkedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function BleBindingCard({
  binding,
  check,
  disabled,
  probing,
  onProbe,
  onBeginRebind,
  onUnbind,
}: {
  binding: BleBindingView;
  check?: BleBindingCheckView;
  disabled: boolean;
  probing: boolean;
  onProbe: () => void;
  onBeginRebind: () => void;
  onUnbind: () => void;
}) {
  const presentation = bindingCheckPresentation(check);
  return (
    <SettingsCard className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
            {binding.displayName}
          </SettingsText>
          <SettingsBadge tone={presentation.tone}>{presentation.label}</SettingsBadge>
        </div>
        <SettingsText as="p" className="mt-1">
          {binding.adapterId}
        </SettingsText>
        {presentation.reason && (
          <SettingsText as="p" className="mt-1">
            {presentation.reason}
          </SettingsText>
        )}
        {check && (
          <SettingsText as="p" className="mt-1">
            最近测试：{bindingCheckTime(check.checkedAt)}
          </SettingsText>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {binding.commands.map((command) => (
            <SettingsBadge key={command} tone="slate" size="xxs">
              {command}
            </SettingsBadge>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <SettingsSecondaryButton onClick={onProbe} disabled={disabled}>
          {probing ? '测试中…' : '测试绑定状态'}
        </SettingsSecondaryButton>
        {check && check.state !== 'reachable' && (
          <SettingsPrimaryButton onClick={onBeginRebind} disabled={disabled}>
            重新关联
          </SettingsPrimaryButton>
        )}
        <SettingsDeleteButton onClick={onUnbind} disabled={disabled} aria-label={`解除绑定 ${binding.displayName}`} />
      </div>
    </SettingsCard>
  );
}
