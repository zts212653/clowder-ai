import Image from 'next/image';
import { ChevronIcon } from '../hub-icons';
import {
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import {
  PersonalChromeAuthorizationList,
  type PersonalChromeAuthorizedConversation,
} from './PersonalChromeAuthorizationList';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsDeleteButton } from './primitives/SettingsDeleteButton';
import { SettingsPrimaryButton } from './primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from './primitives/SettingsSecondaryButton';
import { SettingsText } from './primitives/SettingsText';

export interface PersonalChromePluginState {
  pluginId: 'personal-chrome-host';
  channel: 'developer_preview';
  platform: string;
  platformSupport: 'supported' | 'unsupported';
  artifact: {
    helper: 'absent' | 'ready' | 'invalid' | 'unsupported';
    extension: 'chrome_web_store';
  };
  distribution: {
    channel: 'chrome_web_store';
    integration: 'ready';
    publication: 'unavailable' | 'published' | 'invalid';
    listingUrl?: string;
    blockerCode?: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED' | 'CHROME_WEB_STORE_LISTING_INVALID';
  };
  config: { status: 'absent' | 'ready' | 'invalid' | 'unsupported' };
  authorization: {
    status: 'empty' | 'authorized' | 'invalid' | 'unsupported';
    count: number;
    limit: number;
    conversations: PersonalChromeAuthorizedConversation[];
  };
  intent: { status: 'developer_preview' };
  live: { status: 'dormant' | 'connected' | 'degraded' | 'unsupported' };
}

export type PersonalChromePluginAction = 'install' | 'repair' | 'uninstall';

function visibleStatus(state: PersonalChromePluginState) {
  if (state.platformSupport === 'unsupported') return { label: '当前系统暂不支持', tone: 'slate' as const };
  if (state.artifact.helper === 'invalid' || state.config.status === 'invalid') {
    return { label: '需修复', tone: 'red' as const };
  }
  if (state.authorization.status === 'invalid') return { label: '授权记录损坏', tone: 'red' as const };
  if (state.live.status === 'degraded') return { label: '连接异常', tone: 'red' as const };
  if (state.distribution.publication !== 'published') return { label: '待发布', tone: 'amber' as const };
  if (state.artifact.helper === 'absent') return { label: '未安装', tone: 'slate' as const };
  if (state.authorization.status === 'empty') return { label: '待授权', tone: 'amber' as const };
  if (state.live.status === 'connected') return { label: '已连接', tone: 'emerald' as const };
  return { label: `${state.authorization.count} 个已授权`, tone: 'blue' as const };
}

function axisLabel(label: string, value: string) {
  return (
    <div className="flex items-center justify-between gap-3">
      <SettingsText tone="muted">{label}</SettingsText>
      <SettingsText tone="secondary" className="font-medium">
        {value}
      </SettingsText>
    </div>
  );
}

function PublicationNotice({ state }: { state: PersonalChromePluginState }) {
  if (state.distribution.publication === 'published') {
    return (
      <div className="rounded-lg bg-[var(--console-hover-bg)] px-3 py-2">
        <SettingsText as="p" tone="secondary">
          一次安装会准备本机组件并打开 Chrome Web Store；只保留 Chrome 原生的“添加扩展/权限”确认。
        </SettingsText>
        <a
          href={state.distribution.listingUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs font-medium text-cafe-interactive hover:underline"
        >
          在 Chrome Web Store 查看
        </a>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-3 py-2">
      <SettingsText as="p" tone="amber">
        发布集成已就绪，但扩展尚未公开发布。
      </SettingsText>
      <SettingsText as="p" tone="secondary" className="mt-1">
        阻塞：
        {state.distribution.publication === 'invalid'
          ? 'Chrome Web Store listing 配置无效。'
          : '缺少已发布的 Chrome Web Store listing URL 或发布权限。'}
      </SettingsText>
    </div>
  );
}

export function PersonalChromePluginCard({
  state,
  expanded,
  busy,
  onToggleDetails,
  onAction,
  onRevoke,
}: {
  state: PersonalChromePluginState;
  expanded: boolean;
  busy: boolean;
  onToggleDetails: () => void;
  onAction: (action: PersonalChromePluginAction) => void;
  onRevoke: (conversationId: string) => void;
}) {
  const status = visibleStatus(state);
  const repairable =
    state.platformSupport === 'supported' && (state.artifact.helper === 'invalid' || state.config.status === 'invalid');
  const installed = state.artifact.helper === 'ready' || state.artifact.helper === 'invalid';
  const installable =
    state.platformSupport === 'supported' &&
    state.artifact.helper === 'absent' &&
    state.distribution.publication === 'published';

  return (
    <article className={settingsResourceCardClass} data-testid="personal-chrome-plugin-card">
      <div className={`${settingsResourceRowClass} w-full`}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label="查看 Personal ChatGPT Pro 详情"
          aria-expanded={expanded}
          onClick={onToggleDetails}
        >
          <div className={`${settingsResourceAvatarClass} overflow-hidden`}>
            <Image
              src="/avatars/gpt-pro.png"
              alt="Personal ChatGPT Pro logo"
              width={36}
              height={36}
              unoptimized
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
              Personal ChatGPT Pro
            </SettingsText>
            <SettingsText as="p" tone="secondary" className="mt-0.5">
              将已授权的 ChatGPT 会话作为个人云端猫通道
            </SettingsText>
          </div>
          <ChevronIcon expanded={expanded} className="h-3.5 w-3.5 shrink-0 text-cafe-muted" />
        </button>
        <div className={settingsResourceActionGroupClass}>
          <SettingsBadge tone={status.tone} className="shrink-0 font-medium">
            {status.label}
          </SettingsBadge>
          {installable && (
            <SettingsPrimaryButton disabled={busy} onClick={() => onAction('install')}>
              {busy ? '安装中…' : '安装'}
            </SettingsPrimaryButton>
          )}
          {repairable && (
            <SettingsSecondaryButton disabled={busy} onClick={() => onAction('repair')}>
              {busy ? '修复中…' : '修复'}
            </SettingsSecondaryButton>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-[var(--console-border-soft)] px-4 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SettingsBadge tone="purple">开发者预览</SettingsBadge>
            <SettingsText tone="muted">macOS / Linux；Windows 当前不支持</SettingsText>
          </div>
          {state.platformSupport === 'supported' && <PublicationNotice state={state} />}
          {state.platformSupport === 'supported' && state.authorization.status === 'invalid' && (
            <div className="mt-3 rounded-lg border border-conn-red-ring bg-conn-red-bg px-3 py-2">
              <SettingsText as="p" tone="red">
                授权记录损坏。为避免误投，损坏记录不会发送也不会被新授权覆盖；请卸载后重新安装并授权。
              </SettingsText>
            </div>
          )}
          {state.platformSupport === 'supported' && state.authorization.status !== 'invalid' && (
            <PersonalChromeAuthorizationList
              conversations={state.authorization.conversations}
              count={state.authorization.count}
              limit={state.authorization.limit}
              busy={busy}
              onRevoke={onRevoke}
            />
          )}
          <div className="mt-3 grid gap-1.5">
            {axisLabel('本机组件', state.artifact.helper)}
            {axisLabel('扩展发布', state.distribution.publication)}
            {axisLabel('会话授权', `${state.authorization.count}/${state.authorization.limit}`)}
            {axisLabel('实时连接', state.live.status)}
          </div>
          {installed && state.platformSupport === 'supported' && (
            <div className="mt-3 flex justify-end">
              <SettingsDeleteButton
                disabled={busy}
                aria-label="卸载 Personal ChatGPT Pro"
                onClick={() => onAction('uninstall')}
              />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
