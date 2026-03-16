'use client';

import { type ReactNode } from 'react';

interface GameShellProps {
  children?: ReactNode;
  onClose: () => void;
  isNight?: boolean;
}

export function GameShell({ children, isNight = false }: GameShellProps) {
  return (
    <div
      data-testid="game-shell"
      data-theme="werewolf-cute"
      data-phase={isNight ? 'night' : 'day'}
      className={`fixed inset-0 z-50 flex flex-col bg-ww-base text-ww-main${isNight ? ' brightness-90 saturate-75' : ''}`}
    >
      {children}
    </div>
  );
}
