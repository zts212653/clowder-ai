'use client';

import { CLIENT_OPTIONS, type ClientValue } from './hub-cat-editor.model';

export const CLIENT_ROW_1: ClientValue[] = ['anthropic', 'openai', 'google'];
export const CLIENT_ROW_2: ClientValue[] = ['opencode', 'dare', 'antigravity'];
export const FALLBACK_ANTIGRAVITY_ARGS = '. --remote-debugging-port=9000';
export const TEMPLATE_ANTIGRAVITY_MODELS = ['gemini-3.1-pro', 'claude-opus-4-6'] as const;

function cardClass(selected: boolean) {
  return selected
    ? 'border-[#D49266] bg-[#FFF2E7] text-[#A85E2C] shadow-sm'
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
      className={`min-h-[86px] w-full rounded-2xl border px-4 py-3 text-left transition ${cardClass(selected)}`}
    >
      <div className="font-semibold">{label}</div>
      {subtitle ? <div className="mt-1 text-xs opacity-80">{subtitle}</div> : null}
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
      className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${cardClass(selected)}`}
    >
      {label}
    </button>
  );
}
