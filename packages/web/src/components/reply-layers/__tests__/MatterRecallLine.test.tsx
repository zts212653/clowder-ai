import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecallEvent } from '@/hooks/recall-types';
import { apiFetch } from '@/utils/api-client';
import { MatterRecallLine } from '../MatterRecallLine';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const event: RecallEvent = {
  id: 'read',
  cueId: 'cue',
  invocationId: 'invocation',
  catId: 'sonnet',
  query: '',
  timestamp: 1,
  source: 'pull',
  cueStatus: 'drilled',
  resolverFamily: 'matter',
  matterRead: { status: 'current', matterId: 'matter', title: 'Settings', messageCount: 1 },
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'current',
        page: {
          matter: { matterId: 'matter' },
          entries: [
            {
              entryId: 'entry',
              quote: 'Original decision',
              source: { threadId: 'source', messageId: 'message', timestamp: 1 },
            },
          ],
        },
      }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
it('keeps an open source popover through a refreshed copy of the same persisted read', async () => {
  await act(async () => root.render(<MatterRecallLine event={event} threadId="thread" />));
  await act(async () => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original decision');
  await act(async () =>
    root.render(<MatterRecallLine event={{ ...event, matterRead: { ...event.matterRead! } }} threadId="thread" />),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original decision');
  await act(async () =>
    root.render(
      <MatterRecallLine
        event={{ ...event, matterRead: { status: 'changed', matterId: 'matter' } }}
        threadId="thread"
      />,
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('参考资料已更正');
});
