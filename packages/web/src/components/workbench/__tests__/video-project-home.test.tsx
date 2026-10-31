import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listProjects } from '../video-project/api';
import { VideoProjectList } from '../video-project/VideoProjectList';

vi.mock('../video-project/api', () => ({ listProjects: vi.fn(), projectRequest: vi.fn() }));
const projects = [
  {
    contentRef: `video-project:${'a'.repeat(64)}`,
    ownerRevision: 2,
    document: {
      title: '真实目录中的片子',
      timeline: { segments: [{ id: 'shot1' }] },
      screenings: [{ id: 'screening1', title: '第一版' }],
    },
  },
];
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.mocked(listProjects).mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('opens an actual owner-listed project from the ordinary workspace with the exact selected screening', async () => {
  vi.mocked(listProjects).mockResolvedValue(projects as unknown as Awaited<ReturnType<typeof listProjects>>);
  const open = vi.fn();
  await act(async () => root.render(<VideoProjectList onOpen={open} />));
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('真实目录中的片子'),
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      title: '真实目录中的片子',
      renderer: 'video-project-review',
      ownerStateRef: expect.objectContaining({
        key: JSON.stringify({ contentRef: projects[0].contentRef, screeningId: 'screening1' }),
      }),
    }),
  );
});
it('shows unavailable as an actionable error, never an empty or approved project list', async () => {
  vi.mocked(listProjects).mockRejectedValueOnce(new Error('目录暂时不可读')).mockResolvedValueOnce([]);
  await act(async () => root.render(<VideoProjectList onOpen={vi.fn()} />));
  expect(container.querySelector('[role=alert]')?.textContent).toContain('目录暂时不可读');
  await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '重试')?.click());
  expect(container.textContent).toContain('还没有片子');
  expect(container.querySelector('[role=alert]')).toBeNull();
});
