import type { WorkContextRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VideoWorkSidebar } from '../VideoWorkSidebar';

it('story and material are views of one fixed version; no story is required to watch a film', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container),
    seek = vi.fn(),
    annotate = vi.fn();
  const record = {
    reference: { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 2 },
    metadataRevision: 3,
    ownerUserId: 'owner',
    operationId: 'index',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    actor: { kind: 'cat' as const, actorId: 'director' },
    recordedAt: '2026-10-20T00:00:00.000Z',
    context: {
      format: 'video' as const,
      extractorVersion: 'srt-v1',
      provenance: [{ ref: 'release.vtt', digest: `sha256:${'c'.repeat(64)}` }],
      story: [
        { id: 'question', title: '一个问题', text: '真原话', streamId: 'video', startPts: 731648, endPts: 734720 },
      ],
      assets: [],
    },
  };
  try {
    await act(async () =>
      root.render(
        <VideoWorkSidebar record={record} loading={false} error={null} onSeek={seek} onAnnotate={annotate} />,
      ),
    );
    const story = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('一个问题'),
    );
    await act(async () => story?.click());
    expect(seek).toHaveBeenCalledWith(record.context.story[0], record.metadataRevision);
    const opinion = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === '对这段提意见',
    );
    expect(opinion).toBeDefined();
    await act(async () => opinion?.click());
    expect(annotate).toHaveBeenCalledExactlyOnceWith(record.context.story[0], record.metadataRevision);
    expect(seek).toHaveBeenCalledTimes(1);
    const select = container.querySelector('select');
    if (!select) throw new Error('Story/material selector missing');
    await act(async () => {
      select.value = 'assets';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('尚未登记这版用到的素材');
    await act(async () =>
      root.render(<VideoWorkSidebar record={null} loading={false} error="索引读取失败" onSeek={seek} />),
    );
    expect(container.textContent).toContain('索引读取失败');
    expect(container.textContent).not.toContain('尚未登记');
  } finally {
    await act(async () => root.unmount());
  }
});

it('opens only the requested original material and drops its preview when the frozen metadata changes', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const at = '2026-10-20T00:00:00.000Z';
  const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 2 };
  const record: WorkContextRecord = {
    reference,
    metadataRevision: 3,
    ownerUserId: 'owner',
    operationId: 'index',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    actor: { kind: 'human', actorId: 'owner' },
    recordedAt: at,
    context: {
      format: 'video',
      extractorVersion: 'actual-uses',
      provenance: [{ ref: 'film.tsx', digest: `sha256:${'c'.repeat(64)}` }],
      story: [],
      assets: ['image/png', 'audio/wav', 'image/svg+xml'].map((mediaType, i) => ({
        asset: {
          id: `asset-${i}`,
          name: `原素材 ${i}`,
          kind: '图片',
          versions: [
            {
              id: 'input',
              mediaType,
              byteLength: 1234,
              sha256: `sha256:${'d'.repeat(64)}`,
              locator: { kind: 'workspace', rootId: 'admitted-root', path: `original-${i}` },
              recordedAt: at,
              origin: { kind: 'imported', actor: null, at, refs: ['film.tsx'] },
            },
          ],
        },
        versionId: 'input',
        uses: ['片中实际使用'],
      })),
    },
  };
  const url = (id: string, revision: number) => `/original/${reference.ownerRevision}/${revision}/${id}`;
  const render = () =>
    root.render(<VideoWorkSidebar record={record} loading={false} error={null} onSeek={vi.fn()} assetUrl={url} />);
  try {
    await act(async () => render());
    await act(async () => {
      const select = host.querySelector('select');
      if (!select) throw new Error('Story/material selector missing');
      select.value = 'assets';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelectorAll('a')).toHaveLength(3);
    expect(host.querySelector('img, audio, video')).toBeNull();
    const preview = (i: number) => host.querySelector<HTMLButtonElement>(`button[aria-label="预览 原素材 ${i}"]`);
    expect(preview(2)).toBeNull(); // Active SVG remains a download, never an embedded document.
    await act(async () => preview(0)?.click());
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/original/2/3/asset-0');
    expect(host.querySelector('audio')).toBeNull();
    await act(async () => preview(1)?.click());
    expect(host.querySelector('audio')?.getAttribute('src')).toBe('/original/2/3/asset-1');
    expect(host.querySelector('audio')?.getAttribute('preload')).toBe('none');
    const audio = host.querySelector('audio'),
      group = host.querySelector('details');
    if (!audio || !group) throw new Error('Material playback group missing');
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
    await act(async () => {
      group.open = false;
      group.dispatchEvent(new Event('toggle'));
    });
    expect(pause).toHaveBeenCalled();
    record.metadataRevision = 4;
    await act(async () => render());
    expect(host.querySelector('img, audio, video')).toBeNull();
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/original/2/4/asset-0');
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps frame sequences under one material category with one first frame and a count per group', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'),
    root = createRoot(host);
  const at = '2026-10-20T00:00:00.000Z';
  const assets = ['动作帧 · wait', '动作帧 · wait', '录像帧 · relay', '封面'].map((kind, i) => ({
    asset: {
      id: `a${i}`,
      name: `frame${i}.png`,
      kind,
      versions: [
        {
          id: 'v1',
          mediaType: 'image/png',
          byteLength: 42,
          sha256: `sha256:${'a'.repeat(64)}`,
          locator: { kind: 'workspace', rootId: 'root', path: `frame${i}.png` },
          recordedAt: at,
          origin: { kind: 'imported', actor: null, at, refs: ['composition'] },
        },
      ],
    },
    versionId: 'v1',
    uses: ['实际使用'],
  }));
  const record = {
    reference: { contentRef: 'work:film', ownerRevision: 1 },
    metadataRevision: 1,
    context: { story: [], assets },
  } as unknown as WorkContextRecord;
  try {
    await act(async () =>
      root.render(
        <VideoWorkSidebar
          record={record}
          loading={false}
          error={null}
          onSeek={vi.fn()}
          assetUrl={(id) => `/material/${id}`}
        />,
      ),
    );
    await act(async () => {
      const select = host.querySelector('select');
      if (select) {
        select.value = 'assets';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const categories = [...host.querySelectorAll('aside > div > details > summary')];
    expect(categories.map((row) => row.textContent)).toEqual(['帧序列 · 2 组', '封面 · 1']);
    const frames = host.querySelector('details');
    expect(frames?.textContent).toContain('动作帧 · wait · 2 张');
    await act(async () => {
      if (frames) {
        frames.open = true;
        frames.dispatchEvent(new Event('toggle'));
      }
    });
    expect(frames?.querySelectorAll('img')).toHaveLength(2);
    expect(frames?.querySelector('img')?.getAttribute('src')).toBe('/material/a0');
    expect(host.querySelectorAll('a')).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
  }
});
