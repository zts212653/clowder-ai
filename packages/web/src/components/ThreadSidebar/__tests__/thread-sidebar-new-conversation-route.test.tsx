import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('F322 new-conversation entry', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(installThreadSidebarGlobals);
  afterAll(resetThreadSidebarGlobals);

  beforeEach(() => {
    resetThreadSidebarMocks();
    mockStore.currentThreadId = 'thread-current';
    window.history.replaceState({}, '', '/thread/thread-current');
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('routes the v2 entry to the full root landing without opening the classic modal', async () => {
    writeShellPresentation('v2');
    await harness.render({ routeThreadId: 'thread-current' });

    const button = harness.container.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-thread"]');
    if (!button) throw new Error('v2 new-conversation entry is missing');
    act(() => button.click());
    await harness.flush();

    expect(window.location.pathname).toBe('/');
    expect(harness.container.textContent).not.toContain('新建对话');
  });

  it('keeps the classic entry on its existing creation modal', async () => {
    writeShellPresentation('classic');
    await harness.render({ routeThreadId: 'thread-current' });

    const button = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes('新对话'),
    );
    if (!button) throw new Error('classic new-conversation entry is missing');
    act(() => button.click());
    await harness.flush();

    expect(window.location.pathname).toBe('/thread/thread-current');
    expect(harness.container.textContent).toContain('新建对话');
  });
});
