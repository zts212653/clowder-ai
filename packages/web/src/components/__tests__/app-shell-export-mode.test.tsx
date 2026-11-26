import { describe, expect, it, vi } from 'vitest';
import { loadExportThreadTitle, selectMessagesForExport } from '@/components/message-export-selection';

describe('selective export message projection', () => {
  const messages = [{ id: 'message-1' }, { id: 'message-2' }, { id: 'message-3' }];

  it('renders only validated IDs in server-normalized order', () => {
    expect(selectMessagesForExport(messages, ['message-3', 'message-1'])).toEqual({
      messages: [{ id: 'message-3' }, { id: 'message-1' }],
      ready: true,
    });
  });

  it('keeps export readiness closed for missing or duplicate IDs', () => {
    expect(selectMessagesForExport(messages, ['message-1', 'missing'])).toEqual({
      messages: [{ id: 'message-1' }],
      ready: false,
    });
    expect(selectMessagesForExport(messages, ['message-1', 'message-1'])).toEqual({
      messages: [],
      ready: false,
    });
  });

  it('loads authoritative source metadata before declaring the capture ready', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ title: 'F294 source' }), { status: 200 }));
    await expect(loadExportThreadTitle('thread-source', fetcher)).resolves.toBe('F294 source');
    expect(fetcher).toHaveBeenCalledWith('/api/threads/thread-source');
  });
});
