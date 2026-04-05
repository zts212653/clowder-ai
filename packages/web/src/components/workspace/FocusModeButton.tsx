'use client';

interface FocusModeButtonProps {
  label?: string;
  onClick: () => void;
}

export function FocusModeButton({ label = '专注模式', onClick }: FocusModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-cocreator-primary/10 text-cocreator-primary border border-cocreator-primary/20 hover:bg-cocreator-primary/15 transition-colors"
    >
      {label}
    </button>
  );
}
