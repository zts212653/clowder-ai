/**
 * Private DSH turn extension shared by the ACP client and the per-launch bridge.
 * This is not ACP standard and is negotiated by `hello` after `initialize`.
 */
export const DSH_TURN_PROTOCOL = 1;
export const DSH_TURN_BRIDGE = 'cat-cafe-dsh-turn';

export const DSH_TURN_METHODS = {
  hello: '_clowder/hello',
  steer: '_clowder/turn/steer',
  status: '_clowder/turn/status',
  event: '_clowder/turn',
} as const;

export interface DshTurnBridgeCapability {
  protocol: typeof DSH_TURN_PROTOCOL;
  bridge: string;
  steer: boolean;
  nativeTurns: boolean;
  desktopVersion?: string;
}

export interface DshTurnSteerRequest {
  sessionId: string;
  deliveryId: string;
  text: string;
  expectedTurn?: number;
}

export type DshTurnSteerReason =
  | 'no_active_turn'
  | 'turn_mismatch'
  | 'invalid_input'
  | 'provider_rejected'
  | 'duplicate_delivery';

export type DshTurnSteerResult =
  | { accepted: true; nativeTurnId: number; deliveryId: string }
  | { accepted: false; reason: DshTurnSteerReason };

export type DshTurnInputStateName = 'read' | 'accepted' | 'not_accepted' | 'unknown';

export interface DshTurnInputState {
  state: DshTurnInputStateName;
  nativeTurnId?: number;
}

export type DshTurnBridgeEvent =
  | { sessionId: string; type: 'turn_started'; nativeTurnId: number }
  | { sessionId: string; type: 'input_read'; deliveryId: string; nativeTurnId: number }
  | { sessionId: string; type: 'turn_ended'; nativeTurnId: number; reason: string };

const STEER_REASONS = new Set<DshTurnSteerReason>([
  'no_active_turn',
  'turn_mismatch',
  'invalid_input',
  'provider_rejected',
  'duplicate_delivery',
]);
const INPUT_STATES = new Set<DshTurnInputStateName>(['read', 'accepted', 'not_accepted', 'unknown']);
const EVENT_TYPES = new Set(['turn_started', 'input_read', 'turn_ended']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function turn(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseDshTurnBridgeCapability(value: unknown): DshTurnBridgeCapability | null {
  if (!record(value) || value.protocol !== DSH_TURN_PROTOCOL || !text(value.bridge)) return null;
  if (typeof value.steer !== 'boolean' || typeof value.nativeTurns !== 'boolean') return null;
  return {
    protocol: DSH_TURN_PROTOCOL,
    bridge: value.bridge,
    steer: value.steer,
    nativeTurns: value.nativeTurns,
    ...(typeof value.desktopVersion === 'string' ? { desktopVersion: value.desktopVersion } : {}),
  };
}

export function parseDshTurnSteerResult(value: unknown): DshTurnSteerResult | null {
  if (!record(value) || typeof value.accepted !== 'boolean') return null;
  if (value.accepted === true) {
    if (!turn(value.nativeTurnId) || !text(value.deliveryId)) return null;
    return { accepted: true, nativeTurnId: value.nativeTurnId, deliveryId: value.deliveryId };
  }
  if (!text(value.reason) || !STEER_REASONS.has(value.reason as DshTurnSteerReason)) return null;
  return { accepted: false, reason: value.reason as DshTurnSteerReason };
}

export function parseDshTurnInputState(value: unknown): DshTurnInputState | null {
  if (!record(value) || !text(value.state) || !INPUT_STATES.has(value.state as DshTurnInputStateName)) return null;
  if (value.nativeTurnId !== undefined && !turn(value.nativeTurnId)) return null;
  return {
    state: value.state as DshTurnInputStateName,
    ...(value.nativeTurnId !== undefined ? { nativeTurnId: value.nativeTurnId } : {}),
  };
}

export function parseDshTurnBridgeEvent(value: unknown): DshTurnBridgeEvent | null {
  if (!record(value) || !text(value.sessionId) || !text(value.type) || !EVENT_TYPES.has(value.type)) return null;
  if (!turn(value.nativeTurnId)) return null;
  if (value.type === 'input_read') {
    return text(value.deliveryId)
      ? {
          sessionId: value.sessionId,
          type: 'input_read',
          deliveryId: value.deliveryId,
          nativeTurnId: value.nativeTurnId,
        }
      : null;
  }
  if (value.type === 'turn_ended') {
    return typeof value.reason === 'string'
      ? { sessionId: value.sessionId, type: 'turn_ended', nativeTurnId: value.nativeTurnId, reason: value.reason }
      : null;
  }
  return { sessionId: value.sessionId, type: 'turn_started', nativeTurnId: value.nativeTurnId };
}
