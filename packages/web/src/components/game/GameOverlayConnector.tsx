'use client';

import type { GameView, SeatId } from '@cat-cafe/shared';
import type { GodNightStep, GodSeat } from '@/stores/gameStore';
import { GameOverlay } from './GameOverlay';

interface GameOverlayConnectorProps {
  gameView: GameView | null;
  isGameActive: boolean;
  overlayMinimized?: boolean;
  currentThreadId?: string;
  isNight: boolean;
  selectedTarget: SeatId | null;
  godScopeFilter: string;

  isGodView?: boolean;
  isDetective?: boolean;
  detectiveBoundName?: string;
  godSeats?: GodSeat[];
  godNightSteps?: GodNightStep[];
  hasTargetedAction?: boolean;
  myRole?: string;
  myRoleIcon?: string;
  myActionLabel?: string;
  myActionHint?: string;
  altActionName?: string;

  onClose: () => void;
  onSelectTarget: (seatId: SeatId) => void;
  onGodScopeChange: (scope: string) => void;
  onGodAction?: (action: string) => void;
  onVote: () => void;
  onSpeak: (content: string) => void;
  onConfirmAction: () => void;
  onConfirmAltAction?: () => void;
}

export function GameOverlayConnector({
  gameView,
  isGameActive,
  overlayMinimized,
  currentThreadId,
  isNight,
  selectedTarget,
  godScopeFilter,
  isGodView,
  isDetective,
  detectiveBoundName,
  godSeats,
  godNightSteps,
  hasTargetedAction,
  myRole,
  myRoleIcon,
  myActionLabel,
  myActionHint,
  altActionName,
  onClose,
  onSelectTarget,
  onGodScopeChange,
  onGodAction,
  onVote,
  onSpeak,
  onConfirmAction,
  onConfirmAltAction,
}: GameOverlayConnectorProps) {
  if (!isGameActive || !gameView) return null;
  if (currentThreadId && gameView.threadId !== currentThreadId) return null;
  if (overlayMinimized) return null;

  return (
    <GameOverlay
      view={gameView}
      isNight={isNight}
      selectedTarget={selectedTarget}
      godScopeFilter={godScopeFilter}
      isGodView={isGodView}
      isDetective={isDetective}
      detectiveBoundName={detectiveBoundName}
      godSeats={godSeats}
      godNightSteps={godNightSteps}
      hasTargetedAction={hasTargetedAction}
      myRole={myRole}
      myRoleIcon={myRoleIcon}
      myActionLabel={myActionLabel}
      myActionHint={myActionHint}
      altActionName={altActionName}
      onClose={onClose}
      onSelectTarget={onSelectTarget}
      onGodScopeChange={onGodScopeChange}
      onGodAction={onGodAction}
      onVote={onVote}
      onSpeak={onSpeak}
      onConfirmAction={onConfirmAction}
      onConfirmAltAction={onConfirmAltAction}
    />
  );
}
