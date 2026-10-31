import type { ProjectScreeningContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { ProjectScreeningAttachmentView } from '../video-project/ProjectScreeningAttachmentView';
import { resolveVideoProjectTarget } from '../video-project-surface';
import { createInitialWorkbenchState } from '../workbench-model';

it('opens the frozen film and place from the original chip, keeping Chat thread and draft identity', async () => {
  const contentRef = `video-project:${'a'.repeat(64)}`,
    digest = `sha256:${'b'.repeat(64)}`;
  const attachment: ProjectScreeningContextAttachment = {
    v: 1,
    kind: 'project-screening',
    id: 'mark',
    title: '醋醋喵',
    contentRef,
    screeningId: 'original-film',
    input: { contentRef, ownerRevision: 1, blobDigest: digest },
    media: { contentRef: 'movie', ownerRevision: 1, blobDigest: digest },
    selections: [
      {
        id: 'place',
        mediaRange: { startPts: 731648, endPts: 732160 },
        target: { kind: 'moment', tick: 1429, timebase: { numerator: 1, denominator: 30 } },
      },
    ],
  };
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState() });
  useChatStore.setState({
    currentThreadId: 'original-thread',
    pendingChatInsert: { threadId: 'original-thread', text: '未发送的意见' },
  });
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    await act(async () => root.render(<ProjectScreeningAttachmentView attachment={attachment} />));
    await act(async () => host.querySelector('button')?.click());
    const { layout } = useF307ExperienceWorkbenchStore.getState();
    const selected = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
    if (!selected) throw new Error('Original film did not open');
    expect(resolveVideoProjectTarget(selected)).toMatchObject({
      contentRef,
      screeningId: 'original-film',
      position: { pts: 731648 },
    });
    expect(useChatStore.getState().currentThreadId).toBe('original-thread');
    expect(useChatStore.getState().pendingChatInsert?.text).toBe('未发送的意见');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
