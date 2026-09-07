import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './browser/f307-workspace-open.mjs';

test('a visibility acknowledgement at the wait boundary never triggers a closing toggle', async () => {
  let state = 'closed';
  let clicks = 0;
  const workbench = {
    async isVisible() {
      return state === 'open';
    },
    async waitFor() {
      if (state === 'opening') {
        state = 'open';
        throw new Error('the bounded wait expired as the workbench became visible');
      }
      if (state !== 'open') throw new Error('not visible');
    },
  };
  const toggle = {
    async waitFor() {},
    async getAttribute(name) {
      assert.equal(name, 'aria-label');
      return state === 'open' ? '收起 Workspace' : '打开 Workspace';
    },
    async click() {
      clicks += 1;
      state = state === 'closed' ? 'opening' : 'closed';
    },
  };
  const page = {
    getByTestId(testId) {
      if (testId === 'workspace-panel-toggle') return toggle;
      if (testId === 'f307-experience-workbench') return workbench;
      throw new Error(`unexpected test id: ${testId}`);
    },
    url() {
      return 'http://example.test/thread/f307';
    },
    locator() {
      return {
        async innerText() {
          return 'fixture';
        },
      };
    },
  };

  await ensureWorkspaceOpen(page, { attempts: 3, waitMs: 1 });

  assert.equal(state, 'open');
  assert.equal(clicks, 1, 'a late successful open must not be toggled closed');
});
