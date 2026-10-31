import {
  DENSE_MIN_EVENTS,
  DENSE_MIN_THREAD_SWITCHES,
  DENSE_WINDOW_MS,
  MIN_SCENE_EVENTS,
  MIN_SCENE_VIRTUAL_MS,
  type SceneKind,
  type ScenePanelMode,
  type ScenePlan,
  type SceneSpeedCue,
} from './scene-plan-types';
import type { ReplayEvent } from './types';

export function eventThreadId(event: ReplayEvent | undefined): string | null {
  return typeof event?.sourceThreadId === 'string' ? event.sourceThreadId : null;
}

export function uniqueThreadIds(events: readonly ReplayEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    const threadId = eventThreadId(event);
    if (threadId && !ids.includes(threadId)) ids.push(threadId);
  }
  return ids;
}

export function recentThreadIds(events: readonly ReplayEvent[]): string[] {
  const ids: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const threadId = eventThreadId(events[i]);
    if (threadId && !ids.includes(threadId)) ids.push(threadId);
  }
  return ids;
}

export function knownThreadIds(events: readonly ReplayEvent[], threadIds?: readonly string[]): string[] {
  return threadIds && threadIds.length > 0 ? [...threadIds] : uniqueThreadIds(events);
}

function panelModesFor(
  threadIds: readonly string[],
  activeThreadIds: readonly string[],
  primaryThreadId: string | null,
): Record<string, ScenePanelMode> {
  const modes: Record<string, ScenePanelMode> = {};
  for (const threadId of threadIds) {
    if (threadId === primaryThreadId) {
      modes[threadId] = 'spotlight';
      continue;
    }
    if (activeThreadIds.includes(threadId)) {
      modes[threadId] = 'active';
      continue;
    }
    modes[threadId] = 'dim';
  }
  return modes;
}

function countThreadSwitches(events: readonly ReplayEvent[], startIndex: number, endIndex: number): number {
  let switches = 0;
  let previous = eventThreadId(events[startIndex]);
  for (let i = startIndex + 1; i <= endIndex; i++) {
    const current = eventThreadId(events[i]);
    if (current && previous && current !== previous) switches++;
    if (current) previous = current;
  }
  return switches;
}

export function denseWindowEnd(events: readonly ReplayEvent[], startIndex: number): number | null {
  const start = events[startIndex];
  if (!start) return null;
  if (start.idleSkipMs != null) return null;

  let endIndex = startIndex;
  while (endIndex + 1 < events.length && events[endIndex + 1].timestamp - start.timestamp <= DENSE_WINDOW_MS) {
    if (events[endIndex + 1].idleSkipMs != null) break;
    endIndex++;
  }

  const eventCount = endIndex - startIndex + 1;
  if (eventCount < Math.max(DENSE_MIN_EVENTS, MIN_SCENE_EVENTS)) return null;
  const end = events[endIndex];
  if (!end || end.timestamp - start.timestamp < MIN_SCENE_VIRTUAL_MS) return null;

  const windowEvents = events.slice(startIndex, endIndex + 1);
  if (uniqueThreadIds(windowEvents).length < 2) return null;
  if (countThreadSwitches(events, startIndex, endIndex) < DENSE_MIN_THREAD_SWITCHES) return null;

  return endIndex;
}

export function makeScene(
  events: readonly ReplayEvent[],
  allThreadIds: readonly string[],
  kind: SceneKind,
  startIndex: number,
  endIndex: number,
  activeThreadIds: string[],
  primaryThreadId: string | null,
  speedCue: SceneSpeedCue,
  reason: string,
): ScenePlan {
  const start = events[startIndex];
  if (!start) throw new Error(`ScenePlanner missing start event at ${startIndex}`);
  const end = events[endIndex];
  if (!end) throw new Error(`ScenePlanner missing end event at ${endIndex}`);
  return {
    sceneId: `${kind}:${startIndex}-${endIndex}`,
    kind,
    startIndex,
    endIndex,
    startTimestamp: start.timestamp,
    endTimestamp: end.timestamp,
    activeThreadIds,
    primaryThreadId,
    panelModes: panelModesFor(allThreadIds, activeThreadIds, primaryThreadId),
    speedCue,
    reason,
  };
}
