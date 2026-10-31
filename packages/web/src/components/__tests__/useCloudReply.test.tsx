import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import type { CloudReplyIdentity, CloudReplyState } from '../cloud-reply-state';
import { useCloudReply } from '../useCloudReply';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const identity = { sourceMessageId: 'source119', targetCatId: 'gpt-pro', dispatchInvocationId: 'attempt119' };
const proof = { v: 1, threadId: 'thread-pro', ...identity };
const source: ChatMessage = { id: 'source119', type: 'user', content: 'source', timestamp: 1 };
let root: Root;
let container: HTMLDivElement;
let current: CloudReplyState;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function Probe({ scope, messages = [source] }: { scope: CloudReplyIdentity; messages?: readonly ChatMessage[] }) {
  current = useCloudReply(scope, 'thread-pro', messages, { readDotEvent: scope.targetCatId === 'gpt-dot' });
  return <span>{current.state}</span>;
}

it('restores a reply outside the current page through an exact read-only owner lookup', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ status: 'matched', proof, replyMessageId: 'reply122' })),
  );
  await act(async () => {
    root.render(<Probe scope={identity} />);
  });
  expect(current).toEqual({ state: 'replied', replyMessageId: 'reply122' });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(url).toContain('/messages/source119/cloud-return?');
  expect(url).toContain('dispatchInvocationId=attempt119');
  expect(init?.method).toBeUndefined();
});

it.each([
  'current',
  'stale',
  'other-thread',
  'hidden',
  'missing',
])('uses the existing exact dot event receipt (%s) without borrowing another reply', async (variant) => {
  const dotIdentity = { ...identity, targetCatId: 'gpt-dot', hostMessageId: `dot_evt_${'a'.repeat(64)}` };
  const answer: ChatMessage = {
    id: 'dot-answer',
    type: 'assistant',
    from: { kind: 'agent', catId: 'gpt-dot' },
    catId: 'gpt-dot',
    content: 'dot 带回了图片',
    timestamp: 2,
    replyTo: source.id,
  };
  if (variant === 'hidden') answer.visibility = 'whisper';
  vi.mocked(apiFetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          threadId: variant === 'other-thread' ? 'other-thread' : 'thread-pro',
          stale: variant === 'stale',
          replyMessageId: 'dot-answer',
          receivedAt: 1,
          readAt: 2,
        }),
      ),
  );
  await act(async () =>
    root.render(<Probe scope={dotIdentity} messages={variant === 'missing' ? [source] : [source, answer]} />),
  );
  expect(current).toEqual(
    variant === 'current' ? { state: 'replied', replyMessageId: 'dot-answer' } : { state: 'unverified' },
  );
  expect(vi.mocked(apiFetch).mock.calls[0]?.[0]).toBe(`/api/plugins/chatgpt-dot/delivery/${dotIdentity.hostMessageId}`);
});

it('keeps an old-attempt read unverified instead of promoting it', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'matched',
        proof: { ...proof, dispatchInvocationId: 'old' },
        replyMessageId: 'old-answer',
      }),
    ),
  );
  await act(async () => {
    root.render(<Probe scope={identity} />);
  });
  expect(current).toEqual({ state: 'unverified' });
});

it('restores a paged historical source reply without inventing its attempt proof', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ status: 'source_replied', replyMessageId: 'reply122' })),
  );
  await act(async () => {
    root.render(<Probe scope={identity} messages={[]} />);
  });
  expect(current).toEqual({ state: 'source_replied', replyMessageId: 'reply122' });
});

it('discards a late response after the exact source changes', async () => {
  let complete: (response: Response) => void = () => {};
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(new Response(JSON.stringify({ status: 'unverified' })));
  await act(async () => {
    root.render(<Probe scope={identity} />);
  });
  await act(async () => {
    root.render(<Probe scope={{ ...identity, sourceMessageId: 'other' }} />);
  });
  await act(async () => {
    complete(new Response(JSON.stringify({ status: 'matched', proof, replyMessageId: 'reply122' })));
  });
  expect(current).toEqual({ state: 'unverified' });
});

it('retains honest source-only certainty when a historical attempt cannot be legally restored', async () => {
  const answer: ChatMessage = {
    id: 'reply122',
    type: 'assistant',
    from: { kind: 'agent', catId: 'gpt-pro' },
    catId: 'gpt-pro',
    content: 'historical callback',
    replyTo: source.id,
    timestamp: 3,
    origin: 'callback',
    extra: { isExplicitPost: true },
  };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ status: 'unverified' })));
  await act(async () => {
    root.render(<Probe scope={identity} messages={[source, answer]} />);
  });
  expect(current).toEqual({ state: 'source_replied', replyMessageId: 'reply122' });
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toContain('replyMessageId=reply122');
});

it('does not revive a recalled source with a late authenticated lookup result', async () => {
  let complete: (response: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => {
    root.render(<Probe scope={identity} />);
  });
  const recalled = { ...source, extra: { recall: { version: 1 as const, exposure: 'seen' as const, recalledAt: 4 } } };
  await act(async () => {
    root.render(<Probe scope={identity} messages={[recalled]} />);
  });
  await act(async () => {
    complete(new Response(JSON.stringify({ status: 'matched', proof, replyMessageId: 'reply122' })));
  });
  expect(current).toEqual({ state: 'unverified' });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('drops a response if the browser owner changes while the owner read is pending', async () => {
  let complete: (response: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => {
    root.render(<Probe scope={identity} />);
  });
  localStorage.setItem('cat-cafe-userId', 'another-owner');
  await act(async () => {
    complete(new Response(JSON.stringify({ status: 'matched', proof, replyMessageId: 'reply122' })));
  });
  expect(current).toEqual({ state: 'unverified' });
  localStorage.removeItem('cat-cafe-userId');
});
