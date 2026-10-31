import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { createOwnerLocalNoteProfile } from '../src/domains/concierge/live/host/owner-local-note-profile.ts';

const { createHostLaunchedLocalNoteConnector } = await import(
  process.env.F317_TEST_COMPILED_ACTOR === '1'
    ? '../dist/domains/concierge/action/LocalNoteTrialConnector.js'
    : '../src/domains/concierge/action/LocalNoteTrialConnector.ts'
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settledWithin(promise, ms = 400) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        (error) => `rejected:${error.message}`,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function hosted(t) {
  const started = await startFixtureServer();
  t.after(async () => new Promise((resolve) => started.server.close(resolve)));
  return { started, profile: createOwnerLocalNoteProfile(started.url) };
}

test('abort while browser context creation hangs settles and closes a late context', async (t) => {
  const { started, profile } = await hosted(t);
  const created = deferred();
  let closeCalls = 0;
  let newPageCalls = 0;
  const context = {
    newPage() {
      newPageCalls++;
      throw new Error('late context must not create a page');
    },
    async close() {
      closeCalls++;
    },
  };
  const connector = createHostLaunchedLocalNoteConnector(started, { createBrowserContext: () => created.promise });
  const controller = new AbortController();
  const opening = connector.open(profile, controller.signal);
  controller.abort();
  assert.equal(await settledWithin(opening), 'rejected:Local note connector cleanup unconfirmed');
  created.resolve(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newPageCalls, 0);
  assert.equal(closeCalls, 1);
});

for (const closeBehavior of ['resolve', 'reject', 'hang']) {
  test(`late context with ${closeBehavior} close reports its cleanup outcome to Host`, async (t) => {
    const { started, profile } = await hosted(t);
    const created = deferred();
    let closeCalls = 0;
    let newPageCalls = 0;
    const context = {
      newPage() {
        newPageCalls++;
        throw new Error('aborted context must not create a page');
      },
      close() {
        closeCalls++;
        if (closeBehavior === 'resolve') return Promise.resolve();
        if (closeBehavior === 'reject') return Promise.reject(new Error('CDP close failed'));
        return new Promise(() => {});
      },
    };
    const connector = createHostLaunchedLocalNoteConnector(started, { createBrowserContext: () => created.promise });
    const controller = new AbortController();
    const opening = connector.open(profile, controller.signal);
    controller.abort();
    created.resolve(context);
    assert.equal(
      await settledWithin(opening),
      closeBehavior === 'resolve'
        ? 'rejected:Local note connector stopped'
        : 'rejected:Local note connector cleanup unconfirmed',
    );
    assert.equal(closeCalls, 1);
    assert.equal(newPageCalls, 0);
  });
}

test('abort while newPage hangs settles, initiates close and never navigates a late page', async (t) => {
  const { started, profile } = await hosted(t);
  const pageStarted = deferred();
  const latePage = deferred();
  let closeCalls = 0;
  let gotoCalls = 0;
  let pageCloseCalls = 0;
  const context = {
    newPage() {
      pageStarted.resolve();
      return latePage.promise;
    },
    async close() {
      closeCalls++;
    },
  };
  const connector = createHostLaunchedLocalNoteConnector(started, { createBrowserContext: async () => context });
  const controller = new AbortController();
  const opening = connector.open(profile, controller.signal);
  await pageStarted.promise;
  controller.abort();
  assert.equal(await settledWithin(opening), 'rejected:Local note connector cleanup unconfirmed');
  assert.equal(closeCalls, 1);
  latePage.resolve({
    goto() {
      gotoCalls++;
    },
    async close() {
      pageCloseCalls++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gotoCalls, 0);
  assert.equal(pageCloseCalls, 1);
});

test('abort during a hung goto initiates close and an uncooperative close cannot hang open', async (t) => {
  const { started, profile } = await hosted(t);
  const navigating = deferred();
  let closeCalls = 0;
  const page = {
    goto() {
      navigating.resolve();
      return new Promise(() => {});
    },
  };
  const context = {
    async newPage() {
      return page;
    },
    close() {
      closeCalls++;
      return new Promise(() => {});
    },
  };
  const connector = createHostLaunchedLocalNoteConnector(started, { createBrowserContext: async () => context });
  const controller = new AbortController();
  const opening = connector.open(profile, controller.signal);
  await navigating.promise;
  controller.abort();
  assert.equal(await settledWithin(opening), 'rejected:Local note connector cleanup unconfirmed');
  assert.equal(closeCalls, 1);
});

test('navigation failure closes the context before rejecting', async (t) => {
  const { started, profile } = await hosted(t);
  let closeCalls = 0;
  const context = {
    async newPage() {
      return {
        async goto() {
          throw new Error('navigation failed');
        },
      };
    },
    async close() {
      closeCalls++;
    },
  };
  const connector = createHostLaunchedLocalNoteConnector(started, { createBrowserContext: async () => context });
  await assert.rejects(connector.open(profile, new AbortController().signal), /navigation failed/);
  assert.equal(closeCalls, 1);
});
