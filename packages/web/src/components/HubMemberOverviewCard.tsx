import type { CatData } from '@/hooks/useCatData';
import type { CatConfig, CoCreatorConfig } from './config-viewer-types';

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
  if (cat.source === 'runtime' && cat.clientId === 'openai') return 'OpenAI-Compatible';
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
    return 'CLI（内置）账号';
  }
  return `CLI（配置） · ${accountRef}`;
}

function getMetaSummary(cat: CatData, configCat?: CatConfig) {
  if (cat.clientId === 'antigravity') {
    return `Antigravity · ${configCat?.model ?? cat.defaultModel} · CLI Bridge`;
  }

  return `${clientRuntimeLabel(cat, configCat)} · ${configCat?.model ?? cat.defaultModel} · ${accountSummary(cat)}`;
}

function getStatusBadge(cat: CatData) {
  if (cat.roster?.available === false) {
    return {
      enabled: false,
      label: '未启用',
      className: 'bg-slate-100 text-slate-600',
    };
  }
  return {
    enabled: true,
    label: '已启用',
    className: 'bg-[#E8F5E9] text-[#4CAF50]',
  };
}

function formatMentionPreview(patterns: string[], max = 3) {
  const visible = patterns.slice(0, max);
  const rest = patterns.length - visible.length;
  return rest > 0 ? `${visible.join('  ')}  +${rest}` : visible.join('  ');
}

export function HubCoCreatorOverviewCard({ coCreator, onEdit }: { coCreator: CoCreatorConfig; onEdit?: () => void }) {
  const primary = coCreator.color?.primary ?? '#D4A76A';
  const secondary = coCreator.color?.secondary ?? '#FFF8F0';
  const avatarSrc = safeAvatarSrc(coCreator.avatar);

  return (
    <section
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onClick={() => onEdit?.()}
      onKeyDown={(event) => {
        if (!onEdit) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit();
        }
      }}
      className="rounded-[20px] px-[18px] py-[18px] shadow-sm"
      style={{ backgroundColor: secondary, border: `2px solid ${primary}` }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white"
            style={{ backgroundColor: primary }}
          >
            {avatarSrc ? (
              // biome-ignore lint/performance/noImgElement: co-creator avatar may be runtime upload URL
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarSrc} alt={`${coCreator.name} avatar`} className="h-full w-full object-cover" />
            ) : (
              'ME'
            )}
          </div>
          <h3 className="text-base font-bold text-[#2D2118]">{coCreator.name}</h3>
        </div>
        <span className="rounded-full bg-[#FFF3E0] px-2.5 py-1 text-[11px] font-semibold text-[#E65100] flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
            />
          </svg>
          Owner
        </span>
      </div>
      <p className="mt-2.5 text-[13px] text-[#8A776B]">
        别名: {coCreator.aliases.join(' · ') || '无'} · 只能编辑，不能新增或删除
      </p>
      <p className="mt-2 text-[13px]" style={{ color: primary }}>
        {formatMentionPreview(coCreator.mentionPatterns, 2)}
      </p>
    </section>
  );
}

export function HubOverviewToolbar({ onAddMember }: { onAddMember?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-[#8F8075]">全部 · CLI（内置） · CLI（配置） · 未启用</p>
      <button
        type="button"
        onClick={onAddMember}
        className="rounded-full px-4 py-2 text-sm font-bold text-white"
        style={{ backgroundColor: '#D49266' }}
      >
        + 添加成员
      </button>
    </div>
  );
}

export function HubMemberOverviewCard({
  cat,
  configCat,
  onEdit,
  onToggleAvailability,
  togglingAvailability = false,
}: {
  cat: CatData;
  configCat?: CatConfig;
  onEdit?: (cat: CatData) => void;
  onToggleAvailability?: (cat: CatData) => void;
  togglingAvailability?: boolean;
}) {
  const status = getStatusBadge(cat);
  const title = [cat.breedDisplayName ?? cat.displayName, cat.nickname].filter(Boolean).join(' · ');

  return (
    <section
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onClick={() => onEdit?.(cat)}
      onKeyDown={(event) => {
        if (!onEdit) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit(cat);
        }
      }}
      className="rounded-[20px] px-[18px] py-[18px] shadow-sm transition hover:shadow-md"
      style={{ backgroundColor: '#FFFDFC', border: `1px solid ${cat.source === 'runtime' ? '#D9C7EA' : '#F1E7DF'}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[17px] font-bold text-[#2D2118]">{title}</h3>
            {cat.source === 'runtime' ? (
              <span className="rounded-full bg-[#F3E8FF] px-2 py-0.5 text-[11px] font-semibold text-[#9D7BC7]">
                动态创建
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleAvailability?.(cat);
          }}
          disabled={!onToggleAvailability || togglingAvailability}
          aria-pressed={status.enabled}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${status.className} disabled:cursor-default`}
        >
          {togglingAvailability ? '切换中...' : status.label}
        </button>
      </div>

      <p className="mt-2.5 text-[13px] text-[#8A776B]">
        {getMetaSummary(cat, configCat)}
        {cat.adapterMode ? (
          <span
            className={`ml-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              cat.adapterMode === 'acp' ? 'bg-[#E8F5E9] text-[#4CAF50]' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {cat.adapterMode.toUpperCase()}
          </span>
        ) : null}
      </p>

      <p className="mt-2 text-[13px] text-[#9D7BC7]">{formatMentionPreview(cat.mentionPatterns)}</p>
    </section>
  );
}
