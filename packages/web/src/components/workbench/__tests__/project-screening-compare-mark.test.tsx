import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { ProjectScreeningCompare } from '../video-project/ProjectScreeningCompare';
import { WorkspaceSurfaceVisibilityProvider } from '../WorkspaceSurfaceVisibility';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

const mocks = vi.hoisted(() => ({ loadScreening: vi.fn(), loadProject: vi.fn(), queue: vi.fn() }));
vi.mock('../video-project/api', () => ({ loadScreening: mocks.loadScreening, loadProject: mocks.loadProject }));
vi.mock('../video-project/selection', () => ({
  screeningSelection: ({ mediaRange }: { mediaRange: { startPts: number; endPts: number } }) => ({ mediaRange }),
  queueScreeningSelection: mocks.queue,
}));
vi.mock('../video-project/compare-screenings', () => ({
  VideoProjectScreeningCompare: ({ onRightFrame }: { onRightFrame: (time: number | null) => void }) => (
    <>
      <button type="button" onClick={() => onRightFrame(1)}>
        decoded frame
      </button>
      <button type="button" onClick={() => onRightFrame(null)}>
        seeking
      </button>
      <button type="button" onClick={() => onRightFrame(Number.NaN)}>
        invalid frame
      </button>
    </>
  ),
}));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let right: ReturnType<typeof comparisonSide>, left: ReturnType<typeof comparisonSide>;
let originalThread: string;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  left = comparisonSide('old', [comparisonShot('shot', 0, 100)]);
  right = comparisonSide('new', [comparisonShot('shot', 0, 100)]);
  mocks.loadScreening
    .mockReset()
    .mockImplementation(async (_contentRef, id) => ({ screening: { ...left.screening, id }, mediaUrl: left.mediaUrl }));
  mocks.loadProject.mockReset().mockResolvedValue(left.input);
  mocks.queue.mockReset().mockReturnValue({ kind: 'queued' });
  originalThread = useChatStore.getState().currentThreadId;
  useChatStore.setState({ currentThreadId: 'original-thread' });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useChatStore.setState({ currentThreadId: originalThread });
  vi.unstubAllGlobals();
});
async function render(markRequest: number, leftId = 'old', visible = true) {
  await act(async () =>
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible={visible}>
        <ProjectScreeningCompare
          leftId={leftId}
          right={{ screening: right.screening, mediaUrl: right.mediaUrl }}
          input={right.input}
          markRequest={markRequest}
        />
      </WorkspaceSurfaceVisibilityProvider>,
    ),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
it('waits for a decoded right frame, queues it once, and waits again during a seek', async () => {
  await render(1);
  expect(mocks.queue).not.toHaveBeenCalled();
  expect(container.textContent).toContain('正在确认画面');
  await click('invalid frame');
  expect(mocks.queue).not.toHaveBeenCalled();
  await click('decoded frame');
  expect(mocks.queue).toHaveBeenCalledOnce();
  expect(mocks.queue.mock.calls[0]).toMatchObject([
    'original-thread',
    { screeningId: 'new', selections: [{ mediaRange: { startPts: 1000, endPts: 1001 } }] },
  ]);
  await click('decoded frame');
  await render(1);
  expect(mocks.queue).toHaveBeenCalledOnce();
  await click('seeking');
  await render(2);
  expect(mocks.queue).toHaveBeenCalledOnce();
  await click('decoded frame');
  expect(mocks.queue).toHaveBeenCalledTimes(2);
});
it.each([
  'left',
  'right',
  'thread',
  'hidden',
])('expires a pending request after %s context changes', async (changed) => {
  await render(1);
  if (changed === 'right') right = { ...right, screening: { ...right.screening, id: 'different-right' } };
  if (changed === 'thread') await act(async () => useChatStore.setState({ currentThreadId: 'different-thread' }));
  const leftId = changed === 'left' ? 'different-left' : 'old';
  await render(1, leftId, changed !== 'hidden');
  await click('decoded frame');
  if (changed === 'hidden') await render(1);
  expect(mocks.queue).not.toHaveBeenCalled();
  await render(2, leftId);
  expect(mocks.queue).toHaveBeenCalledOnce();
});
it('surfaces composer refusal once and never retries it on the next decoder frame', async () => {
  mocks.queue.mockReturnValue({ kind: 'refused', reason: '先发送原片的意见，再切到另一版。' });
  await render(1);
  await click('decoded frame');
  expect(container.textContent).toContain('先发送原片的意见');
  await click('seeking');
  await click('decoded frame');
  expect(mocks.queue).toHaveBeenCalledOnce();
});
