import type { ActiveThreadState, CamLayout } from './active-thread-tracker';
import type { ScenePlan } from './scene-plan-types';
import type { ReplayEvent } from './types';

export function getSceneForIndex(scenes: readonly ScenePlan[], index: number): ScenePlan | null {
  return scenes.find((scene) => index >= scene.startIndex && index <= scene.endIndex) ?? null;
}

export function applyScenePacingCues(events: readonly ReplayEvent[], scenes: readonly ScenePlan[]): ReplayEvent[] {
  return events.map((event, position) => {
    if (!event.isPassBall) return event;
    const scene = getSceneForIndex(scenes, position);
    if (scene?.speedCue === 'bullet') return event;

    return { ...event, triggersBulletTime: false };
  });
}

function layoutFor(activeThreadCount: number): CamLayout {
  return activeThreadCount <= 1 ? 'single' : activeThreadCount === 2 ? 'dual' : 'multi';
}

export function sceneToActiveThreadState(scene: ScenePlan | null | undefined): ActiveThreadState {
  if (!scene) return { activeThreadIds: [], spotlightThreadId: null, layout: 'single' };
  return {
    activeThreadIds: scene.activeThreadIds,
    spotlightThreadId: scene.primaryThreadId,
    layout: layoutFor(scene.activeThreadIds.length),
  };
}
