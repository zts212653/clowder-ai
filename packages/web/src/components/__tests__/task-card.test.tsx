import type { CatId, TaskItem } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId, size }: { catId: string; size: number }) => (
    <span data-testid="cat-avatar" data-cat-id={catId} data-size={size} />
  ),
}));

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 't1',
    subjectKey: null,
    title: 'Fix the redirect bug',
    why: 'Users keep getting 404 after login',
    ownerCatId: 'opus' as CatId,
    status: 'doing',
    createdBy: 'user',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('TaskCard', () => {
  it('renders task title and status pill', async () => {
    const { TaskCard } = await import('../TaskCard');
    const html = renderToStaticMarkup(<TaskCard task={makeTask()} onStatusChange={vi.fn()} />);
    expect(html).toContain('Fix the redirect bug');
    expect(html).toContain('进行中'); // doing status label
  });

  it('renders owner avatar when ownerCatId is set', async () => {
    const { TaskCard } = await import('../TaskCard');
    const html = renderToStaticMarkup(<TaskCard task={makeTask()} onStatusChange={vi.fn()} />);
    expect(html).toContain('data-cat-id="opus"');
  });

  it('does not render avatar when ownerCatId is null', async () => {
    const { TaskCard } = await import('../TaskCard');
    const html = renderToStaticMarkup(<TaskCard task={makeTask({ ownerCatId: null })} onStatusChange={vi.fn()} />);
    expect(html).not.toContain('data-cat-id');
  });

  it('applies blocked highlight styles', async () => {
    const { TaskCard } = await import('../TaskCard');
    const html = renderToStaticMarkup(<TaskCard task={makeTask({ status: 'blocked' })} onStatusChange={vi.fn()} />);
    expect(html).toContain('border-l-cafe-accent');
  });

  it('applies doing crosspost styles', async () => {
    const { TaskCard } = await import('../TaskCard');
    const html = renderToStaticMarkup(<TaskCard task={makeTask({ status: 'doing' })} onStatusChange={vi.fn()} />);
    expect(html).toContain('border-l-cafe-crosspost');
  });
});
