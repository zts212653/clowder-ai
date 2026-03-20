'use client';

import type { GameView, SeatId } from '@cat-cafe/shared';
import { useCountdown } from '@/hooks/useCountdown';
import { PHASE_NAMES_ZH } from '@/stores/gameStore';
import { ActionDock } from './ActionDock';
import { EventFlow } from './EventFlow';
import { GameResultScreen } from './GameResultScreen';
import { GameShell } from './GameShell';
import { GodInspector } from './GodInspector';
import { NightActionCard } from './NightActionCard';
import { NightStatus } from './NightStatus';
import { type PhaseEntry, PhaseTimeline } from './PhaseTimeline';
import { PlayerGrid } from './PlayerGrid';
import { TopBar } from './TopBar';

interface GameOverlayProps {
  view: GameView;
  isNight: boolean;
  selectedTarget: SeatId | null;
  godScopeFilter: string;

  // God-view / detective mode
  isGodView?: boolean;
  isDetective?: boolean;
  detectiveBoundName?: string;
  godSeats?: Array<{ seatId: string; role: string; faction?: string; alive: boolean; status: string }>;
  godNightSteps?: Array<{ roleName: string; detail: string; status: 'done' | 'in_progress' | 'pending' }>;

  // Targeted action props (night + day_hunter)
  hasTargetedAction?: boolean;
  myRole?: string;
  myRoleIcon?: string;
  myActionLabel?: string;
  myActionHint?: string;
  /** For witch: alternate action (poison) */
  altActionName?: string;

  // Callbacks
  onClose: () => void;
  onSelectTarget: (seatId: SeatId) => void;
  onGodScopeChange: (scope: string) => void;
  onGodAction?: (action: string) => void;
  onVote: () => void;
  onSpeak: (content: string) => void;
  onConfirmAction: () => void;
  /** For witch: confirm alternate action (poison) */
  onConfirmAltAction?: () => void;
}

function buildPhaseEntries(view: GameView): PhaseEntry[] {
  const label = PHASE_NAMES_ZH[view.currentPhase] ?? view.currentPhase;
  return [{ name: view.currentPhase, label, round: view.round }];
}

export function GameOverlay({
  view,
  isNight,
  selectedTarget,
  godScopeFilter,
  isGodView = false,
  isDetective = false,
  detectiveBoundName,
  godSeats = [],
  godNightSteps = [],
  hasTargetedAction = false,
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
}: GameOverlayProps) {
  const phases = buildPhaseEntries(view);
  const timeLeftMs = useCountdown(view.config.timeoutMs, view.phaseStartedAt);

  // H6: Derive active speaking seat (during day_discuss, the seat that last submitted speech)
  const activeSeatId: SeatId | null = (() => {
    if (view.currentPhase !== 'day_discuss') return null;
    // Find last speech event in this round
    const speeches = view.visibleEvents.filter((e) => e.round === view.round && e.type === 'speech');
    if (speeches.length === 0) return null;
    const last = speeches[speeches.length - 1]!;
    return (last.payload.seatId as SeatId) ?? null;
  })();

  // H6: Build maps for EventFlow (actorId → display name, seatId → actorId)
  const catDisplayNames: Record<string, string> = {};
  const seatToActor: Record<string, string> = {};
  for (const seat of view.seats) {
    catDisplayNames[seat.actorId] = seat.displayName;
    seatToActor[seat.seatId] = seat.actorId;
  }

  // Show result screen when game is finished with stats
  if (view.status === 'finished' && view.gameStats) {
    return (
      <GameShell onClose={onClose} isNight={false}>
        <GameResultScreen stats={view.gameStats} onClose={onClose} />
      </GameShell>
    );
  }

  return (
    <GameShell onClose={onClose} isNight={isNight}>
      <TopBar
        phaseName={PHASE_NAMES_ZH[view.currentPhase] ?? view.currentPhase}
        roundInfo={`第 ${view.round} 轮`}
        timeLeftMs={timeLeftMs}
        isNight={isNight}
        onClose={onClose}
      />
      <PhaseTimeline phases={phases} currentIndex={0} />
      <PlayerGrid seats={view.seats} activeSeatId={activeSeatId} gameStatus={view.status} />

      <div className="flex flex-1 min-h-0">
        {/* Main content area */}
        <div className="flex flex-col flex-1 min-h-0">
          {isNight && myRole && myActionHint && <NightStatus roleName={myRole} actionHint={myActionHint} />}

          {hasTargetedAction && myRole ? (
            <div className="flex-1 flex items-center justify-center">
              <NightActionCard
                roleName={myRole}
                roleIcon={myRoleIcon ?? '🎭'}
                actionLabel={myActionLabel ?? ''}
                hint={myActionHint ?? ''}
                targets={view.seats.filter((s) => s.alive)}
                selectedTarget={selectedTarget}
                onSelectTarget={onSelectTarget}
                onConfirm={onConfirmAction}
                altActionLabel={altActionName ? '毒杀' : undefined}
                onConfirmAlt={altActionName ? onConfirmAltAction : undefined}
              />
            </div>
          ) : (
            <>
              <EventFlow events={view.visibleEvents} catDisplayNames={catDisplayNames} seatToActor={seatToActor} />
              {!isNight && <ActionDock onVote={onVote} onSpeak={onSpeak} />}
            </>
          )}
        </div>

        {/* God Inspector (right panel) — shown for god-view and detective */}
        {(isGodView || isDetective) && (
          <GodInspector
            seats={godSeats}
            nightSteps={godNightSteps}
            scopeFilter={godScopeFilter}
            gameStatus={view.status}
            isDetective={isDetective}
            detectiveBoundName={detectiveBoundName}
            godEvents={isGodView ? view.visibleEvents : undefined}
            currentRound={view.round}
            onScopeChange={onGodScopeChange}
            onGodAction={onGodAction}
          />
        )}
      </div>
    </GameShell>
  );
}
