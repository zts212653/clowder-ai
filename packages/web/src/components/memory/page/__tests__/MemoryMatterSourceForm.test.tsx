import type { MatterEntryView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryMatterSourceForm } from '../MemoryMatterSourceForm';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
let host: HTMLDivElement;
let root: Root;
const entry: MatterEntryView = {
  entryId: 'mixed',
  status: 'active',
  sourceStatus: 'current',
  attribution: 'author',
  summary: 'Existing interpretation',
  quote: '  Exact excerpt\n',
  source: {
    threadId: 'source',
    messageId: 'original',
    segment: 'body',
    start: 4,
    end: 20,
    sourceRevision: 'raw-r1',
    author: { kind: 'agent', catId: 'codex61-sol' },
    timestamp: 1,
  },
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

it('preserves the original raw quotation and coordinates when only the interpretation is corrected', async () => {
  const submit = vi.fn();
  await act(() => root.render(<MemoryMatterSourceForm entry={entry} submit={submit} cancel={() => {}} busy={false} />));
  const quote = host.querySelector<HTMLTextAreaElement>('[aria-label="引用原文"]');
  expect(quote?.value).toBe(entry.quote);
  const summary = host.querySelector<HTMLTextAreaElement>('[aria-label="归纳（非原话）"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      summary,
      'Corrected interpretation',
    );
    summary?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(submit).toHaveBeenCalledWith({
    summary: 'Corrected interpretation',
    source: {
      threadId: 'source',
      messageId: 'original',
      segment: 'body',
      start: 4,
      end: 20,
      quote: entry.quote,
    },
  });
  expect(request).not.toHaveBeenCalled();
});

it('does not treat an existing exact whitespace quotation as an empty optional field', async () => {
  const submit = vi.fn();
  const whitespace = { ...entry, quote: '  \n ' };
  await act(() =>
    root.render(<MemoryMatterSourceForm entry={whitespace} submit={submit} cancel={() => {}} busy={false} />),
  );
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ source: expect.objectContaining({ segment: 'body', quote: '  \n ' }) }),
  );
  expect(request).not.toHaveBeenCalled();
});
