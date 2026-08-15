import { useCallback, useState } from 'react';
import { ChevronIcon, HubIcon } from '../hub-icons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
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
  lifecycleState: 'installed' | 'retired';
  configReadiness: 'incomplete' | 'ready';
  activationState: 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error';
  runtimeState: 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
  lifecycleRevision: number;
  installedAt: number;
  updatedAt: number;
}

export interface OfficialPluginInfo {
  catalogId: string;
  packageName: string;
  version: string;
  pluginId: string;
  packageDigest: string;
  effectiveGrants: string[];
  ownerAuthAvailable: boolean;
  instance: OfficialPluginInstance | null;
}

export type OfficialPluginAction = 'install' | 'enable' | 'disable' | 'repair' | 'uninstall';

function status(plugin: OfficialPluginInfo): { label: string; tone: 'emerald' | 'amber' | 'slate' | 'red' } {
  const instance = plugin.instance;
  if (!instance) return { label: '未安装', tone: 'slate' };
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
  const authCopy = plugin.ownerAuthAvailable ? ownerAuthGuidance(auth) : undefined;
  if (authCopy) return authCopy;
  if (instance.activationState === 'error' || instance.runtimeState === 'crashed') {
    return '接收服务已停止。确认飞书授权有效、同一应用没有被其他机器占用后，点“修复”重试。';
  }
  if (instance.activationState === 'disabled') return '已安装，尚未接收新生成的飞书会议纪要。';
  if (instance.runtimeState === 'healthy') return '正在等待飞书生成新的智能纪要或文字稿。';
  if (instance.runtimeState === 'degraded') return '连接仍在运行，但最近一次接收失败；展开状态会自动刷新。';
  return '正在连接飞书会议纪要服务…';
}

export function OfficialPluginCard({
  plugin,
  busy,
  onAction,
}: {
  plugin: OfficialPluginInfo;
  busy: boolean;
  onAction: (action: OfficialPluginAction) => void;
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
  const transitioning =
    activation === 'enabling' ||
    activation === 'disabling' ||
    plugin.instance?.runtimeState === 'starting' ||
    plugin.instance?.runtimeState === 'handshaking';
  const enabled = activation === 'enabled' || activation === 'enabling';
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
          {plugin.instance && !ownerAuth.connected && (
            <OfficialPluginOwnerAuthAction
              auth={ownerAuth.auth}
              busy={ownerAuth.busy}
              pluginBusy={busy}
              onStart={() => void ownerAuth.start()}
            />
          )}
          {plugin.instance && ownerAuth.connected && failed && (
            <SettingsSecondaryButton disabled={busy} onClick={() => onAction('repair')}>
              修复
            </SettingsSecondaryButton>
          )}
          {plugin.instance && ownerAuth.connected && !failed && (
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
          {failed && !plugin.ownerAuthAvailable && (
            <SettingsText as="p" tone="muted" className="mt-1">
              请确认飞书账号授权有效，再点“修复”。
            </SettingsText>
          )}
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <SettingsText as="p" tone="muted">
                {plugin.packageName} · {plugin.version}
              </SettingsText>
              <SettingsText as="p" tone="muted" className="mt-0.5 break-all font-mono">
                {plugin.packageDigest.slice(0, 16)}…
              </SettingsText>
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
