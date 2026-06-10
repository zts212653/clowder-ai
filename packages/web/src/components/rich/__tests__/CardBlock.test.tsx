import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { CardBlock } from '../CardBlock';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

describe('CardBlock — unhandled action defense (F225 dogfood)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // A card whose action THIS build doesn't handle (e.g. a stale browser bundle rendering a newer
  // `handoff:approve` card via the generic CardBlock) silently no-ops — exactly the F225 dogfood P0.
  // The generic renderer must warn so "stale bundle + new action card" self-diagnoses → hard-refresh.
  it('warns when an unhandled card action is clicked (self-diagnosing for stale bundle)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block: RichCardBlock = {
      id: 'card_1',
      kind: 'card',
      v: 1,
      title: '🔄 提议 session 接力',
      actions: [{ label: '批准并接力', action: 'handoff:approve', payload: { proposalId: 'p1' } }],
    };
    await act(async () => {
      root.render(<CardBlock block={block} />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('handoff:approve');
  });
});
