import { describe, expect, it, vi } from 'vitest';
import { requestTrueRecall } from '@/utils/true-recall';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/components/composer-draft-flush-registry', () => ({ flushComposerDraft: async () => undefined }));

describe('engine dialog consent at the recall owner boundary', () => {
  it('does not mutate the server draft before asynchronous consent, or after cancellation', async () => {
    api.mockResolvedValue({ ok: true, json: async () => ({ draft: { text: 'existing draft' }, revision: 7 }) });
    let decide!: (accepted: boolean) => void;
    const consent = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    const pending = requestTrueRecall({ threadId: 'pdl-test', messageId: 'message-1', confirmAppend: consent });
    await vi.waitFor(() => expect(consent).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledOnce();
    decide(false);
    await expect(pending).resolves.toBeNull();
    expect(api).toHaveBeenCalledOnce();
    expect(api.mock.calls[0][0]).toBe('/api/threads/pdl-test/composer-draft');
  });
});
