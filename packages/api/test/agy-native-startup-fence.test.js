import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'f325-native-startup-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(root, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
    },
    l0CompilerFn: async () => '# Identity\nStable startup identity.\n',
  });
  const running = [];
  const controllers = [];
  const gates = [];
  const gate = () => {
    const next = deferred();
    gates.push(next);
    return next;
  };
  const run = (spawnCliOverride, extra = {}, onMessage) => {
    const controller = new AbortController();
    controllers.push(controller);
    const result = (async () => {
      const messages = [];
      for await (const message of service.invoke('work', {
        workingDirectory: workspace,
        signal: controller.signal,
        spawnCliOverride,
        ...extra,
      })) {
        messages.push(message);
        onMessage?.(message);
      }
      return messages;
    })();
    running.push(result);
    return { result, controller };
  };
  return {
    gate,
    run,
    async dispose() {
      for (const controller of controllers) controller.abort();
      for (const barrier of gates) barrier.resolve();
      await Promise.allSettled(running);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function init(launch, id) {
  return {
    event: 'init',
    conversation_id: id,
    init: {
      cwd: launch.cwd,
      agent: launch.args[launch.args.indexOf('--agent') + 1],
      model: 'gemini-3.8-flash-high',
      permission_mode: 'request-review',
      tools: [],
    },
  };
}

function done(id) {
  return { event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Complete.', num_turns: 1 } };
}

async function eventually(promise) {
  const controller = new AbortController();
  try {
    await Promise.race([
      promise,
      delay(2000, undefined, { signal: controller.signal }).then(() => {
        throw new Error('Expected independent startup did not arrive');
      }),
    ]);
  } finally {
    controller.abort();
  }
}

test('shared native index opens do not overlap before verified init; model work remains concurrent', async () => {
  const f = fixture();
  const opening = f.gate();
  const allowInit = f.gate();
  const finishA = f.gate();
  const startedB = f.gate();
  let bOpened = false;
  let aFinished = false;
  try {
    const a = f.run(async function* (launch) {
      opening.resolve();
      await allowInit.promise;
      yield init(launch, 'A');
      await finishA.promise;
      aFinished = true;
      yield done('A');
    });
    await opening.promise;
    const b = f.run(async function* (launch) {
      bOpened = true;
      yield init(launch, 'B');
      startedB.resolve();
      yield done('B');
    });
    await delay(350);
    assert.equal(bOpened, false, 'another CLI must not open/recreate the shared index during A startup');
    allowInit.resolve();
    await eventually(startedB.promise);
    assert.equal(aFinished, false, 'B must start without waiting for A model work to finish');
    assert.equal((await b.result).at(-1).errorCode, undefined);
    finishA.resolve();
    assert.equal((await a.result).at(-1).errorCode, undefined);
  } finally {
    await f.dispose();
  }
});

test('a same-conversation waiter cannot retain the account startup fence and block another conversation', async () => {
  const f = fixture();
  const firstInit = f.gate();
  const finishA = f.gate();
  const startedC = f.gate();
  let bOpened = false;
  try {
    f.run(
      async function* (launch) {
        yield init(launch, 'A');
        await finishA.promise;
        yield done('A');
      },
      {},
      (message) => {
        if (message.type === 'session_init') firstInit.resolve(message.nativeSessionBinding);
      },
    );
    const binding = await firstInit.promise;
    const b = f.run(
      async function* (launch) {
        bOpened = true;
        yield init(launch, 'A');
        yield done('A');
      },
      { sessionId: 'A', nativeSessionBinding: binding },
    );
    await delay(350);
    const c = f.run(async function* (launch) {
      yield init(launch, 'C');
      startedC.resolve();
      yield done('C');
    });
    await eventually(startedC.promise);
    assert.equal(bOpened, false);
    assert.equal((await c.result).at(-1).errorCode, undefined);
    b.controller.abort();
    assert.equal((await b.result).at(-1).errorCode, 'AGY_CANCELLED');
    finishA.resolve();
  } finally {
    await f.dispose();
  }
});

test('cancel before init retains the startup fence until its provider actually drains', async () => {
  const f = fixture();
  const opening = f.gate();
  const drained = f.gate();
  const startedB = f.gate();
  let bOpened = false;
  try {
    const a = f.run(async function* (launch) {
      opening.resolve();
      await drained.promise;
      yield init(launch, 'late-A');
    });
    await opening.promise;
    a.controller.abort();
    const b = f.run(async function* (launch) {
      bOpened = true;
      yield init(launch, 'B');
      startedB.resolve();
      yield done('B');
    });
    await delay(350);
    assert.equal(bOpened, false, 'abort is not proof that the first CLI has stopped using the index');
    drained.resolve();
    assert.equal((await a.result).at(-1).errorCode, 'AGY_CANCELLED');
    await eventually(startedB.promise);
    assert.equal((await b.result).at(-1).errorCode, undefined);
  } finally {
    await f.dispose();
  }
});

test('rejected init retires startup ownership so another conversation can start', async () => {
  const f = fixture();
  const startedB = f.gate();
  try {
    const a = f.run(async function* (launch) {
      const event = init(launch, 'wrong-model');
      event.init.model = 'unexpected-model';
      yield event;
    });
    assert.ok((await a.result).some((message) => message.type === 'error'));
    const b = f.run(async function* (launch) {
      yield init(launch, 'B');
      startedB.resolve();
      yield done('B');
    });
    await eventually(startedB.promise);
    assert.equal((await b.result).at(-1).errorCode, undefined);
  } finally {
    await f.dispose();
  }
});
