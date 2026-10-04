export const DEFAULT_ARTIFACT_WORK_CHAT_BASIS = 30;
export interface ArtifactWorkOwnerRef {
  readonly owner: string;
  readonly key: string;
  readonly revision?: string;
}
/**
 * Owner-scoped references only. Each owner captures and restores its own state;
 * F307 carries these references without copying route, draft, scroll or selection data.
 */
export interface ArtifactWorkReturnHandle {
  readonly host: ArtifactWorkOwnerRef;
  readonly workbench: ArtifactWorkOwnerRef;
  /** Opaque coordinate minted by the foreground Chat reading owner. It grants no message access. */
  readonly chatReadingRef: string | null;
  readonly client: ArtifactWorkOwnerRef;
}
export interface ExactMessageTarget {
  readonly threadId: string;
  readonly messageId: string;
}
export interface ArtifactWorkPresentationSession {
  readonly generation: number;
  readonly threadId: string;
  readonly surfaceId: string;
  readonly mode: 'split' | 'full-window';
  readonly returnHandle: ArtifactWorkReturnHandle;
}
export interface ArtifactWorkPresentationState {
  readonly generation: number;
  readonly desktopWorkChatBasis: number;
  readonly session: ArtifactWorkPresentationSession | null;
}
export type ArtifactWorkInvalidationReason =
  | 'thread-changed'
  | 'surface-detached'
  | 'surface-changed'
  | 'host-ineligible'
  | 'owner-ref-invalid';
export type ArtifactWorkPresentationEffect =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'restore-origin';
      readonly generation: number;
      readonly returnHandle: ArtifactWorkReturnHandle;
    }
  | {
      /** Intent only; the Chat owner reports exact settlement separately. */
      readonly kind: 'reveal-chat-target';
      readonly generation: number;
      readonly target: ExactMessageTarget;
    }
  | {
      readonly kind: 'safe-host-scene';
      readonly generation: number;
      readonly reason: ArtifactWorkInvalidationReason;
    };
type Initiator = 'user' | 'host' | 'background';
interface SessionCommand {
  readonly generation: number;
  readonly threadId: string;
  readonly surfaceId: string;
}
export type ArtifactWorkPresentationCommand =
  | {
      readonly type: 'begin';
      readonly initiator: Initiator;
      readonly threadId: string;
      readonly surfaceId: string;
      readonly returnHandle: ArtifactWorkReturnHandle;
    }
  | { readonly type: 'set-chat-basis'; readonly initiator: Initiator; readonly basis: number }
  | (SessionCommand & { readonly type: 'enter-full-window'; readonly initiator: Initiator })
  | (SessionCommand & { readonly type: 'leave-full-window'; readonly initiator: Initiator })
  | (SessionCommand & {
      readonly type: 'reveal-chat-target';
      readonly initiator: Initiator;
      readonly target: ExactMessageTarget;
    })
  | (SessionCommand & { readonly type: 'close'; readonly initiator: Initiator })
  | (SessionCommand & {
      readonly type: 'invalidate';
      readonly initiator: Initiator;
      readonly reason: ArtifactWorkInvalidationReason;
    });
type BeginCommand = Extract<ArtifactWorkPresentationCommand, { readonly type: 'begin' }>;
type ScopedCommand = Exclude<ArtifactWorkPresentationCommand, BeginCommand | { readonly type: 'set-chat-basis' }>;
export interface ArtifactWorkPresentationTransition {
  readonly state: ArtifactWorkPresentationState;
  readonly effect: ArtifactWorkPresentationEffect;
}
const MIN_CHAT_BASIS = 20;
const MAX_CHAT_BASIS = 80;
const NO_EFFECT = { kind: 'none' } as const;
function boundedChatBasis(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ARTIFACT_WORK_CHAT_BASIS;
  return Math.min(MAX_CHAT_BASIS, Math.max(MIN_CHAT_BASIS, value));
}
function validOwnerRef(ref: ArtifactWorkOwnerRef): boolean {
  return ref.owner.trim().length > 0 && ref.key.trim().length > 0;
}
function validReturnHandle(handle: ArtifactWorkReturnHandle): boolean {
  return (
    validOwnerRef(handle.host) &&
    validOwnerRef(handle.workbench) &&
    validOwnerRef(handle.client) &&
    (handle.chatReadingRef === null || handle.chatReadingRef.trim().length > 0)
  );
}
function matchesSession(
  session: ArtifactWorkPresentationSession | null,
  command: SessionCommand,
): session is ArtifactWorkPresentationSession {
  return (
    session !== null &&
    session.generation === command.generation &&
    session.threadId === command.threadId &&
    session.surfaceId === command.surfaceId
  );
}
function unchanged(state: ArtifactWorkPresentationState): ArtifactWorkPresentationTransition {
  return { state, effect: NO_EFFECT };
}
function beginSession(state: ArtifactWorkPresentationState, command: BeginCommand): ArtifactWorkPresentationTransition {
  if (
    command.initiator !== 'user' ||
    command.threadId.trim().length === 0 ||
    command.surfaceId.trim().length === 0 ||
    !validReturnHandle(command.returnHandle)
  ) {
    return unchanged(state);
  }
  const generation = state.generation + 1;
  return {
    state: {
      ...state,
      generation,
      session: {
        generation,
        threadId: command.threadId,
        surfaceId: command.surfaceId,
        mode: 'split',
        returnHandle: command.returnHandle,
      },
    },
    effect: NO_EFFECT,
  };
}
function reduceCurrentSession(
  state: ArtifactWorkPresentationState,
  session: ArtifactWorkPresentationSession,
  command: ScopedCommand,
): ArtifactWorkPresentationTransition {
  switch (command.type) {
    case 'enter-full-window':
      return command.initiator === 'user'
        ? { state: { ...state, session: { ...session, mode: 'full-window' } }, effect: NO_EFFECT }
        : unchanged(state);
    case 'leave-full-window':
      return command.initiator === 'user'
        ? { state: { ...state, session: { ...session, mode: 'split' } }, effect: NO_EFFECT }
        : unchanged(state);
    case 'reveal-chat-target':
      if (
        command.initiator !== 'user' ||
        session.mode !== 'full-window' ||
        command.target.threadId !== session.threadId ||
        command.target.messageId.trim().length === 0
      ) {
        return unchanged(state);
      }
      return {
        state: { ...state, session: { ...session, mode: 'split' } },
        effect: { kind: 'reveal-chat-target', generation: session.generation, target: command.target },
      };
    case 'close':
      return command.initiator === 'background'
        ? unchanged(state)
        : {
            state: { ...state, session: null },
            effect: {
              kind: 'restore-origin',
              generation: session.generation,
              returnHandle: session.returnHandle,
            },
          };
    case 'invalidate':
      return command.initiator === 'host'
        ? {
            state: { ...state, session: null },
            effect: { kind: 'safe-host-scene', generation: session.generation, reason: command.reason },
          }
        : unchanged(state);
  }
}
export function createArtifactWorkPresentationState(
  desktopWorkChatBasis = DEFAULT_ARTIFACT_WORK_CHAT_BASIS,
): ArtifactWorkPresentationState {
  return {
    generation: 0,
    desktopWorkChatBasis: boundedChatBasis(desktopWorkChatBasis),
    session: null,
  };
}
export function reduceArtifactWorkPresentation(
  state: ArtifactWorkPresentationState,
  command: ArtifactWorkPresentationCommand,
): ArtifactWorkPresentationTransition {
  if (command.type === 'begin') return beginSession(state, command);
  if (command.type === 'set-chat-basis') {
    return command.initiator === 'user'
      ? { state: { ...state, desktopWorkChatBasis: boundedChatBasis(command.basis) }, effect: NO_EFFECT }
      : unchanged(state);
  }
  const session = state.session;
  if (!matchesSession(session, command)) return unchanged(state);
  return reduceCurrentSession(state, session, command);
}

/** Structural on purpose: geometry may classify descriptors without importing an owner implementation. */
export function isArtifactWorkSurface(surface: { readonly type?: string } | null | undefined): boolean {
  return surface?.type === 'artifact' || surface?.type === 'review';
}
