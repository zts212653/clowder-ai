import type { GameView, SeatId } from '@cat-cafe/shared';
import { create } from 'zustand';

/** Phase → backend action name mapping (must match WerewolfDefinition.buildActions) */
const PHASE_ACTION_MAP: Record<string, string> = {
  night_wolf: 'kill',
  night_seer: 'divine',
  night_guard: 'guard',
  night_witch: 'heal', // default; UI offers heal/poison toggle
  day_vote: 'vote',
  day_discuss: 'speak',
  day_hunter: 'shoot',
};

/** Phase → role that acts in that phase (only these roles get a targeted action card) */
const PHASE_ACTING_ROLE: Record<string, string> = {
  night_wolf: 'wolf',
  night_seer: 'seer',
  night_guard: 'guard',
  night_witch: 'witch',
  day_hunter: 'hunter',
};

/** Role → Chinese display name */
export const ROLE_NAMES_ZH: Record<string, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  villager: '村民',
  idiot: '白痴',
};

/** Phase → Chinese display name */
export const PHASE_NAMES_ZH: Record<string, string> = {
  night_guard: '守卫守护',
  night_wolf: '狼人袭击',
  night_seer: '预言家查验',
  night_witch: '女巫行动',
  night_resolve: '夜晚结算',
  day_announce: '天亮公告',
  day_last_words: '遗言时间',
  day_hunter: '猎人开枪',
  day_discuss: '白天讨论',
  day_vote: '投票放逐',
  day_pk: 'PK 发言',
  day_exile: '放逐结算',
};

/** Role → night action label mapping */
const ROLE_ACTION_LABELS: Record<string, string> = {
  seer: '查验',
  witch: '使用药水',
  guard: '守护',
  wolf: '袭击',
  hunter: '开枪',
};

/** Role → icon mapping */
const ROLE_ICONS: Record<string, string> = {
  seer: '🔮',
  witch: '🧪',
  guard: '🛡️',
  wolf: '🐺',
  hunter: '🔫',
  villager: '👤',
  idiot: '🤡',
};

/** Night action phases (must match WerewolfDefinition phase names) */
const NIGHT_ACTION_PHASES = new Set(['night_wolf', 'night_seer', 'night_witch', 'night_guard', 'night_resolve']);

/** Night role step order for god timeline */
const NIGHT_ROLE_ORDER = ['guard', 'wolf', 'seer', 'witch'];

export interface GodSeat {
  seatId: string;
  role: string;
  faction?: string;
  alive: boolean;
  status: string;
}

export interface GodNightStep {
  roleName: string;
  detail: string;
  status: 'done' | 'in_progress' | 'pending';
}

export interface GameStoreState {
  gameView: GameView | null;
  gameId: string | null;
  threadId: string | null;
  isGameActive: boolean;
  selectedTarget: SeatId | null;
  godScopeFilter: string;
  isNight: boolean;

  // Derived from GameView.config
  mySeatId: SeatId | null;
  myRole: string | null;
  isGodView: boolean;
  isDetective: boolean;
  /** Display name of the cat bound in detective mode */
  detectiveBoundName: string | null;
  myActionLabel: string | null;
  myRoleIcon: string | null;
  myActionHint: string | null;
  currentActionName: string | null;
  /** True when the current phase requires a targeted action card (night actions + day_hunter) */
  hasTargetedAction: boolean;
  /** For witch: alternate action name (poison) during night_witch */
  altActionName: string | null;

  // God-view derived data
  godSeats: GodSeat[];
  godNightSteps: GodNightStep[];

  /** When true, game overlay is hidden but game continues running */
  overlayMinimized: boolean;

  setGameView: (view: GameView, gameId: string, threadId: string) => void;
  clearGame: () => void;
  setSelectedTarget: (seatId: SeatId | null) => void;
  setGodScopeFilter: (scope: string) => void;
  minimizeOverlay: () => void;
  restoreOverlay: () => void;
}

function deriveIsNight(phase: string): boolean {
  return NIGHT_ACTION_PHASES.has(phase) || phase.includes('night');
}

function deriveGodSeats(view: GameView): GodSeat[] {
  return view.seats.map((s) => {
    const raw = s.role ?? '?';
    const zh = ROLE_NAMES_ZH[raw];
    return {
      seatId: s.seatId,
      role: zh ? `${zh} ${raw}` : raw,
      faction: s.faction,
      alive: s.alive,
      status: s.alive ? 'alive' : 'dead',
    };
  });
}

function deriveGodNightSteps(view: GameView): GodNightStep[] {
  const currentPhase = view.currentPhase;
  const currentRolePhaseIdx = NIGHT_ROLE_ORDER.findIndex((r) => `night_${r}` === currentPhase);

  return NIGHT_ROLE_ORDER.map((role, idx) => {
    let status: 'done' | 'in_progress' | 'pending';
    if (currentRolePhaseIdx < 0) {
      // Not in a night role phase — either resolve or day
      status = currentPhase.includes('night') ? 'done' : 'pending';
    } else if (idx < currentRolePhaseIdx) {
      status = 'done';
    } else if (idx === currentRolePhaseIdx) {
      status = 'in_progress';
    } else {
      status = 'pending';
    }
    return {
      roleName: role,
      detail: ROLE_ACTION_LABELS[role] ?? role,
      status,
    };
  });
}

function deriveActionHint(role: string | null, isNight: boolean, phase: string): string | null {
  if (!role) return null;
  if (phase === 'day_hunter') return '选择目标开枪';
  if (isNight) {
    if (phase === 'night_witch') return '选择救人或毒人';
    const label = ROLE_ACTION_LABELS[role];
    return label ? `选择目标进行${label}` : null;
  }
  if (phase === 'day_vote') return '投票选择放逐目标';
  if (phase === 'day_discuss') return '发言讨论';
  return null;
}

const CLEAR_STATE = {
  gameView: null,
  gameId: null,
  threadId: null,
  isGameActive: false,
  selectedTarget: null,
  godScopeFilter: 'all',
  isNight: false,
  mySeatId: null,
  myRole: null,
  isGodView: false,
  isDetective: false,
  detectiveBoundName: null,
  myActionLabel: null,
  myRoleIcon: null,
  myActionHint: null,
  currentActionName: null,
  hasTargetedAction: false,
  altActionName: null,
  godSeats: [] as GodSeat[],
  godNightSteps: [] as GodNightStep[],
  overlayMinimized: false,
};

/** Derive all state fields from a GameView update */
function deriveFromView(
  view: GameView,
  gameId: string,
  threadId: string,
): Omit<
  GameStoreState,
  'setGameView' | 'clearGame' | 'setSelectedTarget' | 'setGodScopeFilter' | 'minimizeOverlay' | 'restoreOverlay'
> {
  const humanSeat = view.config.humanSeat ?? null;
  const isGodView = view.config.humanRole === 'god-view';
  const isDetective = view.config.humanRole === 'detective';
  const mySeat = humanSeat ? view.seats.find((s) => s.seatId === humanSeat) : null;
  const myRole = mySeat?.role ?? null;
  const isNight = deriveIsNight(view.currentPhase);
  const showInspector = isGodView || isDetective;

  // Detective bound cat display name
  const detectiveBoundName =
    isDetective && view.config.detectiveSeatId
      ? (view.seats.find((s) => s.seatId === view.config.detectiveSeatId)?.displayName ?? null)
      : null;

  return {
    gameView: view,
    gameId,
    threadId,
    isGameActive:
      view.status === 'playing' || view.status === 'lobby' || view.status === 'paused' || view.status === 'finished',
    isNight,
    selectedTarget: null,
    godScopeFilter: 'all',
    mySeatId: humanSeat,
    myRole,
    isGodView,
    isDetective,
    detectiveBoundName,
    myActionLabel: myRole ? (ROLE_ACTION_LABELS[myRole] ?? null) : null,
    myRoleIcon: myRole ? (ROLE_ICONS[myRole] ?? null) : null,
    myActionHint: deriveActionHint(myRole, isNight, view.currentPhase),
    currentActionName: PHASE_ACTION_MAP[view.currentPhase] ?? null,
    hasTargetedAction: !isGodView && !isDetective && myRole != null && PHASE_ACTING_ROLE[view.currentPhase] === myRole,
    altActionName: view.currentPhase === 'night_witch' ? 'poison' : null,
    godSeats: showInspector ? deriveGodSeats(view) : [],
    godNightSteps: showInspector && isNight ? deriveGodNightSteps(view) : [],
    overlayMinimized: false,
  };
}

export const useGameStore = create<GameStoreState>((set) => ({
  ...CLEAR_STATE,

  setGameView: (view, gameId, threadId) => {
    const derived = deriveFromView(view, gameId, threadId);
    // Preserve user-set fields (selectedTarget, godScopeFilter)
    set((prev) => ({
      ...derived,
      selectedTarget: prev.selectedTarget,
      godScopeFilter: prev.godScopeFilter,
      overlayMinimized: prev.overlayMinimized,
    }));
  },

  clearGame: () => set({ ...CLEAR_STATE }),
  setSelectedTarget: (seatId) => set({ selectedTarget: seatId }),
  setGodScopeFilter: (scope) => set({ godScopeFilter: scope }),
  minimizeOverlay: () => set({ overlayMinimized: true }),
  restoreOverlay: () => set({ overlayMinimized: false }),
}));
