import type { MouseEvent, ReactNode } from 'react';

type BadgeTone = 'emerald' | 'amber' | 'slate' | 'red' | 'purple' | 'blue';

const toneStyles: Record<BadgeTone, string> = {
  emerald: 'bg-conn-emerald-bg text-conn-emerald-text',
  amber: 'bg-conn-amber-bg text-conn-amber-text',
  slate: 'bg-conn-slate-bg text-conn-slate-text',
  red: 'bg-conn-red-bg text-conn-red-text',
  purple: 'bg-conn-purple-bg text-conn-purple-text',
  blue: 'bg-conn-blue-bg text-conn-blue-text',
};

interface SettingsBadgeProps {
  tone: BadgeTone;
  size?: 'xs' | 'xxs';
  as?: 'span' | 'button';
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  children: ReactNode;
  className?: string;
}

export function SettingsBadge({
  tone,
  size = 'xs',
  as = 'span',
  onClick,
  disabled,
  title,
  'aria-label': ariaLabel,
  children,
  className,
}: SettingsBadgeProps) {
  const sizeClass = size === 'xxs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-xs';
  const base = `rounded-full font-semibold ${sizeClass} ${toneStyles[tone]} ${className ?? ''}`;

  if (as === 'button') {
    return (
      <button
        type="button"
        className={`${base} transition disabled:cursor-default disabled:opacity-50`}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.(e);
        }}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
      >
        {children}
      </button>
    );
  }

  return (
    <span className={base} title={title}>
      {children}
    </span>
  );
}
