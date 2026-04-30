import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar mission-hub compact link', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  it('no longer renders Mission Hub link in sidebar (F170: moved to ActivityBar)', async () => {
    await harness.render();
    // F170: Mission Hub link was moved from ThreadSidebar to ActivityBar
    const link = harness.container.querySelector('[data-testid="sidebar-mission-hub"]');
    expect(link).toBeNull();
  });
});
