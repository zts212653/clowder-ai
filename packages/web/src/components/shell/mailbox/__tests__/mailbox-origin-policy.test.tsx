import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { resolveOriginalPlace } from '../original-place';
import { PlaceAction } from '../PlaceAction';
import { approvalRow, storeItem } from './mailbox-fixtures';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

it('uses the canonical approval-card anchor for a normal approval too', () => {
  const item = approvalRow(storeItem());
  expect(resolveOriginalPlace(item)).toEqual({ kind: 'exact', actionRef: 'message:thread-src:approval-card' });
});

it('omits an unavailable original-place link beside a hosted decision', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<PlaceAction quiet place={{ kind: 'list', destination: 'approval' }} onOpen={() => {}} />),
    );
    expect(container.textContent).toBe('');
    expect(container.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
