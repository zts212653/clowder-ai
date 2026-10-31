import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  tool,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

const NOW = Date.UTC(2026, 9, 9, 12);

describe('F322: observed activity on the reply last line', () => {
  let harness: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    harness = new ReplyLayersHarness();
    harness.enableV2();
  });
  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  const working = (id: string, timestamp = NOW) =>
    streamReply({
      timestamp: NOW - 133_000,
      isStreaming: true,
      metadata: { provider: 'anthropic', model: 'claude-opus' },
      toolEvents: [{ ...tool(id, 'Read', JSON.stringify({ file_path: '/workspace/ThreadItem.tsx' })), timestamp }],
    });

  it('shows a proven short object and a one-second elapsed clock without requiring text output', () => {
    harness.render(working('first'));
    expect(harness.q('reply-status')?.textContent).toContain('ThreadItem.tsx');
    expect(harness.q('reply-working-duration')?.textContent).toBe('2 分 13 秒');
    harness.run(() => vi.advanceTimersByTime(1000));
    expect(harness.q('reply-working-duration')?.textContent).toBe('2 分 14 秒');
  });

  it('continues to show seconds after an hour and omits elapsed time without a known reply start', () => {
    harness.render({ ...working('hour'), timestamp: NOW - 3_733_000 });
    expect(harness.q('reply-working-duration')?.textContent).toBe('1 小时 2 分 13 秒');
    harness.run(() => vi.advanceTimersByTime(1000));
    expect(harness.q('reply-working-duration')?.textContent).toBe('1 小时 2 分 14 秒');
    harness.render({ ...working('unknown-start'), timestamp: 0 });
    expect(harness.q('reply-working-duration')).toBeNull();
  });

  it('each new tool call pulses once; clock ticks and an identical re-render do not manufacture activity', () => {
    harness.render(working('first'));
    const first = harness.q('reply-activity-cat');
    expect(first?.textContent).toBe('ᓚᘏᗢ');
    expect(first?.getAttribute('data-activity-event')).toBe('first');
    expect(first?.getAttribute('data-pulse')).toBe('true');
    harness.run(() => vi.advanceTimersByTime(1000));
    harness.render(working('first'));
    expect(harness.q('reply-activity-cat')).toBe(first);
    expect(first?.getAttribute('data-pulse')).toBe('false');
    harness.render(working('second', NOW + 1000));
    expect(harness.q('reply-activity-cat')).not.toBe(first);
    expect(harness.q('reply-activity-cat')?.getAttribute('data-pulse')).toBe('true');
  });

  it('reopening an old active snapshot does not replay its tool animation', () => {
    harness.render(working('old', NOW - 60_000));
    expect(harness.q('reply-activity-cat')?.getAttribute('data-pulse')).toBe('false');
  });

  it('a newly delivered call still pulses when its provider timestamp was delayed in transit', () => {
    harness.render(working('first', NOW - 60_000));
    harness.render(working('delayed-next', NOW - 10_000));
    expect(harness.q('reply-activity-cat')?.getAttribute('data-pulse')).toBe('true');
  });

  it('the v2 nameplate stays still and classic leaves working status to the single execution strip', () => {
    harness.render(working('first'));
    expect(harness.q('cat-nameplate-avatar')?.querySelector('.animate-pulse')).toBeNull();
    window.localStorage.clear();
    harness.render({ ...working('second'), id: 'classic-reply' });
    expect(harness.q('reply-activity-cat')).toBeNull();
    expect(harness.container.querySelector('.animate-pulse')).toBeNull();
  });

  it('terminal replies remove activity and keep the actual provider duration fixed', () => {
    harness.render(working('first'));
    harness.render(
      streamReply({
        isStreaming: false,
        metadata: {
          provider: 'anthropic',
          model: 'claude-opus',
          usage: { durationMs: 88_000 },
        },
      }),
    );
    expect(harness.q('reply-activity-cat')).toBeNull();
    expect(harness.q('reply-working-duration')).toBeNull();
    expect(harness.q('reply-last-line')?.textContent).toContain('1 分 28 秒');
    harness.run(() => vi.advanceTimersByTime(5000));
    expect(harness.q('reply-last-line')?.textContent).toContain('1 分 28 秒');
  });
});
