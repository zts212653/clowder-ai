import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { verifyMessageNavigationSource } from '../verify-message-navigation-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const source = { threadId: 'owned & private', messageId: 'old', contentRevision: 'saved-revision' };
const signal = new AbortController().signal;
const answer = (target: unknown = { ...source, contentRevision: 'current-revision' }) =>
  Response.json({ status: 'available', target, updated: true });

describe('server source admission at navigation boundaries', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());
  it('sends exact coordinates/revision as data and accepts an edited version of the same message', async () => {
    vi.mocked(apiFetch).mockResolvedValue(answer());
    expect(await verifyMessageNavigationSource(source, signal)).toEqual({ status: 'available', updated: true });
    const [url, opts] = vi.mocked(apiFetch).mock.calls[0];
    expect(Object.fromEntries(new URL(url, 'https://example.test').searchParams)).toEqual(source);
    expect(opts?.signal).toBe(signal);
  });
  it.each([401, 403, 404, 503])('fails closed for status %i', async (status) => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status }));
    expect(await verifyMessageNavigationSource(source, signal)).toEqual({
      status: status === 401 || status === 403 ? 'forbidden' : 'unavailable',
    });
  });
  it.each([
    { ...source, threadId: 'forged' },
    { ...source, messageId: 'forged' },
    { threadId: source.threadId },
  ])('does not accept a substituted or incomplete target', async (target) => {
    vi.mocked(apiFetch).mockResolvedValue(answer(target));
    expect(await verifyMessageNavigationSource(source, signal)).toEqual({ status: 'unavailable' });
  });
  it('admits the origin thread independently of an old deleted message', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json({ status: 'available', target: { threadId: source.threadId }, updated: false }),
    );
    expect(await verifyMessageNavigationSource({ threadId: source.threadId }, signal)).toEqual({
      status: 'available',
      updated: false,
    });
    expect(new URL(vi.mocked(apiFetch).mock.calls[0][0], 'https://example.test').searchParams.has('messageId')).toBe(
      false,
    );
  });
  it('does not convert transport errors or malformed responses into admission', async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json({ status: 'available' }));
    expect(await verifyMessageNavigationSource(source, signal)).toEqual({ status: 'unavailable' });
    expect(await verifyMessageNavigationSource(source, signal)).toEqual({ status: 'unavailable' });
  });
});
