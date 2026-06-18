import type { DragEvent as ReactDragEvent } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { CO_CREATOR_COLOR } from '@/lib/color-defaults';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import type { CatConfig, CoCreatorConfig } from './config-viewer-types';
import { HubIcon } from './hub-icons';
import { SettingsResourceIconButton, SettingsResourceToggleSwitch } from './SettingsResourceCard';
import {
  SettingsBadge,
  SettingsFilterTabs,
  SettingsPrimaryButton,
  SettingsRow,
  SettingsStatusStrip,
  SettingsText,
} from './settings/primitives';

function safeAvatarSrc(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/avatars/')) return trimmed;
  return null;
}

function humanizeClientId(clientId: string) {
  if (clientId === 'openai') return 'OpenAI';
  if (clientId === 'anthropic') return 'Anthropic';
  if (clientId === 'google') return 'Gemini';
  if (clientId === 'dare') return 'Dare';
  if (clientId === 'opencode') return 'OpenCode';
  if (clientId === 'antigravity') return 'Antigravity';
  return clientId;
}

function clientRuntimeLabel(cat: CatData, configCat?: CatConfig) {
  const accountRef = (cat.accountRef ?? '').toLowerCase();
  if (accountRef.includes('claude')) return 'Claude';
  if (accountRef.includes('codex')) return 'Codex';
  if (accountRef.includes('gemini')) return 'Gemini';
  if (accountRef.includes('kimi') || accountRef.includes('moonshot')) return 'Kimi';
  if (accountRef.includes('opencode')) return 'OpenCode';
  if (accountRef.includes('dare')) return 'Dare';
  if (cat.clientId === 'antigravity') return 'Antigravity';
  if (cat.clientId === 'openai') return 'OpenAI-Compatible';
  return humanizeClientId(configCat?.clientId ?? cat.clientId);
}

function accountSummary(cat: CatData) {
  const accountRef = cat.accountRef?.trim() ?? '';
  if (!accountRef) return humanizeClientId(cat.clientId);
  if (
    accountRef === 'claude' ||
    accountRef === 'codex' ||
    accountRef === 'gemini' ||
    accountRef === 'kimi' ||
    accountRef === 'dare' ||
    accountRef === 'opencode'
  ) {
    return 'CLI（OAuth）账号';
  }
  return `CLI（配置） · ${accountRef}`;
}

function getMetaSummary(cat: CatData, configCat?: CatConfig) {
  if (cat.clientId === 'antigravity') {
    return `Antigravity · ${configCat?.model ?? cat.defaultModel} · CLI Bridge`;
  }
  return `${clientRuntimeLabel(cat, configCat)} · ${configCat?.model ?? cat.defaultModel} · ${accountSummary(cat)}`;
}

function getStatusBadge(cat: CatData): { enabled: boolean; label: string; tone: 'emerald' | 'slate' } {
  if (cat.roster?.available === false) {
    return { enabled: false, label: '已停用', tone: 'slate' };
  }
  return { enabled: true, label: '已启用', tone: 'emerald' };
}

function formatMentionPreview(patterns: string[], max = 3) {
  const visible = patterns.slice(0, max);
  const rest = patterns.length - visible.length;
  return rest > 0 ? `${visible.join('')}  +${rest}` : visible.join('');
}

function OwnerBadge() {
  return (
    <SettingsBadge tone="amber" className="inline-flex items-center gap-1">
      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
      Owner
    </SettingsBadge>
  );
}

// F206 exempt: coCreator config default colors — data-driven, not UI theme
function OwnerAvatar({ coCreator }: { coCreator: CoCreatorConfig }) {
  const primary = coCreator.color?.primary ?? CO_CREATOR_COLOR.primary;
  const avatarSrc = safeAvatarSrc(coCreator.avatar);
  return (
    <div
      className="flex h-8 w-8 items-center justify-center overflow-hidden text-xs font-bold"
      style={{ backgroundColor: primary, color: 'var(--cafe-surface)', borderRadius: '9999px' }}
    >
      {avatarSrc ? (
        <AvatarImageWithFallback
          src={avatarSrc}
          alt={`${coCreator.name} avatar`}
          className="h-full w-full object-cover"
        />
      ) : (
        'ME'
      )}
    </div>
  );
}

export function HubCoCreatorOverviewCard({ coCreator, onEdit }: { coCreator: CoCreatorConfig; onEdit?: () => void }) {
  const primary = coCreator.color?.primary ?? CO_CREATOR_COLOR.primary;
  return (
    <SettingsRow
      icon={<OwnerAvatar coCreator={coCreator} />}
      title={coCreator.name}
      meta={
        <>
          <span>别名: {coCreator.aliases.join(' · ') || '无'} · 只能编辑，不能新增或删除</span>
          <span className="mt-0.5 block" style={{ color: primary }}>
            {formatMentionPreview(coCreator.mentionPatterns, 2)}
          </span>
        </>
      }
      badges={<OwnerBadge />}
      onClick={onEdit}
    />
  );
}

const MEMBER_FILTER_TABS = [
  { key: '全部', label: '全部' },
  { key: '已启用', label: '已启用' },
  { key: '已停用', label: '已停用' },
  { key: 'oauth', label: 'CLI（OAuth）' },
  { key: 'api_key', label: 'CLI（配置）' },
];

export function HubOverviewToolbar({
  onAddMember,
  activeFilter,
  onFilterChange,
}: {
  onAddMember?: () => void;
  activeFilter?: string;
  onFilterChange?: (key: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {onFilterChange ? (
        <SettingsFilterTabs tabs={MEMBER_FILTER_TABS} activeKey={activeFilter ?? '全部'} onTabChange={onFilterChange} />
      ) : (
        <SettingsStatusStrip tone="muted">全部 · 已启用 · 已停用 · CLI（OAuth） · CLI（配置）</SettingsStatusStrip>
      )}
      {onAddMember && (
        <SettingsPrimaryButton
          onClick={onAddMember}
          data-bootcamp-step="add-member-button"
          data-guide-id="cats.add-member"
        >
          + 添加成员
        </SettingsPrimaryButton>
      )}
    </div>
  );
}

function AvailabilityToggle({
  cat,
  enabled,
  onToggle,
  busy,
}: {
  cat: CatData;
  enabled: boolean;
  onToggle?: (cat: CatData) => void;
  busy: boolean;
}) {
  if (!onToggle) return null;
  const label = enabled ? '停用成员' : '启用成员';
  return (
    <SettingsResourceToggleSwitch
      enabled={enabled}
      busy={busy}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(cat);
      }}
      title={`${label}：${cat.displayName}`}
      ariaLabel={`${label}：${cat.displayName}`}
    />
  );
}

function MemberMeta({ cat, configCat }: { cat: CatData; configCat?: CatConfig }) {
  const sessionChainEnabled = cat.sessionChain !== false;
  return (
    <>
      <span>
        <SettingsText tone="muted" className="mr-1.5 font-mono text-[10px]">
          {cat.id}
        </SettingsText>
        {getMetaSummary(cat, configCat)}
        {cat.adapterMode && (
          <SettingsBadge
            tone={cat.adapterMode === 'acp' ? 'emerald' : 'slate'}
            size="xxs"
            className="ml-1.5 inline-block"
          >
            {cat.adapterMode.toUpperCase()}
          </SettingsBadge>
        )}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-2">
        <SettingsText tone="purple">{formatMentionPreview(cat.mentionPatterns)}</SettingsText>
        <SettingsBadge tone={sessionChainEnabled ? 'emerald' : 'slate'}>
          {sessionChainEnabled ? 'Session Chain 已开启' : 'Session Chain 未开启'}
        </SettingsBadge>
      </span>
    </>
  );
}

export function HubMemberOverviewCard({
  cat,
  configCat,
  onEdit,
  onToggleAvailability,
  onDelete,
  togglingAvailability = false,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging = false,
  guideTargetId,
}: {
  cat: CatData;
  configCat?: CatConfig;
  onEdit?: (cat: CatData) => void;
  onToggleAvailability?: (cat: CatData) => void;
  onDelete?: (cat: CatData) => void;
  togglingAvailability?: boolean;
  draggable?: boolean;
  onDragStart?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDragOver?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  isDragging?: boolean;
  guideTargetId?: string;
}) {
  const status = getStatusBadge(cat);
  const title = [cat.breedDisplayName ?? cat.displayName, cat.nickname].filter(Boolean).join(' · ');

  return (
    <SettingsRow
      data-testid={`cat-card-${cat.id}`}
      data-guide-id={guideTargetId}
      draggable={draggable}
      onDragStart={draggable ? (event) => onDragStart?.(cat, event) : undefined}
      onDragOver={draggable ? (event) => onDragOver?.(cat, event) : undefined}
      onDrop={draggable ? (event) => onDrop?.(cat, event) : undefined}
      onDragEnd={draggable ? (event) => onDragEnd?.(cat, event) : undefined}
      onClick={() => onEdit?.(cat)}
      isDragging={isDragging}
      dragHandle={
        draggable ? (
          <span aria-hidden="true" title="拖动排序" className="select-none leading-none text-lg">
            ⠿
          </span>
        ) : undefined
      }
      title={title}
      meta={<MemberMeta cat={cat} configCat={configCat} />}
      badges={<SettingsBadge tone={status.tone}>{status.label}</SettingsBadge>}
      actions={
        <>
          <AvailabilityToggle
            cat={cat}
            enabled={status.enabled}
            onToggle={onToggleAvailability}
            busy={togglingAvailability}
          />
          {onDelete && (
            <SettingsResourceIconButton
              tone="danger"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(cat);
              }}
              title="删除成员"
              aria-label="删除成员"
            >
              <HubIcon name="trash" className="h-3.5 w-3.5" />
            </SettingsResourceIconButton>
          )}
        </>
      }
      tone={status.enabled ? 'active' : 'inactive'}
    />
  );
}
