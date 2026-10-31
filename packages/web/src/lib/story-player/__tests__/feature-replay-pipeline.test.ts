import { describe, expect, it } from 'vitest';
import { planReplayScenes } from '../scene-planner';
import type { ReplayEvent } from '../types';
import { prepareFeatureReplayEvents } from '../useFeatureReplay';

function makeEvent(
  index: number,
  threadId: string,
  timestamp: number,
  type: ReplayEvent['type'] = 'message',
): ReplayEvent {
  return {
    index,
    type,
    timestamp,
    role: 'assistant',
    content: `event-${index}`,
    eventNo: index,
    sourceThreadId: threadId,
  };
}

function makePassBall(index: number, threadId: string, timestamp: number): ReplayEvent {
  return { ...makeEvent(index, threadId, timestamp), isPassBall: true };
}

describe('prepareFeatureReplayEvents', () => {
  it('plans pacing cues on the same compressed timeline used by Feature Theater', () => {
    const events = [
      makePassBall(0, 'thread-a', 0),
      makeEvent(1, 'thread-b', 1_000),
      makeEvent(2, 'thread-b', 2_000, 'tool_call'),
      makePassBall(3, 'thread-a', 42_000),
    ];

    const prepared = prepareFeatureReplayEvents(events, ['thread-a', 'thread-b']);
    const scenes = planReplayScenes(prepared, ['thread-a', 'thread-b']);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ kind: 'concurrent_dialogue', speedCue: 'normal' });
    expect(prepared.map((event) => event.isPassBall ?? false)).toEqual([true, false, false, true]);
    expect(prepared.map((event) => event.triggersBulletTime ?? true)).toEqual([false, true, true, false]);
  });
});
