import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { ThreadChatExport } from '../ThreadChatExport';

const diagnostics = {
  reasonCode: 'auth_failed',
  publicSummary: 'API 认证失败',
  publicHint: '',
  debugRef: { command: 'codex', exitCode: 1, signal: null },
};
const errorRow = (id: string, timestamp: number) =>
  ({
    id,
    type: 'system',
    variant: 'error',
    content: 'Error: auth',
    timestamp,
    extra: { cliDiagnostics: diagnostics },
  }) as unknown as ChatMessage;
const messages = [errorRow('head', 1000), errorRow('later', 2000)];

vi.mock('@/hooks/useThreadScopedSelectors', () => ({
  useThreadMessages: () => messages,
  useThreadLiveness: () => ({ catInvocations: {} }),
}));
vi.mock('@/hooks/useChatHistory', () => ({ useChatHistory: () => ({ isLoadingHistory: false }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined, isLoading: false }) }));
vi.mock('../../message-export-selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../message-export-selection')>()),
  loadExportThreadTitle: () => Promise.resolve('导出'),
}));
vi.mock('../../ChatMessage', () => ({
  ChatMessage: ({
    message,
    hideDiagnosticsPanel,
    dedupCount,
  }: {
    message: ChatMessage;
    hideDiagnosticsPanel?: boolean;
    dedupCount?: number;
  }) => (
    <article data-row={message.id} data-hide={String(Boolean(hideDiagnosticsPanel))} data-count={dedupCount ?? ''} />
  ),
}));

describe('ThreadChatExport dedups only the rows it exports', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function exportRows(messageIds: string[]): Promise<void> {
    await act(async () => {
      root.render(<ThreadChatExport threadId="t1" messageIds={messageIds} />);
    });
  }
  const row = (id: string) => container.querySelector(`[data-row="${id}"]`);

  it('keeps the panel of a duplicate exported without the head that would count it', async () => {
    await exportRows(['later']);

    expect(row('head')).toBeNull();
    expect(row('later')?.getAttribute('data-hide')).toBe('false');
    expect(row('later')?.getAttribute('data-count')).toBe('');
  });

  it('still collapses duplicates that are exported together', async () => {
    await exportRows([]);

    expect(row('head')?.getAttribute('data-count')).toBe('2');
    expect(row('later')?.getAttribute('data-hide')).toBe('true');
  });
});
