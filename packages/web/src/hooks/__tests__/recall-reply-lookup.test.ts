import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { lookupRecallReply } from '../recall-reply-lookup';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const fetchPage = vi.mocked(apiFetch);
const input = () => ({
  threadId: 'thread-one',
  event: { id: 'event', catId: 'sonnet', invocationId: 'inv', query: 'F321', timestamp: 100 },
  messages: [],
  cursor: { timestamp: 50, messageId: 'page-one' },
  signal: new AbortController().signal,
  isCurrent: () => true,
  onPage: vi.fn(),
});
describe('F321 older reply lookup', () => {
  beforeEach(() => fetchPage.mockReset());
  it('continues bounded pages and only matches the exact cat and invocation', async () => {
    fetchPage
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            replies: [{ messageId: 'wrong-cat', catId: 'codex61-sol', invocationId: 'inv', timestamp: 1 }],
            replyCursor: { timestamp: 20, messageId: 'page-two' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            replies: [{ messageId: 'right-reply', catId: 'sonnet', invocationId: 'inv', timestamp: 1 }],
            replyCursor: null,
          }),
        ),
      );
    expect(await lookupRecallReply(input())).toBe('right-reply');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0][0]).toContain('threadId=thread-one&replyBeforeTs=50&replyBeforeId=page-one');
  });
  it('does not publish a late page after switching threads', async () => {
    const request = input();
    let current = true;
    request.isCurrent = () => current;
    fetchPage.mockImplementation(async () => {
      current = false;
      return new Response('{"replies":[],"replyCursor":null}');
    });
    expect(await lookupRecallReply(request)).toBeUndefined();
    expect(request.onPage).not.toHaveBeenCalled();
  });
  it('stops a broken cursor instead of polling forever', async () => {
    const request = input();
    fetchPage.mockResolvedValue(new Response(JSON.stringify({ replies: [], replyCursor: request.cursor })));
    await expect(lookupRecallReply(request)).rejects.toThrow('did not advance');
    expect(fetchPage).toHaveBeenCalledOnce();
  });
});
