import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar Mission Hub entry', () => {
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

  it('does not render duplicate Mission Hub entry (F206 Phase C — left nav already has it)', async () => {
    await harness.render();

    const missionEntry = harness.container.querySelector('[data-testid="sidebar-mission-control"]');
    expect(missionEntry).toBeNull();
  });
});
