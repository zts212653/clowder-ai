'use client';

export interface NightBallotRow {
  seatId: string;
  target: string;
  source: 'submitted' | 'fallback';
}

/** Extract night ballot display rows from god-visible events.
 *  When currentRound is provided, only events from that round are included. */
export function deriveNightBallotRows(
  events: Array<{ type: string; payload: Record<string, unknown>; round?: number }>,
  currentRound?: number,
): NightBallotRow[] {
  const rows: NightBallotRow[] = [];
  for (const e of events) {
    if (currentRound !== undefined && e.round !== currentRound) continue;
    if (e.type === 'action.submitted' && e.payload.actionName === 'kill') {
      rows.push({
        seatId: e.payload.seatId as string,
        target: e.payload.target as string,
        source: 'submitted',
      });
    } else if (e.type === 'action.fallback' && e.payload.actionName === 'kill') {
      rows.push({
        seatId: e.payload.seatId as string,
        target: e.payload.target as string,
        source: 'fallback',
      });
    }
  }
  return rows;
}

interface SeatMatrixRow {
  seatId: string;
  role: string;
  faction?: string;
  alive: boolean;
  status: string;
}

interface NightStep {
  roleName: string;
  detail: string;
  status: 'done' | 'in_progress' | 'pending';
}

interface GodInspectorProps {
  seats: SeatMatrixRow[];
  nightSteps: NightStep[];
  scopeFilter: string;
  gameStatus?: string;
  isDetective?: boolean;
  detectiveBoundName?: string;
  godEvents?: Array<{ type: string; payload: Record<string, unknown>; round?: number }>;
  currentRound?: number;
  onScopeChange: (scope: string) => void;
  onGodAction?: (action: string) => void;
}

export interface GodButtonVisibility {
  showPause: boolean;
  showResume: boolean;
  showSkip: boolean;
}

export function deriveGodButtons(status: string): GodButtonVisibility {
  return {
    showPause: status === 'playing',
    showResume: status === 'paused',
    showSkip: status === 'playing',
  };
}

const ROLE_COLORS: Record<string, string> = {
  wolf: 'var(--ww-role-wolf)',
  seer: 'var(--ww-role-seer)',
  witch: 'var(--ww-role-witch)',
  guard: 'var(--ww-role-guard)',
  hunter: 'var(--ww-accent-info)',
};

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  done: { icon: '✓', color: 'var(--ww-accent-success)' },
  in_progress: { icon: '◐', color: 'var(--ww-accent-info)' },
  pending: { icon: '○', color: 'var(--ww-text-dim)' },
};

const SCOPE_TABS = [
  { key: 'all', label: '全部', color: null },
  { key: 'wolves', label: '狼人', color: 'var(--ww-role-wolf)' },
  { key: 'seer', label: '预言家', color: 'var(--ww-role-seer)' },
  { key: 'witch', label: '女巫', color: 'var(--ww-role-witch)' },
];

function getRoleColor(faction?: string): string {
  if (!faction) return 'var(--ww-text-muted)';
  return ROLE_COLORS[faction] ?? 'var(--ww-text-muted)';
}

export function GodInspector({
  seats,
  nightSteps,
  scopeFilter,
  gameStatus,
  isDetective = false,
  detectiveBoundName,
  godEvents,
  currentRound,
  onScopeChange,
  onGodAction,
}: GodInspectorProps) {
  const buttons = deriveGodButtons(gameStatus ?? '');
  const nightBallotRows = godEvents ? deriveNightBallotRows(godEvents, currentRound) : [];
  return (
    <div
      data-testid="god-inspector"
      className="flex flex-col gap-3.5 bg-ww-topbar border-l border-ww-subtle p-4 h-full w-[360px] overflow-y-auto"
    >
      {/* Detective mode indicator */}
      {isDetective && (
        <div
          data-testid="detective-indicator"
          className="flex items-center gap-2 rounded-lg bg-ww-cute-soft border border-ww-cute px-3 py-2"
        >
          <svg className="w-4 h-4 text-ww-cute flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" />
          </svg>
          <span className="text-xs font-semibold text-ww-cute">
            推理模式{detectiveBoundName ? ` — 绑定: ${detectiveBoundName}` : ''}
          </span>
        </div>
      )}
      {/* Section 1: Seat Matrix */}
      <span className="text-ww-dim text-[10px] font-bold font-mono tracking-widest">座位表</span>
      <div data-testid="seat-matrix" className="flex flex-col gap-1">
        {seats.map((seat) => {
          const roleColor = getRoleColor(seat.faction);
          const isWolf = seat.faction === 'wolf';
          return (
            <div
              key={seat.seatId}
              data-testid={`matrix-${seat.seatId}`}
              className={`flex items-center justify-between rounded px-2 py-1 h-7 ${
                isWolf ? 'bg-ww-danger-soft' : 'bg-ww-card'
              }${!seat.alive ? ' opacity-40' : ''}`}
            >
              <span className="text-[10px] font-mono font-semibold" style={{ color: roleColor }}>
                {seat.seatId}
              </span>
              <span className="text-[10px] font-medium" style={{ color: roleColor }}>
                {seat.role}
                {!seat.alive ? ' 💀' : ''}
              </span>
              <span
                className={`text-[9px] font-mono font-medium ${
                  seat.status.includes('已行动')
                    ? 'text-ww-success'
                    : seat.status.includes('行动中')
                      ? 'text-ww-info'
                      : seat.status.includes('被刀')
                        ? 'text-ww-danger'
                        : 'text-ww-dim'
                }`}
              >
                {seat.status}
              </span>
            </div>
          );
        })}
      </div>

      {/* Divider */}
      <div className="h-px bg-ww-card w-full" />

      {/* Section 2: Night Timeline */}
      <span className="text-ww-dim text-[10px] font-bold font-mono tracking-widest">夜晚时间线</span>
      <div data-testid="night-timeline" className="flex flex-col gap-1.5">
        {nightSteps.map((step) => {
          const si = STATUS_ICONS[step.status] ?? { icon: '○', color: 'var(--ww-text-dim)' };
          return (
            <div key={`${step.roleName}-${step.status}`} className="flex items-center gap-2 w-full">
              <span className="text-[10px] font-mono font-bold" style={{ color: si.color }}>
                {si.icon}
              </span>
              <span className="text-[11px] font-medium" style={{ color: getRoleColor(step.roleName.toLowerCase()) }}>
                {step.roleName}
              </span>
              <span className="text-[10px] font-mono text-ww-dim">{step.detail}</span>
            </div>
          );
        })}
      </div>

      {/* Night Ballot Panel — who voted for whom (wolf kill phase) */}
      {nightBallotRows.length > 0 && (
        <>
          <div className="h-px bg-ww-card w-full" />
          <span className="text-ww-dim text-[10px] font-bold font-mono tracking-widest">狼人投票</span>
          <div data-testid="night-ballot-panel" className="flex flex-col gap-1">
            {nightBallotRows.map((row) => (
              <div
                key={row.seatId}
                className={`flex items-center justify-between rounded px-2 py-1 h-7 ${
                  row.source === 'fallback' ? 'bg-ww-danger-soft' : 'bg-ww-card'
                }`}
              >
                <span className="text-[10px] font-mono font-semibold text-ww-danger">{row.seatId}</span>
                <span className="text-[10px] font-mono text-ww-dim">→</span>
                <span className="text-[10px] font-mono font-semibold text-ww-main">{row.target}</span>
                {row.source === 'fallback' && <span className="text-[9px] font-mono text-ww-danger">系统代行</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Divider */}
      <div className="h-px bg-ww-card w-full" />

      {/* Section 3: Scope Filter */}
      <span className="text-ww-dim text-[10px] font-bold font-mono tracking-widest">阵营筛选</span>
      <div data-testid="scope-tabs" className="flex gap-1">
        {SCOPE_TABS.map((tab) => {
          const isActive = scopeFilter === tab.key;
          return (
            <button
              type="button"
              key={tab.key}
              data-testid={`scope-${tab.key}`}
              onClick={() => onScopeChange(tab.key)}
              className={`text-[10px] font-mono rounded-md px-3 py-1.5 ${
                isActive ? 'bg-ww-danger text-ww-main font-bold' : 'bg-ww-card'
              }`}
              style={!isActive && tab.color ? { color: tab.color } : undefined}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Section 4: God Actions (hidden in detective mode) */}
      {!isDetective && (buttons.showPause || buttons.showResume || buttons.showSkip) && (
        <>
          <div className="h-px bg-ww-card w-full" />
          <span className="text-ww-dim text-[10px] font-bold font-mono tracking-widest">GOD ACTIONS</span>
          <div data-testid="god-actions" className="flex gap-2">
            {buttons.showPause && (
              <button
                type="button"
                data-testid="god-pause"
                onClick={() => onGodAction?.('pause')}
                className="flex-1 text-[11px] font-bold rounded-md px-3 py-2 bg-ww-info text-ww-base hover:brightness-90 transition-colors"
              >
                暂停
              </button>
            )}
            {buttons.showResume && (
              <button
                type="button"
                data-testid="god-resume"
                onClick={() => onGodAction?.('resume')}
                className="flex-1 text-[11px] font-bold rounded-md px-3 py-2 bg-ww-success text-ww-base hover:brightness-90 transition-colors"
              >
                继续
              </button>
            )}
            {buttons.showSkip && (
              <button
                type="button"
                data-testid="god-skip"
                onClick={() => onGodAction?.('skip_phase')}
                className="flex-1 text-[11px] font-bold rounded-md px-3 py-2 bg-ww-card text-ww-muted hover:brightness-110 transition-colors"
              >
                跳过阶段
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
