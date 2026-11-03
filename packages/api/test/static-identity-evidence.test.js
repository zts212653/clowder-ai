import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

for (const failure of ['error', 'abort'])
  test(`a failed ${failure} delivery of role B invalidates previous role A evidence`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const original = catRegistry.getAllConfigs(),
      catId = `review-static-revert-${failure}`,
      threadId = catId;
    const base = {
      ...original.codex,
      id: catId,
      mcpSupport: false,
      configurationSource: 'native_tool',
      accountRef: undefined,
    };
    catRegistry.register(catId, base);
    t.after(() => {
      catRegistry.reset();
      Object.entries(original).forEach(([id, config]) => catRegistry.register(id, config));
    });
    let resume,
      fail = false,
      controller;
    const delivered = [];
    const service = {
      async *invoke(prompt) {
        delivered.push(prompt);
        yield { type: 'session_init', catId, sessionId: 'owned-native-history', timestamp: Date.now() };
        if (fail && failure === 'abort') controller.abort(new Error('owned cancellation after prefix delivery'));
        if (fail && failure === 'error')
          yield {
            type: 'error',
            catId,
            error: 'owned task failed after input',
            errorCode: 'owned-task-failed',
            timestamp: Date.now(),
          };
        yield { type: 'done', catId, ...(fail ? { errorCode: 'owned-task-failed' } : {}), timestamp: Date.now() };
      },
    };
    const { deps } = routingJourneyDeps(undefined, undefined, service);
    deps.invocationDeps.sessionManager.get = async () => resume;
    deps.invocationDeps.sessionManager.store = async (_user, _cat, _thread, id) => {
      resume = id;
    };
    const run = async (body) => {
      const members = catRegistry.getAllConfigs();
      catRegistry.reset();
      Object.entries(members).forEach(([id, config]) =>
        catRegistry.register(id, id === catId ? { ...config, roleDescription: body } : config),
      );
      controller = new AbortController();
      await Array.fromAsync(
        invokeSingleCat(deps.invocationDeps, {
          catId,
          service,
          userId: 'review-owner',
          threadId,
          prompt: 'owned task',
          systemPrompt: body,
          isLastCat: true,
          ownerAuthProvenance: 'strict',
          signal: controller.signal,
        }),
      );
    };
    await run('REVIEW_ROLE_A');
    fail = true;
    await run('REVIEW_ROLE_B');
    assert.match(delivered[0], /REVIEW_ROLE_A/);
    assert.match(delivered[1], /REVIEW_ROLE_B/, 'new identity reached the same native conversation before failure');
    fail = false;
    await run('REVIEW_ROLE_A');
    assert.equal(delivered.length, 3);
    assert.match(delivered[2], /REVIEW_ROLE_A/, 'reverting after a failed different identity needs a current prefix');
  });

test('an unaccepted native binding cannot certify delivery to the old resume coordinate', async (t) => {
  t.after(isolateAccountAuthEnvironment());
  const original = catRegistry.getAllConfigs(),
    catId = 'review-static-unaccepted-binding',
    threadId = catId;
  catRegistry.register(catId, {
    ...original.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  });
  t.after(() => {
    catRegistry.reset();
    Object.entries(original).forEach(([id, config]) => catRegistry.register(id, config));
  });
  const chain = new SessionChainStore();
  const getActive = chain.getActive.bind(chain);
  let resume,
    native = 'native-A',
    faultDuringInit = false,
    faulted = false,
    atNativeInit = false;
  chain.getActive = (...args) => {
    if (faultDuringInit && atNativeInit && !faulted) {
      faulted = true;
      throw new Error('controlled binding read unavailable');
    }
    return getActive(...args);
  };
  const delivered = [];
  const service = {
    async *invoke(prompt) {
      delivered.push({ native, prompt });
      atNativeInit = true;
      yield { type: 'session_init', catId, sessionId: native, timestamp: Date.now() };
      atNativeInit = false;
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const { deps } = routingJourneyDeps(undefined, undefined, service);
  deps.invocationDeps.sessionChainStore = chain;
  deps.invocationDeps.sessionManager.get = async () => resume;
  deps.invocationDeps.sessionManager.store = async (_user, _cat, _thread, id) => {
    resume = id;
  };
  const run = (body) =>
    Array.fromAsync(
      invokeSingleCat(deps.invocationDeps, {
        catId,
        service,
        userId: 'review-owner',
        threadId,
        prompt: 'owned task',
        systemPrompt: body,
        isLastCat: true,
        ownerAuthProvenance: 'strict',
      }),
    );
  await run('REVIEW_ROLE_A');
  assert.equal(chain.getActive(catId, threadId, 'review-owner').cliSessionId, 'native-A');
  native = 'native-B';
  faultDuringInit = true;
  const second = await run('REVIEW_ROLE_B');
  assert.equal(faulted, true);
  assert.equal(
    second.some((message) => message.type === 'error'),
    false,
    'this is the existing best-effort binding read path',
  );
  assert.match(delivered[1].prompt, /REVIEW_ROLE_B/);
  assert.equal(
    chain.getActive(catId, threadId, 'review-owner').cliSessionId,
    'native-A',
    'new coordinate was never accepted',
  );
  assert.equal(resume, 'native-A');
  native = 'native-A';
  faultDuringInit = false;
  await run('REVIEW_ROLE_B');
  assert.equal(delivered[2].native, 'native-A');
  assert.match(delivered[2].prompt, /REVIEW_ROLE_B/, 'native-A never received the prefix sent to native-B');
});
