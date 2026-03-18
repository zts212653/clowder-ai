import type { CatData } from '@/hooks/useCatData';
import type { CatConfig, OwnerConfig } from './config-viewer-types';

function humanizeProvider(provider: string) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'antigravity') return 'Antigravity';
  return provider;
}

function getMetaSummary(cat: CatData, configCat?: CatConfig) {
  if (cat.provider === 'antigravity') {
    return `Antigravity · ${configCat?.model ?? cat.defaultModel} · ${cat.commandArgs?.join(' ') || 'Bridge 未配置'}`;
  }

  const account = cat.providerProfileId?.includes('(OAuth)')
    ? 'OAuth 订阅'
    : cat.providerProfileId || humanizeProvider(configCat?.provider ?? cat.provider);
  return `${humanizeProvider(configCat?.provider ?? cat.provider)} · ${configCat?.model ?? cat.defaultModel} · ${account}`;
}

function getStatusBadge(cat: CatData) {
  if (cat.source === 'runtime') {
    return {
      label: '动态创建',
      className: 'bg-[#F3E8FF] text-[#9D7BC7]',
    };
  }
  if (cat.roster?.available === false) {
    return {
      label: '未启用',
      className: 'bg-slate-100 text-slate-600',
    };
  }
  return {
    label: '已启用',
    className: 'bg-[#E8F5E9] text-[#4CAF50]',
  };
}

export function HubOwnerOverviewCard({ owner }: { owner: OwnerConfig }) {
  return (
    <section
      className="rounded-[20px] px-[18px] py-[18px] shadow-sm"
      style={{ backgroundColor: '#FFF8F0', border: '2px solid #D4A76A' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white"
            style={{ backgroundColor: '#D4A76A' }}
          >
            ME
          </span>
          <h3 className="text-base font-bold text-[#2D2118]">{owner.name} (铲屎官)</h3>
        </div>
        <span className="rounded-full bg-[#FFF3E0] px-2.5 py-1 text-[11px] font-semibold text-[#E65100]">
          🔒 Owner
        </span>
      </div>
      <p className="mt-2.5 text-[13px] text-[#8A776B]">
        别名: {owner.aliases.join(' · ') || '无'} · 只能编辑，不能新增或删除
      </p>
      <p className="mt-2 text-[13px] text-[#D4A76A]">{owner.mentionPatterns.join('  ')}</p>
    </section>
  );
}

export function HubOverviewToolbar({ onAddMember }: { onAddMember?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-[#8F8075]">全部 · 订阅 · API Key · 未启用</p>
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
}: {
  cat: CatData;
  configCat?: CatConfig;
  onEdit?: (cat: CatData) => void;
}) {
  const status = getStatusBadge(cat);
  const title = [cat.breedDisplayName ?? cat.displayName, cat.nickname].filter(Boolean).join(' · ');
  const subtitleParts = [cat.id];
  if (cat.roster?.lead) subtitleParts.push('Lead');

  return (
    <section
      className="rounded-[20px] px-[18px] py-[18px] shadow-sm"
      style={{ backgroundColor: '#FFFDFC', border: `1px solid ${cat.source === 'runtime' ? '#D9C7EA' : '#F1E7DF'}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[17px] font-bold text-[#2D2118]">{title}</h3>
          <p className="mt-1 text-xs text-[#8A776B]">{subtitleParts.join(' · ')}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${status.className}`}>{status.label}</span>
      </div>

      <p className="mt-2.5 text-[13px] text-[#8A776B]">{getMetaSummary(cat, configCat)}</p>

      <p className="mt-2 text-[13px] text-[#9D7BC7]">{cat.mentionPatterns.join('  ')}</p>

      {onEdit ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => onEdit(cat)}
            className="rounded-lg bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100"
          >
            编辑成员
          </button>
        </div>
      ) : null}
    </section>
  );
}
