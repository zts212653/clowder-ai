import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { resolveVideoProjectTarget } from '../../video-project-surface';
import { VideoWorkSource } from '../VideoWorkSource';

const mock = vi.hoisted(() => ({ dispatch: vi.fn(), mode: vi.fn() }));
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => ({ setWorkspaceMode: mock.mode }) } }));
vi.mock('../../experience-workbench-store', () => ({
  useF307ExperienceWorkbenchStore: { getState: () => ({ dispatch: mock.dispatch }) },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('opens the original frozen screening, and never silently opens the project head without a screening', async () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  const binding = {
    sourceProjectContentRef: `video-project:${'a'.repeat(64)}`,
    sourceOwnerRevision: 2,
    sourceDigest: `sha256:${'b'.repeat(64)}`,
    screeningId: 'original-screening',
    reviewId: 'original-ledger',
  };
  try {
    await act(async () => root.render(<VideoWorkSource binding={binding} />));
    await act(async () => host.querySelector('button')?.click());
    const event = mock.dispatch.mock.calls[0][0];
    expect(resolveVideoProjectTarget(event.surface)).toEqual({
      contentRef: binding.sourceProjectContentRef,
      screeningId: 'original-screening',
    });
    expect(event.entitlement.reason).toBe('return-origin');
    await act(async () => root.render(<VideoWorkSource binding={{ ...binding, screeningId: undefined }} />));
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('未绑定固定审片');
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
