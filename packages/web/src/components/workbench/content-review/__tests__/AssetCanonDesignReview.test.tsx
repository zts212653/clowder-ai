import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { AssetAttachmentView } from '@/components/AssetAttachmentView';
import { MemberCanonAvatarOption } from '@/components/settings/members/MemberCanonAvatarOption';
import { AssetCanonDetail } from '../AssetCanonDetail';
import { VideoWorkMaterials } from '../VideoWorkMaterials';
import { item, record, update } from './asset-canon.fixtures';

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://localhost:3104', apiFetch: fetcher }));
vi.mock('@/hooks/useCatData', () => ({ getCachedCats: () => [] }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (s: { currentThreadId?: string }) => unknown) => select({}),
}));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...item, uses: [] })));
});

async function render(node: React.ReactNode) {
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(node));
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

it('shows the actual replacement decision and keeps the comparison open without repeated hide headings', async () => {
  const view = await render(
    <AssetCanonDetail
      item={item}
      record={record}
      threadId="film"
      candidates={[item]}
      update={{
        ...update,
        change: { actor: { kind: 'human', actorId: 'owner' }, recordedAt: '2026-10-27T09:00:00.000Z' },
      }}
      onSaved={vi.fn()}
      onNextVersion={vi.fn()}
    />,
  );
  try {
    expect(view.host.textContent).toContain('谁定的 · 你 · 10-27');
    expect(view.host.textContent).not.toContain('收起预览');
    expect(view.host.querySelectorAll('img')).toHaveLength(2);
  } finally {
    await view.cleanup();
  }
});

it('uses an exact story source to seek to its section and hides source-code notes in the material list', async () => {
  const row = {
    id: 's3',
    chapterId: 'c3',
    title: '本事三',
    text: '带一群 AI',
    streamId: 'v',
    startPts: 328,
    endPts: 400,
    sourceId: 'timeline.json#s3',
  };
  const chapter = { id: 'c3', title: '带一群 AI', label: '本事三', streamId: 'v', startPts: 328, endPts: 400 };
  const scoped = {
    ...record,
    context: {
      ...record.context,
      story: [row],
      chapters: [chapter],
      assets: [{ ...record.context.assets[0]!, uses: [row.sourceId] }],
    },
  };
  const seek = vi.fn();
  const view = await render(
    <VideoWorkMaterials
      record={scoped}
      clock={{ timebase: { numerator: 1, denominator: 1 }, startTick: 0 }}
      onSeek={seek}
    />,
  );
  try {
    const jump = [...view.host.querySelectorAll('button')].find((b) => b.textContent === '5:28 本事三');
    expect(jump).toBeDefined();
    await act(async () => jump!.click());
    expect(seek).toHaveBeenCalledWith(row, record.metadataRevision);
    expect(view.host.textContent).not.toContain('timeline.json');
  } finally {
    await view.cleanup();
  }
});

it('shows whole-film usage for unlocated code notes and an explicit empty usage state', async () => {
  const view = await render(
    <AssetCanonDetail
      item={item}
      record={record}
      threadId="film"
      candidates={[item]}
      update={{ ...update, uses: ['composition/main.js：画面中实际内联图片'] }}
      onSaved={vi.fn()}
      onNextVersion={vi.fn()}
    />,
  );
  try {
    expect(view.host.textContent).toContain('用在 · 全片');
    expect(view.host.textContent).not.toContain('composition/main.js');
    const toggle = [...view.host.querySelectorAll('button')].find((b) => b.textContent === '素材详情与标记')!;
    await act(async () => toggle.click());
    expect(view.host.textContent).toContain('别的片子没用到');
  } finally {
    await view.cleanup();
  }
});

it('recognizes a unique chapter label while retaining whole-film scope for another unlocated use', async () => {
  const chapter = { id: 'c3', title: '带一群 AI', label: '本事三', streamId: 'v', startPts: 328, endPts: 400 };
  const scoped = {
    ...record,
    context: {
      ...record.context,
      chapters: [chapter],
      assets: [{ ...record.context.assets[0]!, uses: ['本事三', 'unlocated-source'] }],
    },
  };
  const seek = vi.fn();
  const view = await render(
    <VideoWorkMaterials
      record={scoped}
      clock={{ timebase: { numerator: 1, denominator: 1 }, startTick: 0 }}
      onSeek={seek}
    />,
  );
  try {
    const jump = [...view.host.querySelectorAll('button')].find((b) => b.textContent === '5:28 本事三');
    expect(jump).toBeDefined();
    expect(view.host.textContent).toContain('全片');
  } finally {
    await view.cleanup();
  }
});

it('the composer thumbnail uses its explicit thread even while global navigation has no active thread', async () => {
  const view = await render(
    <AssetAttachmentView
      threadId="film"
      attachment={{
        v: 1,
        id: 'asset-chip',
        kind: 'asset',
        name: item.record.name,
        indexedVersionRef: item.record.indexedVersionRef,
        work: item.work!,
        mediaType: 'image/png',
      }}
    />,
  );
  try {
    expect(view.host.querySelector('img')?.src).toContain('threadId=film');
    expect(view.host.querySelector('img')?.src).toContain('/video-assets/4/3/hero');
  } finally {
    await view.cleanup();
  }
});

it('never leaves the usage area blank while its detail is still loading', async () => {
  fetcher.mockImplementation(() => new Promise<Response>(() => {}));
  const view = await render(
    <AssetCanonDetail
      item={item}
      record={record}
      threadId="film"
      candidates={[item]}
      onSaved={vi.fn()}
      onNextVersion={vi.fn()}
    />,
  );
  try {
    expect(view.host.textContent).toContain('正在读取使用记录…');
  } finally {
    await view.cleanup();
  }
});

it('avatar candidates show a readable image name, actual provenance and the currently bound choice', async () => {
  const view = await render(
    <MemberCanonAvatarOption
      item={{
        ...item,
        record: {
          ...item.record,
          name: 'assets/avatars/avatar-1793.png',
          creator: { kind: 'human', actorId: 'owner' },
          evidenceRefs: ['human-upload:original'],
        },
      }}
      name="小导演咪"
      selected
      current
      onSelect={vi.fn()}
    />,
  );
  try {
    expect(view.host.textContent).toContain('小导演咪的头像');
    expect(view.host.textContent).toContain('你上传 · 10-26');
    expect(view.host.textContent).toContain('现在用的');
    expect(view.host.textContent).not.toContain('avatar-1793');
  } finally {
    await view.cleanup();
  }
});
