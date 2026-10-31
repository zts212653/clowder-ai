import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayEvent } from '@/lib/story-player/types';

vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (catId: string) => catId }));

import { ReplayEventBubble } from '../ReplayEventBubble';

describe('ReplayEventBubble F269 long-form recovery', () => {
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

  it('opens the complete tool result instead of a sliced preview', async () => {
    const tail = 'F269_TOOL_RESULT_TAIL_SENTINEL';
    const event: ReplayEvent = {
      index: 0,
      type: 'tool_call',
      timestamp: 1,
      role: 'assistant',
      content: '',
      toolName: 'cat_cafe_read_invocation_detail',
      toolResult: `${'完整结果。'.repeat(700)}${tail}`,
      catId: 'codex-sol',
      eventNo: 1,
    };

    await act(async () => {
      root.render(<ReplayEventBubble event={event} displayMode="faithful" isRevealing={false} speedMultiplier={100} />);
    });

    const toolToggle = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    await act(async () => toolToggle?.click());

    const reader = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(reader?.textContent).toContain('阅读全文');
    expect(container.textContent).not.toContain('chars truncated');

    await act(async () => reader?.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(tail);
  });
});
