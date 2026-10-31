import {
  type CollectiveMediaSurfaceRequest,
  type CollectiveMediaSurfaceResult,
  collectiveMediaOperationId,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { contentReviewCapabilities } from '@/components/workbench/content-review/content-review-capabilities';
import {
  mediaProjection,
  mediaRef,
} from '../../../../../collective-client/src/__tests__/collective-media-surface.fixture';
import { CollectiveMediaSurface } from '../CollectiveMediaSurface';
import { mediaDraftKey, settleMediaDraft } from '../collective-media-draft';
import { useCollectiveMediaReview } from '../use-collective-media-review';
import { type CollectiveMediaRpc, CollectiveMediaRpcError } from '../use-collective-media-rpc';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('requires the explicit Collective workflow rather than granting generic private markup/modification capabilities', () => {
  const capabilities = contentReviewCapabilities(mediaProjection().view);
  expect(capabilities.markup.state).toBe('unavailable');
  expect(capabilities.requestModification.state).toBe('unavailable');
});

it('mounts the original F309 canvas with an authenticated local media URL and no private modification or Chat action', async () => {
  const value = mediaProjection();
  const rpc: CollectiveMediaRpc = async () => ({ kind: 'read', value });
  await act(async () => root.render(<CollectiveMediaSurface reference={mediaRef} rpc={rpc} onBack={vi.fn()} />));
  const image = container.querySelector<HTMLImageElement>('[data-testid="workspace-content-review-media"]');
  expect(image?.src).toContain(
    `/api/plugins/official.collective-connector/connections/${mediaRef.connectionId}/artifacts/${mediaRef.artifactId}/media/1?sourceEventId=`,
  );
  expect(container.querySelector('[data-testid="workspace-content-review-surface"]')).not.toBeNull();
  expect(container.textContent).toContain('返回原讨论');
  expect(container.textContent).not.toMatch(/请猫修改|修改记录|引用到聊天|查看版本/);
  expect(JSON.stringify(value)).not.toMatch(/ownerUserId|sourcePublication/);
});

it('shows the exact frozen historical pixels and enables original replies while new annotations remain read-only', async () => {
  const value = mediaProjection();
  value.view.historyReadOnly = true;
  value.view.canWrite = false;
  value.view.sourceState = 'changed';
  value.view.review.source = { ...value.view.review.source, ownerRevision: 2 };
  const rpc: CollectiveMediaRpc = async () => ({ kind: 'read', value });
  await act(async () => root.render(<CollectiveMediaSurface reference={mediaRef} rpc={rpc} onBack={vi.fn()} />));
  expect(container.querySelector('img')?.src).toContain('/media/1?');
  expect(container.textContent).toContain('历史版本');
  const save = container.querySelector('[aria-label="保存批注"]');
  expect(save === null || save.hasAttribute('disabled')).toBe(true);
});

it('offers edits only for the current Human own current-version annotation and reply', async () => {
  const value = mediaProjection();
  const createdAt = value.view.review.createdAt;
  value.view.review.annotations = [
    {
      id: 'own-note',
      body: '自己的批注',
      state: 'open',
      createdAt,
      updatedAt: createdAt,
      author: { kind: 'human', actorId: mediaRef.humanId },
      anchor: { baseRevision: value.blobDigest, anchor: { kind: 'image-point', x: 10, y: 10 } },
      replies: [
        {
          id: 'own-reply',
          body: '自己的回复',
          author: { kind: 'human', actorId: mediaRef.humanId },
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: 'foreign-reply',
          body: '别人的回复',
          author: { kind: 'human', actorId: 'human_other123' },
          createdAt,
          updatedAt: createdAt,
        },
      ],
    },
  ];
  value.view.annotationPage = { offset: 0, total: 1 };
  const rpc: CollectiveMediaRpc = async () => ({ kind: 'read', value });
  await act(async () => root.render(<CollectiveMediaSurface reference={mediaRef} rpc={rpc} onBack={vi.fn()} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开作品讨论"]')?.click());
  expect(container.querySelector('[aria-label="编辑我的批注"]')).not.toBeNull();
  expect(container.querySelectorAll('[aria-label="编辑我的回复"]')).toHaveLength(1);
});

it('settles a late exact receipt without overwriting a newer draft, and cannot settle another command', () => {
  const key = mediaDraftKey(mediaRef),
    operationId = crypto.randomUUID();
  const pending = {
    operationId,
    command: {
      kind: 'media-review' as const,
      expectedReviewRevision: 1,
      action: { kind: 'annotate' as const, body: '已送出的意见', anchor: { kind: 'image-point' as const, x: 2, y: 3 } },
    },
  };
  localStorage.setItem(key, JSON.stringify({ body: '刚写的新草稿', anchor: null, pending }));
  expect(settleMediaDraft(key, { ...pending, operationId: crypto.randomUUID() }).pending?.operationId).toBe(
    operationId,
  );
  const settled = settleMediaDraft(key, pending);
  expect(settled.body).toBe('刚写的新草稿');
  expect(settled.pending).toBeUndefined();
});

it('closes pixels on a fresh deny but retains own words and retries an unknown write with the same operation', async () => {
  let current!: ReturnType<typeof useCollectiveMediaReview>;
  let denied = false;
  const rpc = vi.fn<CollectiveMediaRpc>(async (operation) => {
    if (denied || operation.kind === 'annotate') throw new CollectiveMediaRpcError('owner_unavailable');
    return { kind: 'read', value: mediaProjection() };
  });
  function Harness() {
    current = useCollectiveMediaReview(mediaRef, rpc);
    return <output>{current.controller.view ? 'pixels' : ''}</output>;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    current.controller.setDraft('保留我的话');
    current.controller.setTarget({ kind: 'media_anchor', anchor: { kind: 'image-point', x: 2, y: 3 } });
  });
  await act(async () => current.controller.submitAnnotation());
  expect(container.textContent).toBe('');
  expect(current.controller.draft).toBe('保留我的话');
  const original = rpc.mock.calls.find(([operation]) => operation.kind === 'annotate')?.[0];
  await act(async () => current.controller.refreshSource());
  await act(async () => current.controller.retryPending());
  expect(rpc.mock.calls.filter(([operation]) => operation.kind === 'annotate')[1]?.[0]).toEqual(original);
  denied = true;
  await act(async () => current.controller.refreshSource());
  expect(current.controller.view).toBeNull();
  expect(localStorage.getItem(mediaDraftKey(mediaRef))).toContain('保留我的话');
});

it('settles the exact receipt after a slow send while preserving a newer word whose storage write failed', async () => {
  let current!: ReturnType<typeof useCollectiveMediaReview>;
  let finish!: (result: CollectiveMediaSurfaceResult['result']) => void;
  let command!: Extract<CollectiveMediaSurfaceRequest['operation'], { kind: 'annotate' }>;
  const rpc: CollectiveMediaRpc = async (operation) => {
    if (operation.kind === 'read') return { kind: 'read', value: mediaProjection() };
    command = operation;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  function Harness() {
    current = useCollectiveMediaReview(mediaRef, rpc);
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    current.controller.setDraft('原批注');
    current.controller.setTarget({ kind: 'media_anchor', anchor: { kind: 'image-point', x: 2, y: 3 } });
  });
  let saving!: Promise<void>;
  await act(async () => {
    saving = current.controller.submitAnnotation();
  });
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full');
  });
  await act(async () => current.controller.setDraft('新写的未保存文字'));
  storage.mockRestore();
  const operationId = await collectiveMediaOperationId(mediaRef, 'annotate', command.operationId);
  await act(async () => {
    finish({
      kind: 'annotated',
      value: {
        annotationId: 'real-note',
        ownerRevision: 1,
        receipt: {
          reviewId: 'public-ledger',
          operationId,
          receiptRef: 'real-receipt',
          revision: 2,
          actor: { kind: 'human', actorId: mediaRef.humanId },
          createdAt: '2026-10-16T00:00:00Z',
          replayed: false,
        },
      },
    });
    await saving;
  });
  expect(current.controller.draft).toBe('新写的未保存文字');
  expect(current.controller.pending).toBe(false);
});
