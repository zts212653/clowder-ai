import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clickBootcampButton,
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar bootcamp entry', () => {
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

  it('keeps the bootcamp entry directly to the left of new conversation', async () => {
    await harness.render();

    const bootcamp = harness.container.querySelector('[data-testid="sidebar-bootcamp"]');
    const newThread = harness.container.querySelector('[data-guide-id="sidebar.new-thread"]');

    expect(bootcamp).not.toBeNull();
    expect(newThread).not.toBeNull();
    expect(bootcamp?.compareDocumentPosition(newThread as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('opens the bootcamp list from the sidebar entry', async () => {
    await harness.render();

    await clickBootcampButton(harness.container, harness.flush);

    expect(harness.container.querySelector('[data-testid="bootcamp-list-modal"]')).not.toBeNull();
  });
});
