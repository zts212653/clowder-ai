import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './browser/f307-workspace-open.mjs';

function createPage({ toggle, workbench }) {
  return {
    getByTestId(testId) {
      if (testId === 'workspace-panel-toggle') return toggle;
      if (testId === 'f307-experience-workbench') return workbench;
      throw new Error(`unexpected test id: ${testId}`);
    },
    url() {
      return 'http://example.test/thread/f307';
    },
    locator(selector) {
      if (selector === '[data-testid="workspace-panel-toggle"][data-client-interactive="true"]') {
        return {
          async waitFor() {},
        };
      }
      assert.equal(selector, 'body');
      return {
        async innerText() {
          return 'fixture';
        },
      };
    },
  };
}

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
  const page = createPage({ toggle, workbench });

  await ensureWorkspaceOpen(page, { attempts: 3, waitMs: 1 });

  assert.equal(state, 'open');
  assert.equal(clicks, 1, 'a late successful open must not be toggled closed');
});

test('a restored open workspace cancels a stale toggle action between label read and click', async () => {
  let visible = false;
  let clicks = 0;
  const workbench = {
    async isVisible() {
      return visible;
    },
    async waitFor() {
      if (!visible) throw new Error('not visible');
    },
  };
  const toggle = {
    async waitFor() {},
    async getAttribute(name) {
      assert.equal(name, 'aria-label');
      visible = true;
      return '打开 Workspace';
    },
    async click() {
      clicks += 1;
      throw new Error('the restored workspace overlay intercepted the stale toggle');
    },
  };
  const page = createPage({ toggle, workbench });

  await ensureWorkspaceOpen(page, { attempts: 1, waitMs: 1 });

  assert.equal(visible, true);
  assert.equal(clicks, 0, 'the stale closed-state observation must be revalidated before acting');
});

test('a workspace that opens during the bounded click makes its intercepted action obsolete', async () => {
  let visible = false;
  let clicks = 0;
  const workbench = {
    async isVisible() {
      return visible;
    },
    async waitFor() {
      if (!visible) throw new Error('not visible');
    },
  };
  const toggle = {
    async waitFor() {},
    async getAttribute(name) {
      assert.equal(name, 'aria-label');
      return '打开 Workspace';
    },
    async click(options) {
      assert.equal(options.timeout, 7);
      clicks += 1;
      visible = true;
      throw new Error('the now-open workspace intercepted the in-flight click');
    },
  };
  const page = createPage({ toggle, workbench });

  await ensureWorkspaceOpen(page, { attempts: 1, waitMs: 1, actionTimeoutMs: 7 });

  assert.equal(clicks, 1);
  assert.equal(visible, true);
});

test('an actually unavailable closed toggle still fails instead of being swallowed', async () => {
  const workbench = {
    async isVisible() {
      return false;
    },
    async waitFor() {
      throw new Error('not visible');
    },
  };
  const toggle = {
    async waitFor() {},
    async getAttribute(name) {
      assert.equal(name, 'aria-label');
      return '打开 Workspace';
    },
    async click() {
      throw new Error('toggle remains covered while the workspace is closed');
    },
  };
  const page = createPage({ toggle, workbench });

  await assert.rejects(
    ensureWorkspaceOpen(page, { attempts: 1, waitMs: 1, actionTimeoutMs: 7 }),
    /toggle remains covered while the workspace is closed/,
  );
});
