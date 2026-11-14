import { act, memo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useThreadChatSelection } from '../useThreadChatSelection';

let root: Root;
let host: HTMLDivElement;
let selection: ReturnType<typeof useThreadChatSelection>;
const rowRendered = vi.fn();
const historical: ChatMessage = { id: 'history', type: 'user', content: 'Historical body', timestamp: 1 };
const streaming: ChatMessage = {
  id: 'stream',
  type: 'assistant',
  content: 'First token',
  timestamp: 2,
  isStreaming: true,
};
const HistoricalRow = memo(function HistoricalRow(props: {
  onEnter: (id: string) => void;
  onToggle: (id: string) => void;
  onBlock: (id: string, blockId: string) => void;
}) {
  rowRendered();
  return (
    <button type="button" onClick={() => props.onEnter(historical.id)}>
      Select historical message
    </button>
  );
});

function Harness({ messages }: { messages: readonly ChatMessage[] }) {
  selection = useThreadChatSelection(messages);
  return (
    <HistoricalRow
      onEnter={selection.enterMessageSelection}
      onToggle={selection.toggleMessageSelection}
      onBlock={selection.toggleRichBlockSelection}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  rowRendered.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('keeps historical row memoization during sibling token updates', () => {
  act(() => root.render(<Harness messages={[historical, streaming]} />));
  act(() => root.render(<Harness messages={[historical, { ...streaming, content: 'More streamed tokens' }]} />));
  expect(rowRendered).toHaveBeenCalledTimes(1);
  act(() => host.querySelector('button')?.click());
  expect(selection.selectedMessageIds.has(historical.id)).toBe(true);
});

it('existing selection actions read the latest message eligibility and rich blocks', () => {
  act(() => root.render(<Harness messages={[historical, streaming]} />));
  const { enterMessageSelection, toggleMessageSelection, toggleRichBlockSelection } = selection;
  const completed: ChatMessage = {
    ...streaming,
    isStreaming: false,
    extra: {
      rich: {
        v: 1,
        blocks: [
          { id: 'new-card', kind: 'card', v: 1, title: 'New card', bodyMarkdown: 'Arrived after the action mounted' },
        ],
      },
    },
  };
  act(() => root.render(<Harness messages={[historical, completed]} />));
  act(() => enterMessageSelection(completed.id));
  expect(selection.selectedMessageIds.has(completed.id)).toBe(true);
  expect(selection.partSelections.get(completed.id)?.blockIds.has('new-card')).toBe(true);
  act(() => toggleMessageSelection(completed.id));
  expect(selection.selectedMessageIds.has(completed.id)).toBe(false);
  act(() => toggleRichBlockSelection(completed.id, 'new-card'));
  expect(selection.partSelections.get(completed.id)?.blockIds.has('new-card')).toBe(true);

  act(() => root.render(<Harness messages={[historical]} />));
  act(() => {
    enterMessageSelection(completed.id);
    toggleMessageSelection(completed.id);
    toggleRichBlockSelection(completed.id, 'new-card');
  });
  expect(selection.selectedMessageIds.has(completed.id)).toBe(false);
});
