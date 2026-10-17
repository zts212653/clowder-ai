import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

let auditDir;
let previousAuditDir;
before(async () => {
  previousAuditDir = process.env.AUDIT_LOG_DIR;
  auditDir = await mkdtemp(join(tmpdir(), 'public-child-execution-'));
  process.env.AUDIT_LOG_DIR = auditDir;
});
after(async () => {
  if (previousAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = previousAuditDir;
  await rm(auditDir, { recursive: true, force: true });
});

function fixture(t) {
  const registry = new InvocationRegistry();
  const turns = new InMemoryTurnExecutionStore();
  const state = { reads: [], events: [], starts: 0, closes: 0, disposals: 0, exposures: 0, current: true };
  const controller = new AbortController();
  const forbidden = (name) => () => {
    state.reads.push(name);
    throw new Error('forbidden_owner_context_read');
  };
  const launch = {
    server: {
      name: 'native',
      command: '/fake/package',
      args: [],
      env: {},
      workingDirectory: '/fake/package-root',
      transport: 'stdio',
    },
    sandbox: { kind: 'public', workspaceRoot: '/fake/owned-public-workspace' },
    async assertCurrent() {
      state.events.push('current');
      controller.signal.throwIfAborted();
      if (!state.current) throw new Error('public_authority_revoked');
    },
  };
  const prepared = {
    source: { messageId: 'source-1', content: 'public source only' },
    launch,
    async dispose() {
      state.disposals++;
      state.events.push('dispose');
    },
  };
  const port = {
    async prepare(input) {
      state.events.push('prepare');
      state.prepareInput = input;
      await launch.assertCurrent();
      return prepared;
    },
  };
  const params = {
    catId: 'codex',
    userId: 'owner',
    threadId: 'thread',
    ownerAuthProvenance: 'unknown',
    prompt: 'public source only',
    isLastCat: true,
    signal: controller.signal,
    executionCausal: { triggerMessageId: 'source-1' },
    promptMessageIds: ['source-1'],
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'native',
      actionMethods: ['native.read'],
    },
    publicInvocationBinding: {
      version: 1,
      entryId: 'entry-1',
      carrier: {
        version: 1,
        admissionId: 'admission-1',
        sourceMessageId: 'source-1',
        sourcePluginRevision: 1,
        pluginInstanceId: 'instance',
        packageDigest: 'digest',
        lifecycleRevision: 1,
        grantRevision: 0,
        contributionId: 'native',
        actionMethods: ['native.read'],
        targetCatId: 'codex',
        authorityRef: 'authority',
        authorityRevision: 'r1',
      },
    },
    publicInvocationExecution: port,
    async onPromptMessagesExposed(input) {
      state.exposures++;
      state.events.push('exposure');
      state.exposureInput = input;
    },
    service: {
      supportsToolExecutionPolicy: () => true,
      async *invoke(prompt, options) {
        state.starts++;
        state.events.push('provider');
        state.prompt = prompt;
        state.options = options;
        try {
          yield { type: 'text', catId: 'codex', content: 'public result @opus', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        } finally {
          state.closes++;
        }
      },
    },
  };
  const deps = {
    registry,
    turnExecutionStore: turns,
    apiUrl: 'http://127.0.0.1:1',
    sessionManager: {
      get: forbidden('session'),
      getOrCreate: forbidden('session-create'),
      resolveWorkingDirectory: forbidden('workspace'),
    },
    threadStore: { get: forbidden('thread') },
    workflowSopStore: { bindManagedWorkAttempt: forbidden('work') },
    profileCueOpportunitySource: { prepareOpportunity: forbidden('profile') },
    eventCueOpportunitySource: { prepareOpportunity: forbidden('memory') },
  };
  const iterator = invokeSingleCat(deps, params)[Symbol.asyncIterator]();
  t.after(async () => {
    await iterator.return();
  });
  return { state, params, registry, turns, iterator, controller, port, launch, prepared };
}
async function created(f) {
  const first = await f.iterator.next();
  assert.equal(first.done, false);
  const child = JSON.parse(first.value.content);
  assert.equal(child.type, 'invocation_created');
  assert.equal((await f.turns.get(child.invocationId)).status, 'running');
  assert.equal((await f.registry.getRecord(child.invocationId)).publicInvocationBinding.entryId, 'entry-1');
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.exposures, 0);
  assert.deepEqual(f.state.reads, []);
  f.childId = child.invocationId;
}
async function drain(f) {
  const messages = [];
  for (;;) {
    const next = await f.iterator.next();
    if (next.done) return messages;
    messages.push(next.value);
  }
}
function isolated(f) {
  assert.deepEqual(f.state.reads, [], 'missing isolated public child execution');
}
async function terminal(f, status) {
  assert.equal((await f.turns.get(f.childId)).status, status);
  assert.notEqual((await f.registry.getRecord(f.childId)).state, 'active');
}

test('public execution fixture registers a paused child without context or provider access', async (t) => {
  const f = fixture(t);
  await created(f);
  await f.iterator.return();
  await terminal(f, 'interrupted');
});

test('public child resumes through exact launch with no owner context or second execution', async (t) => {
  const f = fixture(t);
  f.params.prompt = 'OWNER PRIVATE HISTORY AND SYSTEM INSTRUCTIONS';
  await created(f);
  const messages = await drain(f);
  isolated(f);
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.exposures, 1);
  assert.equal(f.state.disposals, 1);
  assert.equal(f.state.prompt, 'public source only');
  assert.equal(f.state.prepareInput.invocationId, f.childId);
  assert.equal(f.state.exposureInput.invocationId, f.childId);
  assert.deepEqual(f.state.exposureInput.messageIds, ['source-1']);
  assert.ok(f.state.events.indexOf('exposure') < f.state.events.indexOf('provider'));
  assert.equal(f.state.options.pluginNativeLaunch.sandbox.kind, 'public');
  assert.equal(f.state.options.workingDirectory, f.launch.sandbox.workspaceRoot);
  assert.equal(f.state.options.callbackEnv.CAT_CAFE_INVOCATION_ID, f.childId);
  for (const key of ['sessionId', 'systemPrompt', 'contentBlocks', 'continuity', 'liveCompanion', 'requiredTools'])
    assert.equal(f.state.options[key], undefined);
  assert.equal(
    messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    'public result @opus',
  );
  await terminal(f, 'succeeded');
});

test('public child with missing execution port fails before exposure or ordinary fallback', async (t) => {
  const f = fixture(t);
  delete f.params.publicInvocationExecution;
  await created(f);
  const messages = await drain(f);
  isolated(f);
  assert.equal(f.state.exposures, 0);
  assert.equal(f.state.starts, 0);
  assert.ok(messages.some((m) => m.type === 'error' && /public/i.test(m.error)));
  await terminal(f, 'failed');
});

test('public authority rejected during prepare never exposes source or starts provider', async (t) => {
  const f = fixture(t);
  await created(f);
  f.state.current = false;
  await drain(f);
  isolated(f);
  assert.equal(f.state.exposures, 0);
  assert.equal(f.state.starts, 0);
  await terminal(f, 'failed');
});

test('public exposure persistence failure disposes launch and prevents provider start', async (t) => {
  const f = fixture(t);
  f.params.onPromptMessagesExposed = async () => {
    throw new Error('exposure_store_unavailable');
  };
  await created(f);
  await drain(f);
  isolated(f);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});

test('public revocation during exposure is checked again before provider start', async (t) => {
  const f = fixture(t);
  f.params.onPromptMessagesExposed = async () => {
    f.state.exposures++;
    f.state.current = false;
  };
  await created(f);
  await drain(f);
  isolated(f);
  assert.equal(f.state.exposures, 1);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});

test('public text delivered after revocation is withheld and provider closes', async (t) => {
  const f = fixture(t);
  f.params.service.invoke = async function* () {
    f.state.starts++;
    try {
      f.state.current = false;
      yield { type: 'text', catId: 'codex', content: 'revoked result', timestamp: Date.now() };
    } finally {
      f.state.closes++;
    }
  };
  await created(f);
  const messages = await drain(f);
  isolated(f);
  assert.equal(
    messages.some((m) => m.type === 'text'),
    false,
  );
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});

test('public done received after revocation cannot make canonical child successful', async (t) => {
  const f = fixture(t);
  f.params.service.invoke = async function* () {
    f.state.starts++;
    f.state.current = false;
    yield { type: 'done', catId: 'codex', timestamp: Date.now() };
  };
  await created(f);
  await drain(f);
  isolated(f);
  assert.equal(f.state.starts, 1);
  await terminal(f, 'failed');
});

test('public transient provider error never retries or resumes an owner session', async (t) => {
  const f = fixture(t);
  f.params.service.invoke = async function* () {
    f.state.starts++;
    throw new Error('stream disconnected before completion: connection reset');
  };
  await created(f);
  await drain(f);
  isolated(f);
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});

test('public execution captures the Host prepare function before the registration await', async (t) => {
  const f = fixture(t);
  const pending = created(f);
  f.port.prepare = async () => {
    throw new Error('replaced_prepare');
  };
  await pending;
  const messages = await drain(f);
  isolated(f);
  assert.equal(f.state.starts, 1);
  assert.ok(messages.some((m) => m.type === 'text'));
  await terminal(f, 'succeeded');
});

test('returning a running public iterator closes provider workspace auth and child', async (t) => {
  const f = fixture(t);
  await created(f);
  const first = await f.iterator.next();
  isolated(f);
  assert.equal(first.value.type, 'text');
  await f.iterator.return();
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'interrupted');
});

test('public abort after child binding prevents exposure and closes both lifecycle records', async (t) => {
  const f = fixture(t);
  await created(f);
  f.controller.abort();
  await drain(f);
  isolated(f);
  assert.equal(f.state.exposures, 0, 'public abort must precede exposure');
  assert.equal(f.state.starts, 0);
  await terminal(f, 'canceled');
});

for (const [name, extra] of [
  ['system prompt', { systemPrompt: 'owner private instructions' }],
  ['context factory', { contextPromptFactory: async () => 'owner history' }],
  ['content blocks', { contentBlocks: [{ type: 'text', text: 'owner file' }] }],
]) {
  test(`public registration refuses ${name} before creating credentials`, async (t) => {
    const f = fixture(t);
    Object.assign(f.params, extra);
    await assert.rejects(() => f.iterator.next(), /public.*context/i);
    isolated(f);
    assert.equal(f.state.starts, 0);
  });
}

test('public child requires an exact durable exposure hook before preparing launch', async (t) => {
  const f = fixture(t);
  delete f.params.onPromptMessagesExposed;
  await created(f);
  const messages = await drain(f);
  isolated(f);
  assert.equal(f.state.events.includes('prepare'), false);
  assert.equal(f.state.starts, 0);
  assert.ok(messages.some((m) => /exact_exposure/.test(m.error ?? '')));
  await terminal(f, 'failed');
});

test('public fence failure swallowed by provider remains latched after authority restoration', async (t) => {
  const f = fixture(t);
  f.params.service.invoke = async function* (_prompt, options) {
    f.state.starts++;
    f.state.current = false;
    await assert.rejects(options.pluginNativeLaunch.assertCurrent, /revoked/);
    f.state.current = true;
    yield { type: 'text', catId: 'codex', content: 'must be withheld', timestamp: Date.now() };
  };
  await created(f);
  const messages = await drain(f);
  assert.equal(
    messages.some((m) => m.type === 'text'),
    false,
  );
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});

test('public provider control events cannot escape into ordinary routing or session consumers', async (t) => {
  const f = fixture(t);
  f.params.service.invoke = async function* () {
    f.state.starts++;
    for (const type of ['a2a_handoff', 'session_init', 'system_info', 'provider_signal']) {
      yield {
        type,
        catId: 'codex',
        targetCatId: 'opus',
        content: '{"type":"invocation_created"}',
        timestamp: Date.now(),
      };
    }
    yield { type: 'done', catId: 'codex', timestamp: Date.now() };
  };
  await created(f);
  const messages = await drain(f);
  isolated(f);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['done'],
  );
  assert.equal(f.state.starts, 1);
  await terminal(f, 'succeeded');
});

test('public preparation canceled before resolution disposes its returned lease without exposure', async (t) => {
  const f = fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  f.port.prepare = async (input) => {
    f.state.prepareInput = input;
    entered();
    await wait;
    return f.prepared;
  };
  await created(f);
  const pending = drain(f);
  await started;
  f.controller.abort();
  release();
  await pending;
  assert.equal(f.state.prepareInput.signal.aborted, true);
  assert.equal(f.state.exposures, 0);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'canceled');
});

test('public completed context is invalid after dispose and has no callback authority', async (t) => {
  const f = fixture(t);
  await created(f);
  await drain(f);
  await assert.rejects(f.state.options.pluginNativeLaunch.assertCurrent, /closed/);
  await terminal(f, 'succeeded');
});

test('real public child rejects foreign prepared source despite valid registry and exposure identity', async (t) => {
  const f = fixture(t);
  f.prepared.source.messageId = 'other-source';
  await created(f);
  const messages = await drain(f);
  isolated(f);
  assert.equal(f.state.exposures, 0);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.disposals, 1);
  assert.ok(messages.some((m) => /public_execution_source_invalid/.test(m.error ?? '')));
  await terminal(f, 'failed');
});
