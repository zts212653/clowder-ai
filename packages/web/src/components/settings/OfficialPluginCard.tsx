import { useCallback, useState } from 'react';
import { ChevronIcon, HubIcon } from '../hub-icons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { OfficialPluginCatchUp, type OfficialPluginCatchUpAction } from './OfficialPluginCatchUp';
import { OfficialPluginHistoryImport } from './OfficialPluginHistoryImport';
import {
  OfficialPluginOwnerAuthAction,
  OfficialPluginOwnerAuthDetails,
  type OwnerAuthState,
  ownerAuthGuidance,
  useOfficialPluginOwnerAuth,
} from './OfficialPluginOwnerAuth';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsDeleteButton } from './primitives/SettingsDeleteButton';
import { SettingsPrimaryButton } from './primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from './primitives/SettingsSecondaryButton';
import { SettingsText } from './primitives/SettingsText';

export interface OfficialPluginInstance {
  pluginInstanceId: string;
  installedVersion: string | null;
  packageDigest: string;
  lifecycleState: 'installed' | 'retired';
  configReadiness: 'incomplete' | 'ready';
  activationState: 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error';
  runtimeState: 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
  lifecycleRevision: number;
  installedAt: number;
  updatedAt: number;
  lastRuntimeError?: {
    code: string;
    exitCode: number | null;
    signal: string | null;
    occurredAt: number;
  };
}

export interface OfficialPluginInfo {
  catalogId: string;
  packageName: string;
  version: string;
  availableVersion: string;
  pluginId: string;
  packageDigest: string;
  effectiveGrants: string[];
  ownerAuthAvailable: boolean;
  updateAvailable: boolean;
  instance: OfficialPluginInstance | null;
  intakeHealth?: OfficialMeetingIntakeHealth;
}

export interface OfficialMeetingIntakeHealth {
  status: 'ready' | 'auth-expired' | 'degraded';
  code?: string;
  lastCycleAt: number | null;
  lastSuccessfulObservationAt: number | null;
  lastPublishedAt: number | null;
  pendingCount: number;
  catchUp:
    | { status: 'idle' }
    | { status: 'needs-owner'; fromCursor: string | null; throughCursor: string; detectedAt: number }
    | {
        status: 'previewed';
        fromCursor: string | null;
        throughCursor: string;
        candidateCount: number;
        fingerprint: string;
        previewedAt: number;
      }
    | {
        status: 'backlog';
        fromCursor: string | null;
        throughCursor: string;
        candidateCountAtLeast: number;
        reason: 'PAGE_BOUND' | 'CANDIDATE_BOUND';
        detectedAt: number;
      };
  warning?: {
    code: string;
    message: string;
    action: 'preview-catch-up' | 'resolve-catch-up' | 'repair' | 'needs-owner';
  };
}

export type OfficialPluginAction = 'install' | 'update' | 'enable' | 'disable' | 'repair' | 'uninstall';

const MAINTENANCE_RESUME_FAILURES = new Set([
  'UPDATE_RESUME_FAILED',
  'UPDATE_ROLLBACK_RESUME_FAILED',
  'CATCH_UP_RESUME_FAILED',
]);

function maintenanceResumeFailure(plugin: OfficialPluginInfo): boolean {
  const code = plugin.instance?.lastRuntimeError?.code;
  return code !== undefined && MAINTENANCE_RESUME_FAILURES.has(code);
}

function status(plugin: OfficialPluginInfo): { label: string; tone: 'emerald' | 'amber' | 'slate' | 'red' } {
  const instance = plugin.instance;
  if (!instance) return { label: '未安装', tone: 'slate' };
  if (plugin.updateAvailable) return { label: '可更新', tone: 'amber' };
  if (plugin.intakeHealth?.warning?.code === 'CATCH_UP_BACKLOG') {
    return { label: '缺口待处理', tone: 'red' };
  }
  if (plugin.intakeHealth?.warning) return { label: '接收有缺口', tone: 'amber' };
  if (
    instance.lastRuntimeError?.code === 'EVENT_BUS_CONFLICT' &&
    (instance.activationState === 'error' || instance.runtimeState === 'crashed')
  ) {
    return { label: '连接被占用', tone: 'red' };
  }
  if (instance.activationState === 'error' || instance.runtimeState === 'crashed') {
    return { label: '需修复', tone: 'red' };
  }
  if (instance.runtimeState === 'healthy') return { label: '运行中', tone: 'emerald' };
  if (instance.runtimeState === 'degraded') return { label: '连接异常', tone: 'amber' };
  if (instance.activationState === 'enabled' || instance.activationState === 'enabling') {
    return { label: '正在启动', tone: 'amber' };
  }
  return { label: '已安装', tone: 'slate' };
}

function guidance(plugin: OfficialPluginInfo, auth: OwnerAuthState | null): string {
  const instance = plugin.instance;
  if (!instance) return '安装后仍需手动启用；Clowder AI 不会在启动时擅自连接飞书。';
  if (plugin.updateAvailable) {
    const installedVersion = instance.installedVersion ?? '未知版本';
    if (instance.activationState === 'enabled') {
      return `已安装 ${installedVersion}，${plugin.availableVersion} 可用。更新时会短暂重连，并保持已启用状态。`;
    }
    return `已安装 ${installedVersion}，${plugin.availableVersion} 可用。更新后会保持当前停用状态。`;
  }
  const authCopy = plugin.ownerAuthAvailable ? ownerAuthGuidance(auth) : undefined;
  if (authCopy) return authCopy;
  if (
    instance.lastRuntimeError?.code === 'EVENT_BUS_CONFLICT' &&
    (instance.activationState === 'error' || instance.runtimeState === 'crashed')
  ) {
    return '另一台设备或服务正在使用同一个飞书应用的事件连接。关闭旧连接或等待飞书释放后，点“重试连接”。';
  }
  if (maintenanceResumeFailure(plugin)) {
    if (instance.lastRuntimeError?.code === 'CATCH_UP_RESUME_FAILED') {
      return '缺口处理已保存，但接收服务未能恢复。确认飞书授权有效后，点“重试恢复”。';
    }
    if (instance.lastRuntimeError?.code === 'UPDATE_ROLLBACK_RESUME_FAILED') {
      return '插件更新失败，原接收服务也未能恢复。确认飞书授权有效后，点“重试恢复”。';
    }
    return '插件已更新，但接收服务未能恢复。确认飞书授权有效后，点“重试恢复”。';
  }
  if (instance.activationState === 'error' || instance.runtimeState === 'crashed') {
    return '接收服务已停止。确认飞书授权有效、同一应用没有被其他机器占用后，点“修复”重试。';
  }
  if (instance.activationState === 'disabled') return '已安装，尚未接收新生成的飞书会议纪要。';
  if (instance.runtimeState === 'healthy') return '正在等待飞书生成新的智能纪要或文字稿。';
  if (instance.runtimeState === 'degraded') return '连接仍在运行，但最近一次接收失败；展开状态会自动刷新。';
  return '正在连接飞书会议纪要服务…';
}

function historyImportTarget(plugin: OfficialPluginInfo, ownerAuthConnected: boolean) {
  const instance = plugin.instance;
  if (
    plugin.catalogId !== 'feishu-meeting-intake' ||
    !instance ||
    plugin.updateAvailable ||
    !ownerAuthConnected ||
    instance.activationState !== 'enabled' ||
    instance.runtimeState !== 'healthy'
  ) {
    return undefined;
  }
  return {
    instanceId: instance.pluginInstanceId,
    expectedRevision: instance.lifecycleRevision,
  };
}

export function OfficialPluginCard({
  plugin,
  busy,
  onAction,
  onCatchUp,
}: {
  plugin: OfficialPluginInfo;
  busy: boolean;
  onAction: (action: OfficialPluginAction) => void;
  onCatchUp: (action: OfficialPluginCatchUpAction, fingerprint?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealAuth = useCallback(() => setExpanded(true), []);
  const ownerAuth = useOfficialPluginOwnerAuth({
    available: plugin.ownerAuthAvailable,
    ...(plugin.instance === null ? {} : { instanceId: plugin.instance.pluginInstanceId }),
    onWaiting: revealAuth,
  });
  const pluginStatus = status(plugin);
  const activation = plugin.instance?.activationState;
  const failed = activation === 'error' || plugin.instance?.runtimeState === 'crashed';
  const eventBusConflict = failed && plugin.instance?.lastRuntimeError?.code === 'EVENT_BUS_CONFLICT';
  const resumeFailed = failed && maintenanceResumeFailure(plugin);
  const transitioning =
    activation === 'enabling' ||
    activation === 'disabling' ||
    plugin.instance?.runtimeState === 'starting' ||
    plugin.instance?.runtimeState === 'handshaking';
  const enabled = activation === 'enabled' || activation === 'enabling';
  const intakeBlocked = plugin.intakeHealth?.warning !== undefined;
  const canUpdate =
    plugin.updateAvailable && plugin.instance !== null && activation !== 'enabling' && activation !== 'disabling';
  const historyImport = historyImportTarget(plugin, ownerAuth.connected);
  return (
    <article className={settingsResourceCardClass}>
      <div className={`${settingsResourceRowClass} w-full`}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label="查看飞书会议纪要同步详情"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <div
            className={settingsResourceAvatarClass}
            style={{ backgroundColor: 'var(--conn-feishu-bg)', color: 'var(--cafe-surface)' }}
          >
            <HubIcon name="video" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
              飞书会议纪要同步
            </SettingsText>
            <SettingsText as="p" tone="secondary" className="mt-0.5">
              自动接收飞书生成的智能纪要和文字稿，交给猫猫整理
            </SettingsText>
          </div>
          <ChevronIcon expanded={expanded} className="h-3.5 w-3.5 shrink-0 text-cafe-muted" />
        </button>
        <div className={settingsResourceActionGroupClass}>
          <SettingsBadge tone={pluginStatus.tone} className="shrink-0 font-medium">
            {pluginStatus.label}
          </SettingsBadge>
          {!plugin.instance && (
            <SettingsPrimaryButton disabled={busy} onClick={() => onAction('install')}>
              {busy ? '安装中…' : '安装'}
            </SettingsPrimaryButton>
          )}
          {plugin.instance && canUpdate && (
            <SettingsPrimaryButton disabled={busy} onClick={() => onAction('update')}>
              {busy ? '更新中…' : `更新到 ${plugin.availableVersion}`}
            </SettingsPrimaryButton>
          )}
          {plugin.instance && !canUpdate && !ownerAuth.connected && (
            <OfficialPluginOwnerAuthAction
              auth={ownerAuth.auth}
              busy={ownerAuth.busy}
              pluginBusy={busy}
              onStart={() => void ownerAuth.start()}
            />
          )}
          {plugin.instance && !canUpdate && ownerAuth.connected && failed && (
            <SettingsSecondaryButton
              disabled={busy}
              onClick={() => onAction(eventBusConflict || resumeFailed ? 'enable' : 'repair')}
            >
              {eventBusConflict ? '重试连接' : resumeFailed ? '重试恢复' : '修复'}
            </SettingsSecondaryButton>
          )}
          {plugin.instance && !canUpdate && ownerAuth.connected && !failed && (!intakeBlocked || enabled) && (
            <SettingsResourceToggleSwitch
              enabled={enabled}
              busy={busy || transitioning}
              ariaLabel={`${enabled ? '停用' : '启用'}飞书会议纪要同步`}
              ariaPressed={enabled}
              onClick={(event) => {
                event.stopPropagation();
                onAction(enabled ? 'disable' : 'enable');
              }}
            />
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-[var(--console-border-soft)] px-4 py-3">
          <SettingsText as="p" tone="secondary">
            {guidance(plugin, ownerAuth.auth)}
          </SettingsText>
          {plugin.ownerAuthAvailable && <OfficialPluginOwnerAuthDetails auth={ownerAuth.auth} />}
          <OfficialPluginCatchUp
            health={plugin.intakeHealth}
            updateAvailable={plugin.updateAvailable}
            busy={busy}
            onAction={onCatchUp}
          />
          {historyImport && <OfficialPluginHistoryImport {...historyImport} />}
          {failed && !plugin.ownerAuthAvailable && !eventBusConflict && (
            <SettingsText as="p" tone="muted" className="mt-1">
              请确认飞书账号授权有效，再点“修复”。
            </SettingsText>
          )}
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <SettingsText as="p" tone="muted">
                {plugin.instance
                  ? `${plugin.packageName} · 已安装 ${plugin.instance.installedVersion ?? '未知版本'}`
                  : `${plugin.packageName} · 可用 ${plugin.availableVersion}`}
              </SettingsText>
              <SettingsText as="p" tone="muted" className="mt-0.5 break-all font-mono">
                {(plugin.instance?.packageDigest ?? plugin.packageDigest).slice(0, 16)}…
              </SettingsText>
              {plugin.instance && plugin.updateAvailable && (
                <SettingsText as="p" tone="muted" className="mt-1">
                  可用 {plugin.availableVersion}
                </SettingsText>
              )}
            </div>
            {plugin.instance && (
              <SettingsDeleteButton
                disabled={busy}
                aria-label="卸载飞书会议纪要同步"
                onClick={() => onAction('uninstall')}
              />
            )}
          </div>
        </div>
      )}
    </article>
  );
}
