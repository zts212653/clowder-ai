import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { useChatStore } from '@/stores/chatStore';
import { data, escapePreview, homeContentFixture, imageArtifact, imageAsset, props } from './home-content-fixture';
import { NOW } from './home-fixtures';

describe('Home opens the common publication owner', () => {
  const scene = homeContentFixture();

  it('opens the exact picture and Esc returns to the same Home card', async () => {
    await scene.render();
    const card = await scene.open();
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    expect(document.querySelector('[data-testid="home-publication-owner"]')).not.toBeNull();
    await escapePreview();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('returns focus to the exact replacement card after a pending catalogue refresh', async () => {
    await scene.render();
    const original = await scene.open();
    data.loading = true;
    await scene.render();
    expect(original.isConnected).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    data.loading = false;
    data.artifacts = [...data.artifacts.slice(1), { ...imageArtifact }];
    await scene.render();
    const replacement = scene.card();
    expect(replacement).not.toBe(original);
    await escapePreview();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(replacement);
  });

  it.each([
    'connected',
    'replaced',
  ] as const)('leaves focus with another owner when the original opener is %s', async (opener) => {
    const readerControl = document.createElement('button');
    document.body.append(readerControl);
    try {
      await scene.render();
      await scene.open();
      if (opener === 'replaced') {
        data.loading = true;
        await scene.render();
        data.loading = false;
        await scene.render();
      }
      readerControl.focus();
      await escapePreview();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(readerControl);
    } finally {
      readerControl.remove();
    }
  });

  it('keeps the exact preview entry when three new works displace it from the Home summary', async () => {
    await scene.render();
    await scene.open();
    data.loading = true;
    await scene.render();
    data.artifacts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        ...imageArtifact,
        name: `New publication ${index}`,
        sourceMessageId: `new-${index}`,
        url: `/uploads/new-${index}.png`,
        createdAt: NOW + (3 - index) * 1000,
      })),
      imageArtifact,
    ];
    data.loading = false;
    await scene.render();
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    await escapePreview();
    expect(document.activeElement).toBe(scene.card());
    expect(scene.host.querySelectorAll('[data-home-artifact-id]')).toHaveLength(3);
    expect(scene.host.textContent).not.toContain('无法打开这件作品');
  });

  it.each([
    'distinct',
    'identical',
  ] as const)('retains exact reader return and preview entries when their keys are %s', async (keys) => {
    const readerReturn =
      keys === 'identical'
        ? imageArtifact
        : {
            ...imageArtifact,
            name: 'Reader return',
            sourceMessageId: 'reader-return',
            url: '/uploads/reader.png',
          };
    data.artifacts = keys === 'identical' ? [imageArtifact] : [imageArtifact, readerReturn];
    const returnArtifactId = artifactObjectId(readerReturn);
    const renderReturnedHome = () => scene.render({ returnArtifactId });
    await renderReturnedHome();
    const entryCard = await scene.open();
    data.loading = true;
    await renderReturnedHome();
    expect(entryCard.isConnected).toBe(false);
    data.artifacts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        ...imageArtifact,
        name: `New image ${index}`,
        sourceMessageId: `new-image-${index}`,
        url: `/uploads/new-image-${index}.png`,
      })),
      ...data.artifacts,
    ];
    data.loading = false;
    await renderReturnedHome();
    await escapePreview();
    const cards = [...scene.host.querySelectorAll<HTMLButtonElement>('[data-home-artifact-id]')];
    const ids = cards.map((card) => card.getAttribute('data-home-artifact-id'));
    expect(ids).toContain(returnArtifactId);
    expect(ids).toContain(artifactObjectId(imageArtifact));
    expect(new Set(ids).size).toBe(3);
    expect(cards).toHaveLength(3);
    expect(document.activeElement).toBe(scene.card());
    expect(scene.host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'ready',
    );
  });

  it('hands the admitted publication owner and work mode the signed exact Home origin', async () => {
    await scene.render();
    const card = scene.card();
    const viewport = scene.host.querySelector<HTMLDivElement>('[data-testid="f307-workspace-home-page"]');
    if (!viewport) throw new Error('Original Home viewport required');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 12, 288, 120));
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 34, 288, 480));
    await scene.open();
    const origin = {
      kind: 'workspace-home-artifact',
      threadId: props.threadId,
      artifactId: artifactObjectId(imageArtifact),
      viewportOffsetPx: -22,
    };
    const admission = data.fetch.mock.calls.find(([path]) => path === '/api/content-publications/resolve');
    expect(JSON.parse(String(admission?.[1]?.body)).source).toEqual({
      kind: 'message',
      threadId: props.threadId,
      messageId: imageArtifact.sourceMessageId,
      messageRevision: String(NOW),
      item: imageArtifact.publicationItem,
      expectedUrl: imageArtifact.url,
    });
    expect(data.surfaces.at(-1)).toMatchObject({
      ownerStateRef: {
        owner: 'f138-publication',
        key: JSON.stringify({
          contentRef: imageAsset.contentRef,
          ownerRevision: imageAsset.ownerRevision,
        }),
      },
      navigationOrigin: origin,
    });
    // Media editing already lives inside this owner; Home no longer opens a second annotation reader.
    expect(props.onOpenArtifact).not.toHaveBeenCalled();
    const workMode = document.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]');
    expect(workMode).not.toBeNull();
    await act(async () => workMode?.click());
    expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
      threadId: props.threadId,
      presentation: 'work-mode',
      target: {
        kind: 'publication',
        contentRef: imageAsset.contentRef,
        ownerRevision: 1,
        navigationOrigin: origin,
      },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(props.onOpenArtifact).not.toHaveBeenCalled();
  });
});
