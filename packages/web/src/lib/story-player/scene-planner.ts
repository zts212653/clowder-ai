/**
 * F252 Scene Planner — pure director layer for Feature Theater.
 *
 * Converts noisy per-event replay activity into stable viewing scenes.
 * V1 intentionally keeps this deterministic and stateless: no timers, no
 * persistence, and no Birdseye causal-edge inference.
 */

import {
  denseWindowEnd,
  eventThreadId,
  knownThreadIds,
  makeScene,
  recentThreadIds,
  uniqueThreadIds,
} from './scene-plan-helpers';
import { applyScenePacingCues, getSceneForIndex, sceneToActiveThreadState } from './scene-plan-playback';
import { DENSE_WINDOW_MS, type ScenePlan } from './scene-plan-types';
import type { ReplayEvent } from './types';

export type { SceneKind, ScenePanelMode, ScenePlan, SceneSpeedCue } from './scene-plan-types';
export {
  DENSE_MIN_EVENTS,
  DENSE_MIN_THREAD_SWITCHES,
  DENSE_WINDOW_MS,
  MIN_SCENE_EVENTS,
  MIN_SCENE_VIRTUAL_MS,
} from './scene-plan-types';
export { applyScenePacingCues, getSceneForIndex, sceneToActiveThreadState };

interface SceneCandidate {
  scene: ScenePlan;
  nextCursor: number;
}

function handoffEndIndex(events: readonly ReplayEvent[], startIndex: number): number | null {
  const event = events[startIndex];
  const currentThreadId = eventThreadId(events[startIndex]);
  if (!event) return null;
  if (!event.isPassBall) return null;
  if (!currentThreadId) return null;

  for (let i = startIndex + 1; i < events.length; i++) {
    if (events[i].timestamp - events[startIndex].timestamp > DENSE_WINDOW_MS) return null;
    if (events[i].idleSkipMs != null) return null;
    const nextThreadId = eventThreadId(events[i]);
    if (nextThreadId && nextThreadId !== currentThreadId) return i;
  }

  return null;
}

function tryConcurrentDialogueScene(
  events: readonly ReplayEvent[],
  allThreadIds: readonly string[],
  cursor: number,
): SceneCandidate | null {
  const denseEnd = denseWindowEnd(events, cursor);
  if (denseEnd == null) return null;

  const sceneEvents = events.slice(cursor, denseEnd + 1);
  return {
    scene: makeScene(
      events,
      allThreadIds,
      'concurrent_dialogue',
      cursor,
      denseEnd,
      recentThreadIds(sceneEvents),
      null,
      'normal',
      `dense alternating activity within ${DENSE_WINDOW_MS}ms`,
    ),
    nextCursor: denseEnd + 1,
  };
}

function tryHandoffScene(
  events: readonly ReplayEvent[],
  allThreadIds: readonly string[],
  cursor: number,
): SceneCandidate | null {
  const currentThreadId = eventThreadId(events[cursor]);
  const handoffEnd = handoffEndIndex(events, cursor);
  if (handoffEnd == null) return null;
  if (!currentThreadId) return null;

  return {
    scene: makeScene(
      events,
      allThreadIds,
      'handoff',
      cursor,
      handoffEnd,
      uniqueThreadIds(events.slice(cursor, handoffEnd + 1)),
      eventThreadId(events[handoffEnd]),
      'bullet',
      'pass-ball event followed by another thread',
    ),
    nextCursor: handoffEnd + 1,
  };
}

function tryIdleMontageScene(
  events: readonly ReplayEvent[],
  allThreadIds: readonly string[],
  cursor: number,
): SceneCandidate | null {
  if (events[cursor]?.idleSkipMs == null) return null;

  const currentThreadId = eventThreadId(events[cursor]);
  return {
    scene: makeScene(
      events,
      allThreadIds,
      'idle_montage',
      cursor,
      cursor,
      currentThreadId ? [currentThreadId] : [],
      currentThreadId,
      'montage',
      'idle gap marker',
    ),
    nextCursor: cursor + 1,
  };
}

function soloSceneEndIndex(events: readonly ReplayEvent[], cursor: number): number {
  const currentThreadId = eventThreadId(events[cursor]);
  let endIndex = cursor;
  while (endIndex + 1 < events.length) {
    const next = events[endIndex + 1];
    if (next.isPassBall) break;
    if (next.idleSkipMs != null) break;
    if (denseWindowEnd(events, endIndex + 1) != null) break;
    if (eventThreadId(next) !== currentThreadId) break;
    endIndex++;
  }
  return endIndex;
}

function buildSoloScene(
  events: readonly ReplayEvent[],
  allThreadIds: readonly string[],
  cursor: number,
): SceneCandidate {
  const currentThreadId = eventThreadId(events[cursor]);
  const endIndex = soloSceneEndIndex(events, cursor);
  return {
    scene: makeScene(
      events,
      allThreadIds,
      'solo_work',
      cursor,
      endIndex,
      currentThreadId ? [currentThreadId] : [],
      currentThreadId,
      'normal',
      'single-thread stretch',
    ),
    nextCursor: endIndex + 1,
  };
}

export function planReplayScenes(events: readonly ReplayEvent[], threadIds?: readonly string[]): ScenePlan[] {
  if (events.length === 0) return [];

  const allThreadIds = knownThreadIds(events, threadIds);
  const scenes: ScenePlan[] = [];

  let cursor = 0;
  while (cursor < events.length) {
    const candidate =
      tryIdleMontageScene(events, allThreadIds, cursor) ??
      tryConcurrentDialogueScene(events, allThreadIds, cursor) ??
      tryHandoffScene(events, allThreadIds, cursor) ??
      buildSoloScene(events, allThreadIds, cursor);
    scenes.push(candidate.scene);
    cursor = candidate.nextCursor;
  }

  return scenes;
}
