import { HubIcon } from '../hub-icons';
import { BleBindingCard, BleDiscoveryCard, bleStatusBadge } from './BleDeviceCards';
import type { BleBindingCheckView, BleBindingView, BleScanSnapshot, BleStatus } from './ble-device-types';
import {
  SettingsBadge,
  SettingsEmptyState,
  SettingsPrimaryButton,
  SettingsSecondaryButton,
  SettingsSection,
  SettingsStatusStrip,
  SettingsText,
} from './primitives';

interface BleDeviceViewProps {
  status: BleStatus;
  bindings: BleBindingView[];
  scan: BleScanSnapshot;
  busyKey: string | null;
  error: string | null;
  bindingChecks: Record<string, BleBindingCheckView>;
  rebindTarget: BleBindingView | null;
  onStartScan: () => void;
  onStopScan: () => void;
  onBind: (discoveryId: string) => void;
  onProbe: (binding: BleBindingView) => void;
  onBeginRebind: (binding: BleBindingView) => void;
  onCancelRebind: () => void;
  onRebind: (discoveryId: string, discoveryName: string | null) => void;
  onUnbind: (binding: BleBindingView) => void;
}

function BleStatusNotices({ status, error }: Pick<BleDeviceViewProps, 'status' | 'error'>) {
  return (
    <>
      {!status.available && (
        <SettingsStatusStrip tone="warn" bordered>
          <span>
            <strong>当前平台暂不支持 BLE。</strong> {status.reason}
          </span>
        </SettingsStatusStrip>
      )}
      {status.available && status.state === 'degraded' && (
        <SettingsStatusStrip tone="error" bordered>
          <span>
            <strong>BLE helper 已降级。</strong> {status.reason}
          </span>
        </SettingsStatusStrip>
      )}
      {error && <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>}
    </>
  );
}

function BleScanControls({
  status,
  scan,
  busyKey,
  onStartScan,
  onStopScan,
}: Pick<BleDeviceViewProps, 'status' | 'scan' | 'busyKey' | 'onStartScan' | 'onStopScan'>) {
  if (!status.available) return null;
  if (!scan.active) {
    const scanEnabled = status.state !== 'starting' && status.state !== 'unsupported';
    return (
      <SettingsPrimaryButton onClick={onStartScan} disabled={!scanEnabled || busyKey === 'scan'}>
        {status.state === 'degraded' ? '重试并扫描' : '扫描附近设备'}
      </SettingsPrimaryButton>
    );
  }

  const remainingSeconds = scan.expiresAt ? Math.max(0, Math.ceil((scan.expiresAt - Date.now()) / 1_000)) : null;
  return (
    <>
      <SettingsSecondaryButton onClick={onStopScan} disabled={busyKey === 'scan'}>
        停止扫描
      </SettingsSecondaryButton>
      <SettingsBadge tone="blue">
        正在扫描{remainingSeconds !== null ? ` · 剩余 ${remainingSeconds} 秒` : ''}
      </SettingsBadge>
    </>
  );
}

function BleDiscoveryList({
  status,
  scan,
  busyKey,
  onBind,
  rebindTarget,
  onRebind,
}: Pick<BleDeviceViewProps, 'status' | 'scan' | 'busyKey' | 'onBind' | 'rebindTarget' | 'onRebind'>) {
  if (!status.available) return null;
  if (scan.discoveries.length === 0) {
    return (
      <SettingsEmptyState
        icon={<HubIcon name="activity" className="mb-3 h-6 w-6 text-cafe-muted" />}
        title={scan.active ? '正在等待附近设备' : '当前扫描会话没有设备'}
        description={scan.active ? '保持设备处于广播状态。' : '发起扫描后，附近设备会在此处短暂显示。'}
      />
    );
  }
  return (
    <div className="space-y-2">
      {scan.discoveries.map((discovery) => (
        <BleDiscoveryCard
          key={discovery.discoveryId}
          discovery={discovery}
          disabled={busyKey !== null}
          onBind={() =>
            rebindTarget ? onRebind(discovery.discoveryId, discovery.name) : onBind(discovery.discoveryId)
          }
          actionLabel={rebindTarget ? '重新关联到此设备' : '绑定设备'}
        />
      ))}
    </div>
  );
}

function BleBindingsSection({
  bindings,
  busyKey,
  bindingChecks,
  onProbe,
  onBeginRebind,
  onUnbind,
}: Pick<BleDeviceViewProps, 'bindings' | 'busyKey' | 'bindingChecks' | 'onProbe' | 'onBeginRebind' | 'onUnbind'>) {
  return (
    <SettingsSection title="已绑定设备" description="猫猫只能调用 adapter 声明的类型化能力，不能执行任意 GATT 写入。">
      {bindings.length === 0 ? (
        <SettingsText as="p">尚未绑定 BLE 设备。</SettingsText>
      ) : (
        <div className="space-y-2">
          {bindings.map((binding) => (
            <BleBindingCard
              key={binding.bindingId}
              binding={binding}
              check={bindingChecks[binding.bindingId]}
              disabled={busyKey !== null}
              probing={busyKey === `probe:${binding.bindingId}`}
              onProbe={() => onProbe(binding)}
              onBeginRebind={() => onBeginRebind(binding)}
              onUnbind={() => onUnbind(binding)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

export function BleDeviceSections(props: BleDeviceViewProps) {
  const badge = bleStatusBadge(props.status);
  return (
    <div className="space-y-5">
      <BleStatusNotices status={props.status} error={props.error} />
      <SettingsSection
        title="附近设备"
        description="扫描结果只保留到停止扫描或 30 秒超时。只有显式绑定的设备会持久保存。"
        badge={<SettingsBadge tone={badge.tone}>{badge.label}</SettingsBadge>}
      >
        {props.rebindTarget && (
          <SettingsStatusStrip
            tone="warn"
            actions={<SettingsSecondaryButton onClick={props.onCancelRebind}>取消重新关联</SettingsSecondaryButton>}
          >
            正在为「{props.rebindTarget.displayName}」选择新的广播身份。请确认目标设备后再重新关联。
          </SettingsStatusStrip>
        )}
        <div className="mb-3 flex flex-wrap gap-2">
          <BleScanControls
            status={props.status}
            scan={props.scan}
            busyKey={props.busyKey}
            onStartScan={props.onStartScan}
            onStopScan={props.onStopScan}
          />
        </div>
        <BleDiscoveryList
          status={props.status}
          scan={props.scan}
          busyKey={props.busyKey}
          onBind={props.onBind}
          rebindTarget={props.rebindTarget}
          onRebind={props.onRebind}
        />
      </SettingsSection>
      <BleBindingsSection
        bindings={props.bindings}
        busyKey={props.busyKey}
        bindingChecks={props.bindingChecks}
        onProbe={props.onProbe}
        onBeginRebind={props.onBeginRebind}
        onUnbind={props.onUnbind}
      />
    </div>
  );
}
