/**
 * F252 Scene Planner dogfood fix tests.
 *
 * The planner is the director layer for Feature Theater. It groups noisy
 * per-event activity into stable scenes so 100x playback reads like a
 * collaboration story instead of a flickering event ticker.
 */

import { describe, expect, it } from 'vitest';
import { extractChapters } from '../chapters';
import { applyScenePacingCues, getSceneForIndex, planReplayScenes, sceneToActiveThreadState } from '../scene-planner';
import type { ReplayEvent } from '../types';

function makeEvent(index: number, threadId: string, timestamp: number, content = `event-${index}`): ReplayEvent {
  return {
    index,
    type: 'message',
    timestamp,
    role: 'assistant',
    content,
    eventNo: index,
    sourceThreadId: threadId,
  };
}

function makePassBall(index: number, threadId: string, timestamp: number, content = '@codex'): ReplayEvent {
  return { ...makeEvent(index, threadId, timestamp, content), isPassBall: true };
}

function makeIdleEvent(index: number, threadId: string, timestamp: number, idleSkipMs: number): ReplayEvent {
  return { ...makeEvent(index, threadId, timestamp), idleSkipMs };
}

describe('planReplayScenes', () => {
  it('groups dense alternating thread events into one concurrent dialogue scene', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makeEvent(1, 'thread-b', 2_000),
      makeEvent(2, 'thread-a', 3_000),
      makeEvent(3, 'thread-b', 4_000),
      makeEvent(4, 'thread-a', 5_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({
      kind: 'concurrent_dialogue',
      startIndex: 0,
      endIndex: 4,
      activeThreadIds: ['thread-a', 'thread-b'],
      primaryThreadId: null,
      speedCue: 'normal',
    });
    expect(scenes[0]?.panelModes).toEqual({ 'thread-a': 'active', 'thread-b': 'active' });
  });

  it('orders concurrent dialogue active threads by most recent activity', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makeEvent(1, 'thread-b', 2_000),
      makeEvent(2, 'thread-a', 3_000),
      makeEvent(3, 'thread-c', 4_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b', 'thread-c']);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({
      kind: 'concurrent_dialogue',
      activeThreadIds: ['thread-c', 'thread-a', 'thread-b'],
      primaryThreadId: null,
    });
    expect(sceneToActiveThreadState(scenes[0]).activeThreadIds).toEqual(['thread-c', 'thread-a', 'thread-b']);
  });

  it('does not classify sparse thread changes as concurrent dialogue', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makeEvent(1, 'thread-a', 2_000),
      makeEvent(2, 'thread-b', 30_000),
      makeEvent(3, 'thread-b', 31_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);

    expect(scenes.map((scene) => scene.kind)).not.toContain('concurrent_dialogue');
    expect(scenes.map((scene) => scene.kind)).toEqual(['solo_work', 'solo_work']);
  });

  it('does not classify ultra-short alternation as a stable concurrent scene', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makeEvent(1, 'thread-b', 1_500),
      makeEvent(2, 'thread-a', 2_000),
      makeEvent(3, 'thread-b', 2_500),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);

    expect(scenes.map((scene) => scene.kind)).not.toContain('concurrent_dialogue');
  });

  it('does not merge activity across idle montage markers', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makeEvent(1, 'thread-b', 2_000),
      makeIdleEvent(2, 'thread-a', 3_000, 30_000),
      makeEvent(3, 'thread-b', 4_000),
      makeEvent(4, 'thread-a', 5_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);

    expect(scenes.map((scene) => scene.kind)).toContain('idle_montage');
    expect(scenes.map((scene) => scene.kind)).not.toContain('concurrent_dialogue');
  });

  it('keeps solo work as a focused single-thread scene', () => {
    const events = [makeEvent(0, 'thread-a', 1_000), makeEvent(1, 'thread-a', 2_000), makeEvent(2, 'thread-a', 3_000)];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({
      kind: 'solo_work',
      activeThreadIds: ['thread-a'],
      primaryThreadId: 'thread-a',
      panelModes: { 'thread-a': 'spotlight', 'thread-b': 'dim' },
      speedCue: 'normal',
    });
  });

  it('marks pass-ball handoff scenes as the only ordinary bullet cue', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makePassBall(1, 'thread-a', 2_000, '@opus'),
      makeEvent(2, 'thread-b', 3_000),
      makeEvent(3, 'thread-b', 4_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);
    const bulletScenes = scenes.filter((scene) => scene.speedCue === 'bullet');

    expect(bulletScenes).toHaveLength(1);
    expect(bulletScenes[0]).toMatchObject({
      kind: 'handoff',
      startIndex: 1,
      endIndex: 2,
      activeThreadIds: ['thread-a', 'thread-b'],
      primaryThreadId: 'thread-b',
    });
  });

  it('does not turn long-delayed pass-ball targets into bullet handoffs', () => {
    const events = [
      makePassBall(0, 'thread-a', 1_000, '@opus'),
      makeEvent(1, 'thread-a', 2_000),
      makeEvent(2, 'thread-b', 10_500),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);
    const pacedEvents = applyScenePacingCues(events, scenes);

    expect(scenes.map((scene) => scene.kind)).toEqual(['solo_work', 'solo_work']);
    expect(scenes.map((scene) => scene.speedCue)).toEqual(['normal', 'normal']);
    expect(pacedEvents.map((event) => event.isPassBall ?? false)).toEqual([true, false, false]);
    expect(pacedEvents.map((event) => event.triggersBulletTime ?? true)).toEqual([false, true, true]);
  });

  it('emits idle montage before planning the following dense dialogue', () => {
    const events = [
      makeIdleEvent(0, 'thread-a', 1_000, 30_000),
      makeEvent(1, 'thread-b', 2_000),
      makeEvent(2, 'thread-a', 3_000),
      makeEvent(3, 'thread-b', 4_000),
      makeEvent(4, 'thread-a', 5_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);

    expect(scenes.map((scene) => scene.kind)).toEqual(['idle_montage', 'concurrent_dialogue']);
    expect(scenes[0]).toMatchObject({ startIndex: 0, endIndex: 0, speedCue: 'montage' });
    expect(scenes[1]).toMatchObject({ startIndex: 1, endIndex: 4, speedCue: 'normal' });
  });

  it('treats dense pass-ball ping-pong as concurrent dialogue, not repeated handoff bullet time', () => {
    const events = [
      makePassBall(0, 'thread-a', 1_000, '@opus'),
      makePassBall(1, 'thread-b', 2_000, '@codex'),
      makePassBall(2, 'thread-a', 3_000, '@opus'),
      makePassBall(3, 'thread-b', 4_000, '@codex'),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b']);
    const pacedEvents = applyScenePacingCues(events, scenes);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ kind: 'concurrent_dialogue', speedCue: 'normal' });
    expect(pacedEvents.map((event) => event.isPassBall ?? false)).toEqual([true, true, true, true]);
    expect(pacedEvents.map((event) => event.triggersBulletTime ?? true)).toEqual([false, false, false, false]);
    expect(
      extractChapters(pacedEvents)
        .filter((chapter) => chapter.kind === 'pass_ball')
        .map((chapter) => chapter.eventIndex),
    ).toEqual([0, 1, 2, 3]);
  });

  it('covers every replay index with exactly one non-overlapping scene', () => {
    const events = [
      makeEvent(0, 'thread-a', 1_000),
      makeEvent(1, 'thread-b', 2_000),
      makeEvent(2, 'thread-a', 3_000),
      makeEvent(3, 'thread-b', 4_000),
      makeEvent(4, 'thread-c', 30_000),
      makeEvent(5, 'thread-c', 31_000),
    ];

    const scenes = planReplayScenes(events, ['thread-a', 'thread-b', 'thread-c']);
    const covered = scenes.flatMap((scene) =>
      Array.from({ length: scene.endIndex - scene.startIndex + 1 }, (_, offset) => scene.startIndex + offset),
    );

    expect(covered).toEqual(events.map((event) => event.index));
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i].startIndex).toBe(scenes[i - 1].endIndex + 1);
    }
  });

  it('derives active-active thread state from a concurrent dialogue scene', () => {
    const scenes = planReplayScenes(
      [
        makeEvent(0, 'thread-a', 1_000),
        makeEvent(1, 'thread-b', 2_000),
        makeEvent(2, 'thread-a', 3_000),
        makeEvent(3, 'thread-b', 4_000),
      ],
      ['thread-a', 'thread-b'],
    );

    const scene = getSceneForIndex(scenes, 2);

    expect(scene?.kind).toBe('concurrent_dialogue');
    expect(sceneToActiveThreadState(scene)).toEqual({
      activeThreadIds: ['thread-b', 'thread-a'],
      spotlightThreadId: null,
      layout: 'dual',
    });
  });
});
