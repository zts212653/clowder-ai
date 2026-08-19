interface WorkspaceToolbarButtonProps {
  children: React.ReactNode;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}

export function WorkspaceToolbarButton({
  children,
  active,
  activeClass,
  disabled,
  onClick,
  title,
}: WorkspaceToolbarButtonProps) {
  const activeStyle = activeClass ?? 'bg-cafe-accent/80 text-[var(--cafe-surface)] hover:bg-cafe-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-2 py-0.5 text-micro font-medium transition-colors ${active ? activeStyle : 'text-cafe-secondary hover:bg-cafe-surface/10 hover:text-cafe-muted'} ${disabled ? 'cursor-not-allowed opacity-30' : ''}`}
      title={title}
    >
      {children}
    </button>
  );
}
