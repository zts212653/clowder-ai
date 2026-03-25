'use client';

import { CLIENT_OPTIONS, type ClientValue } from './hub-cat-editor.model';

export const CLIENT_ROW_1: ClientValue[] = ['anthropic', 'openai', 'google'];
export const CLIENT_ROW_2: ClientValue[] = ['opencode', 'dare', 'relayclaw', 'antigravity'];
export const FALLBACK_ANTIGRAVITY_ARGS = '. --remote-debugging-port=9000';
export const FALLBACK_ANTIGRAVITY_MODELS = ['gemini-3.1-pro', 'claude-opus-4-6'] as const;

function cardClass(selected: boolean) {
  return selected
    ? 'border-[#D49266] bg-[#F7EEE6] text-[#D49266] shadow-sm'
    : 'border-[#E8DCCF] bg-[#F7F3F0] text-[#5C4B42] hover:border-[#D9C0A8]';
}

export function clientLabel(client: ClientValue) {
  return CLIENT_OPTIONS.find((option) => option.value === client)?.label ?? client;
}

export function ChoiceButton({
  label,
  subtitle,
  selected,
  onClick,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[74px] w-full rounded-[14px] border px-4 py-3 text-left transition ${cardClass(selected)}`}
    >
      <div className="font-bold">{label}</div>
      {subtitle ? <div className="mt-1 line-clamp-2 text-[12px] leading-5 opacity-80">{subtitle}</div> : null}
    </button>
  );
}

export function PillChoiceButton({
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
      className={`rounded-[12px] border px-4 py-[10px] text-sm font-semibold transition ${cardClass(selected)}`}
    >
      {label}
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
