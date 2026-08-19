import { BULLET_TIME_TOTAL_MS, bulletTimeSpeedFactor } from './bullet-time';
import type { BulletTimeState, ReplayEngineState, ReplayEvent } from './types';

export function shouldTriggerBulletTime(event: ReplayEvent | undefined): boolean {
  return event?.isPassBall === true && event.triggersBulletTime !== false;
}

export function isAdaptiveMarker(event: ReplayEvent): boolean {
  return event.isPassBall === true || event.idleSkipMs != null;
}

export function advanceBulletTime(
  bulletTime: BulletTimeState | null,
  adaptivePacing: boolean,
  deltaMs: number,
): { bulletTime: BulletTimeState | null; speedFactor: number } {
  if (!bulletTime || !adaptivePacing) return { bulletTime, speedFactor: 1.0 };

  const next = { ...bulletTime, progressMs: bulletTime.progressMs + deltaMs };
  if (next.progressMs >= BULLET_TIME_TOTAL_MS) return { bulletTime: null, speedFactor: 1.0 };
  return { bulletTime: next, speedFactor: bulletTimeSpeedFactor(next.progressMs) };
}

export function landOnAdaptiveMarker(
  state: ReplayEngineState,
  event: ReplayEvent,
  index: number,
  offset: number,
  bulletTime: BulletTimeState | null,
): ReplayEngineState {
  const nextBulletTime =
    shouldTriggerBulletTime(event) && bulletTime?.triggerIndex !== index
      ? { triggerIndex: index, progressMs: 0 }
      : bulletTime;
  return { ...state, currentIndex: index, elapsedMs: offset, bulletTime: nextBulletTime };
}
