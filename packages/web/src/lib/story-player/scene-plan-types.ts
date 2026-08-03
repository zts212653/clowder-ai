/**
 * F252 Scene Planner public contracts.
 *
 * V1 detects four kinds directly: solo_work, concurrent_dialogue, handoff, and
 * idle_montage. guest_cameo and milestone are reserved extension points until
 * replay inputs expose guest swimlane and F233 milestone projection signals.
 */

export type SceneKind = 'solo_work' | 'concurrent_dialogue' | 'handoff' | 'guest_cameo' | 'milestone' | 'idle_montage';

export type ScenePanelMode = 'spotlight' | 'active' | 'dim';

export type SceneSpeedCue = 'normal' | 'bullet' | 'montage';

export interface ScenePlan {
  sceneId: string;
  kind: SceneKind;
  startIndex: number;
  endIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  activeThreadIds: string[];
  primaryThreadId: string | null;
  panelModes: Record<string, ScenePanelMode>;
  speedCue: SceneSpeedCue;
  reason: string;
}

export const DENSE_WINDOW_MS = 8_000;
export const DENSE_MIN_EVENTS = 4;
export const DENSE_MIN_THREAD_SWITCHES = 2;
export const MIN_SCENE_EVENTS = 3;
export const MIN_SCENE_VIRTUAL_MS = 3_000;
