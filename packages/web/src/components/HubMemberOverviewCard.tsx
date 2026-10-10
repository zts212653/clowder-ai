import type { DragEvent as ReactDragEvent } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { CO_CREATOR_COLOR } from '@/lib/color-defaults';
import { readableInkOn } from '@/lib/readable-ink';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import type { CatConfig, CoCreatorConfig } from './config-viewer-types';
import { HubIcon } from './hub-icons';
import { MemberAvailabilityToggle } from './MemberAvailabilityToggle';
import { SettingsResourceIconButton } from './SettingsResourceCard';
import {
  SettingsBadge,
  SettingsFilterTabs,
  SettingsPrimaryButton,
  SettingsRow,
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
  if (clientId === 'opencode') return 'OpenCode';
  if (clientId === 'antigravity') return 'Antigravity';
  return clientId;
}

function clientRuntimeLabel(cat: CatData, configCat?: CatConfig) {
  if (cat.configurationSource === 'native_tool' && cat.acp)
    return /dsh|deepseek/i.test(JSON.stringify(cat.acp)) ? 'DSH' : 'ACP 工具';
  if (cat.configurationSource === 'native_tool')
    return cat.clientId === 'openai'
      ? 'Codex'
      : cat.clientId === 'anthropic'
        ? 'Claude Code'
        : /dsh|deepseek/i.test(JSON.stringify(cat.acp))
          ? 'DSH'
          : 'ACP 工具';
  const accountRef = (cat.accountRef ?? '').toLowerCase();
  if (accountRef.includes('claude')) return 'Claude';
  if (accountRef.includes('codex')) return 'Codex';
  if (accountRef.includes('gemini')) return 'Gemini';
  if (accountRef.includes('kimi') || accountRef.includes('moonshot')) return 'Kimi';
  if (accountRef.includes('opencode')) return 'OpenCode';
  if (cat.clientId === 'antigravity') return 'Antigravity';
  if (cat.clientId === 'openai') return 'OpenAI-Compatible';
  return humanizeClientId(configCat?.clientId ?? cat.clientId);
}

function accountSummary(cat: CatData) {
  if (cat.configurationSource === 'native_tool') return cat.accountRef?.trim() || '';
  const accountRef = cat.accountRef?.trim() ?? '';
  if (!accountRef) return humanizeClientId(cat.clientId);
  if (
    accountRef === 'claude' ||
    accountRef === 'codex' ||
    accountRef === 'gemini' ||
    accountRef === 'kimi' ||
    accountRef === 'opencode'
  ) {
    return 'CLI（OAuth）账号';
  }
  return `CLI（配置） · ${accountRef}`;
}

function getMetaSummary(cat: CatData, configCat?: CatConfig) {
  let modelLabel = cat.defaultModel;
  // DSH's [provider, model] wire value stays intact; the overview needs only the model name.
  if (cat.acp && /dsh|deepseek/i.test(JSON.stringify(cat.acp))) {
    try {
      const value: unknown = JSON.parse(cat.defaultModel);
      if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string'))
        modelLabel = value[1];
    } catch {
      /* Legacy plain model names remain readable. */
    }
  }
  if (cat.configurationSource === 'native_tool')
    return [clientRuntimeLabel(cat, configCat), modelLabel || '跟随工具模型', accountSummary(cat)]
      .filter(Boolean)
      .join(' · ');
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
  return rest > 0 ? `${visible.join(' · ')}  +${rest}` : visible.join(' · ');
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
  // The initials sit on the identity fill, so the ink is chosen from that fill: a theme surface can be as dark as the fill.
  const ink = readableInkOn(primary) ?? 'var(--cafe-surface)';
  return (
    <div
      className="flex h-8 w-8 items-center justify-center overflow-hidden text-xs font-bold"
      style={{ backgroundColor: primary, color: ink, borderRadius: '9999px' }}
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
  return (
    <SettingsRow
      icon={<OwnerAvatar coCreator={coCreator} />}
      title={coCreator.name}
      meta={
        <>
          <span>别名: {coCreator.aliases.join(' · ') || '无'} · 只能编辑，不能新增或删除</span>
          <span className="mt-0.5 block" style={{ color: 'var(--color-cocreator-text)' }}>
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
  if (!onAddMember && !onFilterChange) return null;
  return (
    <div className={`flex items-center gap-3 ${onFilterChange ? 'justify-between' : 'justify-end'}`}>
      {onFilterChange && (
        <SettingsFilterTabs tabs={MEMBER_FILTER_TABS} activeKey={activeFilter ?? '全部'} onTabChange={onFilterChange} />
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

function MemberMeta({ cat, configCat }: { cat: CatData; configCat?: CatConfig }) {
  return (
    <>
      <span>
        {getMetaSummary(cat, configCat)}
        {cat.adapterMode && cat.configurationSource !== 'native_tool' && (
          <SettingsBadge
            tone={cat.adapterMode === 'acp' || cat.codexCarrier?.effective === 'app_server' ? 'emerald' : 'slate'}
            size="xxs"
            className="ml-1.5 inline-block"
          >
            {/* F254 D2: ACP wins over the Codex carrier (assembly checks getAcpConfig first) */}
            {cat.adapterMode === 'acp'
              ? 'ACP'
              : cat.codexCarrier?.effective === 'app_server'
                ? 'APP SERVER'
                : cat.adapterMode.toUpperCase()}
          </SettingsBadge>
        )}
        {cat.identityProtection ? (
          <SettingsBadge
            tone={cat.identityProtection.state === 'healthy' ? 'emerald' : 'amber'}
            size="xxs"
            className="ml-1.5 inline-block"
          >
            {cat.identityProtection.state === 'healthy' ? '云端身份' : '云端身份异常'}
          </SettingsBadge>
        ) : null}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-2">
        <SettingsText tone="purple">{formatMentionPreview(cat.mentionPatterns)}</SettingsText>
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
      onClick={onEdit ? () => onEdit(cat) : undefined}
      onKeyDown={
        onEdit
          ? (event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onEdit(cat);
              }
            }
          : undefined
      }
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
      badges={!onToggleAvailability && <SettingsBadge tone={status.tone}>{status.label}</SettingsBadge>}
      stackActionsOnMobile
      actions={
        onToggleAvailability || (onDelete && !cat.identityProtection) ? (
          <>
            {onToggleAvailability && (
              <MemberAvailabilityToggle
                cat={cat}
                enabled={status.enabled}
                onToggle={onToggleAvailability}
                busy={togglingAvailability}
              />
            )}
            {onDelete && !cat.identityProtection && (
              <SettingsResourceIconButton
                tone="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(cat);
                }}
                title={`删除成员：${cat.displayName}`}
                aria-label={`删除成员：${cat.displayName}`}
                className="min-h-11 min-w-11"
              >
                <HubIcon name="trash" className="h-3.5 w-3.5" />
              </SettingsResourceIconButton>
            )}
          </>
        ) : undefined
      }
      tone={status.enabled ? 'active' : 'inactive'}
    />
  );
}
