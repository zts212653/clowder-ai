'use client';

import { CLIENT_OPTIONS, type ClientId } from './hub-cat-editor.model';

export const CLIENT_ROW_1: ClientId[] = ['anthropic', 'openai', 'google', 'kimi'];
export const CLIENT_ROW_2: ClientId[] = ['opencode', 'dare', 'antigravity'];
export const FALLBACK_ANTIGRAVITY_ARGS = '. --remote-debugging-port=9000';
export const FALLBACK_ANTIGRAVITY_MODELS = ['gemini-3.1-pro', 'claude-opus-4-6'] as const;

/** Brand colors for each cat client - aligned with CSS tokens in globals.css */
const CLIENT_BRAND_COLORS: Record<ClientValue, { primary: string; bg: string; border: string }> = {
  anthropic: { primary: '#9B7EBD', bg: '#F3EAF8', border: '#D4C1EC' },
  openai: { primary: '#5B8C5A', bg: '#EAF6EA', border: '#8FB98E' },
  google: { primary: '#5B9BD5', bg: '#EAF4FB', border: '#9CC0E7' },
  kimi: { primary: '#4B5563', bg: '#F9FAFB', border: '#E5E7EB' },
  dare: { primary: '#D4A76A', bg: '#FBF5EC', border: '#E8C99B' },
  opencode: { primary: '#8B5CF6', bg: '#F3E8FF', border: '#C4B5FD' },
  antigravity: { primary: '#F97316', bg: '#FFF7ED', border: '#FED7AA' },
};

/** Avatar paths for each cat client */
const CLIENT_AVATARS: Record<ClientValue, string> = {
  anthropic: '/avatars/opus.png',
  openai: '/avatars/codex.png',
  google: '/avatars/gemini.png',
  kimi: '/avatars/kimi.png',
  dare: '/avatars/dare.png',
  opencode: '/avatars/opencode.png',
  antigravity: '/avatars/antigravity.png',
};

function cardClass(selected: boolean, client?: ClientValue) {
  if (!selected) {
    return 'border-[#E8DCCF] bg-[#F7F3F0] text-[#5C4B42] hover:border-[#D9C0A8]';
  }
  const colors = client ? CLIENT_BRAND_COLORS[client] : null;
  if (colors) {
    return `border-[${colors.primary}] bg-[${colors.bg}] text-[${colors.primary}] shadow-sm`;
  }
  return 'border-[#D49266] bg-[#F7EEE6] text-[#D49266] shadow-sm';
}

export function clientLabel(client: ClientId) {
  return CLIENT_OPTIONS.find((option) => option.value === client)?.label ?? client;
}

export function clientSubtitle(client: ClientValue) {
  return CLIENT_OPTIONS.find((option) => option.value === client)?.subtitle;
}

export function ChoiceButton({
  label,
  subtitle,
  selected,
  onClick,
  client,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
  client?: ClientValue;
}) {
  const colors = client && selected ? CLIENT_BRAND_COLORS[client] : null;
  const avatar = client ? CLIENT_AVATARS[client] : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[74px] w-full rounded-[14px] border px-4 py-3 text-left transition ${cardClass(selected, client)}`}
      style={
        colors
          ? {
              borderColor: colors.primary,
              backgroundColor: colors.bg,
              color: colors.primary,
            }
          : undefined
      }
    >
      <div className="flex items-center gap-3">
        {avatar && <img src={avatar} alt={label} className="h-10 w-10 rounded-full object-cover" />}
        <div className="flex-1">
          <div className="font-bold">{label}</div>
          {subtitle ? <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 opacity-80">{subtitle}</div> : null}
        </div>
      </div>
    </button>
  );
}

export function PillChoiceButton({
  label,
  subtitle,
  selected,
  onClick,
  client,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
  client?: ClientValue;
}) {
  const colors = client && selected ? CLIENT_BRAND_COLORS[client] : null;
  const avatar = client ? CLIENT_AVATARS[client] : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[12px] border px-4 py-[10px] text-sm font-semibold transition ${cardClass(selected, client)}`}
      style={
        colors
          ? {
              borderColor: colors.primary,
              backgroundColor: colors.bg,
              color: colors.primary,
            }
          : undefined
      }
    >
      <div className="flex items-center gap-2">
        {avatar && <img src={avatar} alt={label} className="h-5 w-5 rounded-full object-cover" />}
        <span>{label}</span>
      </div>
      {subtitle && selected && <div className="mt-1 text-[11px] font-normal opacity-80">{subtitle}</div>}
    </button>
  );
}

export function ModelPillButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[10px] border px-[14px] py-2 text-[13px] font-semibold transition ${
        selected
          ? 'border-[#9D7BC7] bg-[#F3E8FF] text-[#9D7BC7] shadow-sm'
          : 'border-[#E8DCCF] bg-[#F7F3F0] text-[#8A776B] hover:border-[#D9C0A8]'
      }`}
    >
      {label}
    </button>
  );
}
