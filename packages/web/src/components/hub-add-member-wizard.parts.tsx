'use client';

import { CLIENT_OPTIONS, type ClientValue } from './hub-cat-editor.model';

export const CLIENT_ROW_1: ClientValue[] = ['anthropic', 'openai', 'google'];
export const CLIENT_ROW_2: ClientValue[] = ['opencode', 'dare', 'antigravity'];
export const FALLBACK_ANTIGRAVITY_ARGS = '. --remote-debugging-port=9000';

function cardClass(selected: boolean) {
  return selected
    ? 'border-[#D49266] bg-[#FFF2E7] text-[#A85E2C] shadow-sm'
    : 'border-[#E8DCCF] bg-white/80 text-[#5C4B42] hover:border-[#D9C0A8]';
}

export function clientLabel(client: ClientValue) {
  return CLIENT_OPTIONS.find((option) => option.value === client)?.label ?? client;
}

export function StepBadge({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  const className = active
    ? 'border-[#D49266] bg-[#FFF2E7] text-[#A85E2C]'
    : done
      ? 'border-[#DCE9E0] bg-[#F2FAF4] text-[#5D7A61]'
      : 'border-[#E8DCCF] bg-white/80 text-[#8A776B]';
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${className}`}>{label}</span>;
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
      className={`rounded-2xl border px-4 py-3 text-left transition ${cardClass(selected)}`}
    >
      <div className="font-semibold">{label}</div>
      {subtitle ? <div className="mt-1 text-xs opacity-80">{subtitle}</div> : null}
    </button>
  );
}
