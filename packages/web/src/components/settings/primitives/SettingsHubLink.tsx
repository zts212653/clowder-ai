import type { MouseEvent, ReactNode } from 'react';

interface SettingsHubLinkProps {
  onClick: (e: MouseEvent) => void;
  title: string;
  children: ReactNode;
}

export function SettingsHubLink({ onClick, title, children }: SettingsHubLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-xs text-conn-blue-text underline underline-offset-2 transition-colors hover:opacity-80"
      title={title}
    >
      {children}
    </button>
  );
}
