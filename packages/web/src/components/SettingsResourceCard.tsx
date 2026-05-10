import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';

export const settingsResourceCardClass =
  'settings-resource-card rounded-2xl bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)]';

export const settingsResourceRowClass = 'settings-resource-row flex items-center gap-3 px-4 py-3';

export const settingsResourceActionGroupClass = 'settings-resource-actions flex shrink-0 items-center gap-2.5';

export const settingsResourceAvatarClass =
  'settings-resource-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--console-active-bg)] text-xs font-bold text-cafe-interactive';

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function SettingsResourceIconButton({
  children,
  className,
  tone = 'neutral',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <button
      type="button"
      {...props}
      className={joinClasses(
        'settings-resource-action flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--console-hover-bg)] transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-50',
        tone === 'danger' ? 'text-[var(--cafe-accent)]' : 'text-cafe-muted hover:text-cafe-secondary',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SettingsResourceToggleSwitch({
  enabled,
  busy,
  onClick,
  title,
  disabled,
  ariaLabel,
  ariaPressed,
}: {
  enabled: boolean;
  busy?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaPressed?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title ?? (enabled ? '禁用' : '启用')}
      className={joinClasses(
        'settings-resource-toggle relative inline-flex h-[22px] w-10 shrink-0 rounded-full transition-colors disabled:cursor-default',
        busy ? 'opacity-50' : 'cursor-pointer',
        enabled ? 'bg-[var(--cafe-accent,#C65F3D)]' : 'bg-[var(--console-border-soft)]',
      )}
    >
      <span
        className={joinClasses(
          'pointer-events-none absolute top-[3px] h-4 w-4 rounded-full bg-[var(--console-card-bg)] transition-[left]',
          enabled ? 'left-[21px]' : 'left-[3px]',
        )}
      />
    </button>
  );
}
