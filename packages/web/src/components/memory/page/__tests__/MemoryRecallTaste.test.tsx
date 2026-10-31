import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRecallTaste } from '../MemoryRecallTaste';
import { MemoryTasteCard } from '../MemoryTasteCard';
import { taste, tasteEntry } from './recall-page-fixture';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => null, isLoading: false }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('../MemoryTasteDetail', () => ({ MemoryTasteDetail: () => null }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it.each([
  '先看实物',
  '“先看实物”',
  '“先看实物”——再判断。',
])('the ranked original uses the same framing as the all-memory card: %s', async (quote) => {
  const entry = { ...tasteEntry('record', 14), title: '索引标题', quotes: [quote] };
  await act(() =>
    root.render(
      <>
        <MemoryTasteCard entry={entry} selected={false} select={() => {}} />
        <MemoryRecallTaste taste={{ data: taste([entry]), loading: false, error: false, retry: () => {} }} />
      </>,
    ),
  );
  const cardLead = host.querySelector('[data-testid="taste-card"] p')?.textContent;
  expect(host.querySelector('section > button')?.textContent).toContain(cardLead);
  expect(host.querySelector('section > button')?.textContent).not.toContain('索引标题');
});
