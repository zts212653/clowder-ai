import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'owner' }) }));
vi.mock('@/hooks/useThreadScopedSelectors', () => ({
  useThreadLiveness: () => ({ activeInvocations: {}, catInvocations: {} }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const appendAction = {
  kind: 'append' as const,
  expectedQueueRevision: 'revision-1',
  expectedRuns: [
    { targetId: 'b', invocationId: 'turn-b', responseMessageId: 'response-b' },
    { targetId: 'c', invocationId: 'turn-c', responseMessageId: 'response-c' },
  ],
};

const original = {
  id: 'q-shared',
  threadId: 'thread-1',
  userId: 'owner',
  content: 'send to both',
  messageId: 'message-1',
  mergedMessageIds: [],
  from: { kind: 'agent' as const, catId: 'caller' },
  targetCats: ['b', 'c'],
  intent: 'a2a',
  status: 'queued' as const,
  createdAt: 1,
  lifecycleActions: { append: appendAction },
};

describe('QueuePanel delivery action convergence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', queue: [original] });
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  it('does not expose a second Append action beside Steer', () => {
    React.act(() => root.render(<QueuePanel threadId="thread-1" />));

    expect(container.querySelector('[data-testid="append-q-shared"]')).toBeNull();
    expect(container.querySelector('[data-testid="steer-q-shared"]')).not.toBeNull();
  });
});
