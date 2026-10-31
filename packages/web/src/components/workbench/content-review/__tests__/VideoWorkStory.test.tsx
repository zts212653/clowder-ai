import type { WorkContextRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VideoWorkSidebar } from '../VideoWorkSidebar';

const record: WorkContextRecord = {
  reference: { contentRef: 'work:film', ownerRevision: 2 },
  metadataRevision: 1,
  ownerUserId: 'owner',
  operationId: 'chapters',
  requestDigest: `sha256:${'a'.repeat(64)}`,
  actor: { kind: 'human', actorId: 'owner' },
  recordedAt: '2026-10-21T00:00:00.000Z',
  context: {
    format: 'video',
    extractorVersion: 'timeline',
    provenance: [{ ref: 'timeline.json', digest: `sha256:${'b'.repeat(64)}` }],
    chapters: [
      { id: 'c0', title: '序章', streamId: 'video', startPts: 0, endPts: 10000 },
      { id: 'c1', title: '终章', streamId: 'video', startPts: 10000, endPts: 20000 },
    ],
    story: [
      { id: 'l0', chapterId: 'c0', title: '序章', text: '开头的原话', streamId: 'video', startPts: 1000, endPts: 5000 },
      {
        id: 'l1',
        chapterId: 'c1',
        title: '终章',
        text: '结尾的原话',
        streamId: 'video',
        startPts: 11000,
        endPts: 15000,
      },
    ],
    assets: [],
  },
};
it('shows timed chapter rows, expands the current chapter and seeks a chapter before its actual line', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'),
    root = createRoot(host),
    seek = vi.fn();
  const render = (currentTick: number) =>
    root.render(
      <VideoWorkSidebar
        record={record}
        loading={false}
        error={null}
        clock={{ timebase: { numerator: 1, denominator: 1000 }, startTick: 0 }}
        currentTick={currentTick}
        onSeek={seek}
      />,
    );
  try {
    await act(async () => render(1000));
    expect(host.textContent).toContain('0:00');
    expect(host.textContent).toContain('0:10');
    expect(host.textContent).toContain('0:01');
    expect(host.textContent).toContain('开头的原话');
    expect(host.textContent).not.toContain('结尾的原话');
    const ending = host.querySelector<HTMLButtonElement>('[data-chapter-id="c1"] > button');
    expect(ending).not.toBeNull();
    await act(async () => ending?.click());
    expect(seek).toHaveBeenLastCalledWith(record.context.chapters?.[1], 1);
    await act(async () => render(11000));
    expect(host.textContent).toContain('结尾的原话');
    expect(host.textContent).not.toContain('开头的原话');
  } finally {
    await act(async () => root.unmount());
  }
});
