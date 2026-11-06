import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F280 PR wait cutover guards', () => {
  it('TaskStore exposes complete replacement CAS instead of relying on deep patch deletion', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    assert.equal(typeof store.replaceAutomationStateIfGeneration, 'function');
  });
});
