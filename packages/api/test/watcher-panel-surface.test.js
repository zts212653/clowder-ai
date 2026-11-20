import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyWatcherConfigPatch, parseWatcherConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  parseToolExecutionPolicy,
  toolExecutionPolicyDenial,
} from '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { InMemoryWatcherPanelLedger } from '../dist/domains/concierge/watcher/panel/watcher-panel-ledger.js';
import {
  WATCHER_PANEL_CALLBACK_ROUTES,
  watcherPanelToolPolicy,
} from '../dist/domains/concierge/watcher/panel/watcher-panel-policy.js';
import {
  extractWatcherPanelInstruction,
  loadWatcherPanelGuidance,
  WATCHER_PANEL_INSTRUCTION_PATH,
  watcherPanelPrompt,
} from '../dist/domains/concierge/watcher/panel/watcher-panel-prompt.js';
import { readWatcherOutputFence } from '../dist/domains/concierge/watcher/watcher-output-fence.js';
import { reconcileWatcherRecovery } from '../dist/domains/concierge/watcher/watcher-recovery.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { watcherRoutes } from '../dist/routes/watcher.js';
import { watcherCallbackRoutes } from '../dist/routes/watcher-callbacks.js';
import { watcherPanelRoutes } from '../dist/routes/watcher-panel.js';

test('the panel is off unless the owner turns it on, and members are distinct', () => {
  assert.equal(parseWatcherConfig(undefined).panel, undefined);
  const next = applyWatcherConfigPatch(parseWatcherConfig(undefined), {
    panel: { enabled: true, members: [{ catId: 'gpt52' }, { catId: 'spark' }], maxConcurrentRuns: 4 },
  });
  assert.equal(next.panel.enabled, true);
  assert.throws(() =>
    applyWatcherConfigPatch(next, {
      panel: { enabled: true, members: [{ catId: 'gpt52' }, { catId: 'gpt52' }], maxConcurrentRuns: 4 },
    }),
  );
});

test('the panel route fence reads like a member and acts only through the watcher outlets', () => {
  const policy = watcherPanelToolPolicy();
  assert.deepEqual(parseToolExecutionPolicy(JSON.stringify(policy)), policy);
  for (const allowed of [
    'GET /api/callbacks/thread-context',
    'GET /api/callbacks/memory-matters/:matterId',
    'POST /api/callbacks/remember',
    'POST /api/callbacks/watcher-nudge',
    'POST /api/callbacks/suggestions',
    'POST /api/callbacks/desk-deliveries',
  ])
    assert.equal(toolExecutionPolicyDenial(policy, allowed), null, allowed);
  for (const denied of [
    'POST /api/callbacks/post-message',
    'POST /api/callbacks/hold-ball',
    'POST /api/callbacks/create-rich-block',
    'POST /api/callbacks/propose-thread',
    'POST /api/callbacks/work',
    'POST /api/callbacks/set-thread-metadata',
    'POST /api/callbacks/start-vote',
  ])
    assert.notEqual(toolExecutionPolicyDenial(policy, denied), null, denied);
});

test('every fenced route names a real callback route', () => {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(readFileSync(path, 'utf8'));
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  const source = files.join('\n');
  for (const route of WATCHER_PANEL_CALLBACK_ROUTES) {
    const path = route.split(' ')[1];
    assert.ok(source.includes(`'${path}'`) || source.includes(`\`${path}\``), `${route} is registered`);
  }
});

test('the callback auth hook enforces the panel fence by route template', async () => {
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(async (scoped) => {
    registerCallbackAuthHook(scoped, registry);
    scoped.get('/api/callbacks/thread-context', async () => ({ ok: true }));
    scoped.get('/api/callbacks/memory-matters/:matterId', async () => ({ ok: true }));
    scoped.post('/api/callbacks/post-message', async () => ({ ok: true }));
  });
  const auth = await registry.create(
    'owner',
    'gpt52',
    'thread-1',
    'watcher-panel:r:gpt52',
    undefined,
    watcherPanelToolPolicy(),
  );
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  try {
    assert.equal((await app.inject({ url: '/api/callbacks/thread-context', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/callbacks/memory-matters/m1', headers })).statusCode, 200);
    const post = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload: {} });
    assert.equal(post.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('members read the instruction word for word from its document, then only this round’s facts', () => {
  const doc =
    '# 说明\n\n## 正文\n\n```text\n你正在担任守望猫。\n\n第二段。\n```\n\n## 和线上现行版的差别\n\n```text\n不是正文\n```\n';
  assert.equal(extractWatcherPanelInstruction(doc), '你正在担任守望猫。\n\n第二段。');
  assert.throws(() => extractWatcherPanelInstruction('# 没有正文'), /watcher_panel_instruction_body_missing/);
  assert.throws(() => loadWatcherPanelGuidance(''), /watcher_panel_instruction_unavailable/);
  const instruction = new URL(`../../../${WATCHER_PANEL_INSTRUCTION_PATH}`, import.meta.url);
  if (existsSync(instruction)) {
    const real = loadWatcherPanelGuidance();
    assert.ok(real.text.startsWith('你正在担任守望猫。'), 'the runtime finds the installation-owned document');
    assert.match(real.digest, /^sha256:[a-f0-9]{64}$/);
  } else {
    assert.throws(() => loadWatcherPanelGuidance(), /watcher_panel_instruction_unavailable/);
  }
  const prompt = watcherPanelPrompt({
    threadId: 'thread-1',
    threadTitle: '标题',
    workerCatId: 'codex',
    cutoffMessageId: 'reply-1',
    cutoffAt: Date.parse('2026-11-16T15:00:00Z'),
    context: { mode: 'cold', body: '<原话 messageId="m1">x</原话>', messageCount: 1, truncated: false },
    quiet: 'woken_by_watcher',
    guidance: { text: '你正在担任守望猫。', digest: 'sha256:x' },
  });
  assert.ok(prompt.startsWith('<守望猫说明>\n你正在担任守望猫。\n</守望猫说明>'));
  assert.match(prompt, /2026-11-16T15:00:00.000Z/);
  assert.match(prompt, /被守望猫的话叫起来的/);
  assert.doesNotMatch(prompt, /你是 /, 'the round never names the member');
});

test('the output fence admits panel members while the panel is on', async () => {
  const configs = new MemoryConciergeConfigStore();
  const threads = new ThreadStore();
  const thread = await threads.create('owner');
  const owners = { configs, threads, labels: { list: async () => [] } };
  await configs.updateWatcherConfig('owner', 0, { enabled: true, scope: 'all' });
  assert.equal(await readWatcherOutputFence(owners, 'owner', thread.id, 'gpt52'), null);
  await configs.updateWatcherConfig('owner', 1, {
    panel: { enabled: true, members: [{ catId: 'gpt52' }], maxConcurrentRuns: 3 },
  });
  assert.ok(await readWatcherOutputFence(owners, 'owner', thread.id, 'gpt52'));
  assert.equal(await readWatcherOutputFence(owners, 'owner', thread.id, 'spark'), null);
});

test('single-watcher recovery leaves panel runs to the panel', async () => {
  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    invocationId: 'panel-run',
    parentInvocationId: 'watcher-panel:r:gpt52',
    userId: 'owner',
    threadId: 'thread-1',
    catId: 'gpt52',
    executionKind: 'watcher',
    startedAt: Date.now(),
    causal: { watcherSourceInvocationId: 'source', watcherPanelRoundId: 'r' },
  });
  const reports = [];
  await reconcileWatcherRecovery(
    {
      executions,
      sessions: { listPendingWatcherSessions: async () => [], getByChainKey: async () => null },
      registry: new InvocationRegistry(),
      recoverNative: () => assert.fail('panel runs are not single-watcher sessions'),
    },
    'owner',
    (error) => reports.push(error),
  );
  assert.deepEqual(reports, []);
});

async function ownerApp(register) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  });
  await register(app);
  return app;
}
const ownerHeaders = { host: 'localhost', origin: 'http://localhost:3171' };

test('legacy panel settings follow concrete capability and restart from now when the panel switches', async () => {
  const turns = new InMemoryTurnExecutionStore();
  const configStore = new MemoryConciergeConfigStore();
  const app = await ownerApp((app) =>
    app.register(watcherRoutes, {
      turnExecutionStore: turns,
      threadStore: new ThreadStore(),
      configStore,
      labelStore: { list: async () => [] },
      capability: (id) =>
        ['gpt52', 'spark'].includes(id)
          ? { supported: true, context: 'ordinary', readOnly: 'tools' }
          : { supported: false, reason: 'no model in test' },
    }),
  );
  try {
    const settings = (await app.inject({ url: '/api/watcher/config', headers: ownerHeaders })).json();
    assert.equal(settings.config.panel, undefined);
    assert.equal(settings.panelDefaults.enabled, false);
    assert.equal(settings.members.find((member) => member.catId === 'gpt52').panelSupported, true);
    assert.equal(settings.members.find((member) => member.catId === 'opus').panelSupported, false);
    assert.equal(settings.members.find((member) => member.catId === 'gpt-pro').panelSupported, false);
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers: ownerHeaders,
      payload: {
        expectedRevision: settings.config.revision,
        panel: { enabled: true, members: [{ catId: 'opus' }], maxConcurrentRuns: 3 },
      },
    });
    assert.equal(rejected.statusCode, 422);
    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers: ownerHeaders,
      payload: {
        expectedRevision: settings.config.revision,
        panel: { enabled: true, members: [{ catId: 'gpt52' }, { catId: 'spark' }], maxConcurrentRuns: 3 },
      },
    });
    assert.equal(accepted.statusCode, 200);
    const saved = accepted.json().config;
    assert.equal(saved.panel.enabled, true);
    assert.equal(saved.activationRevision, saved.revision, 'switching the panel is a fresh start');
  } finally {
    await app.close();
  }
});

test('the ledger is owner-only and the evaluator export names no member', async () => {
  const ledger = new InMemoryWatcherPanelLedger();
  const userId = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  await ledger.save({
    v: 1,
    roundId: 'wpr:source',
    userId,
    threadId: 'thread-1',
    sourceInvocationId: 'source',
    sourceSettledSequence: 3,
    workerCatId: 'codex',
    cutoffMessageId: 'cut',
    createdAt: 1,
    updatedAt: 2,
    status: 'completed',
    guidanceDigest: 'sha256:test',
    members: [
      { catId: 'gpt52', label: '乙', status: 'spoke', sentence: '说一句', invocationId: 'inv-1', sessionId: 's1' },
      { catId: 'spark', label: '甲', status: 'quiet', accountRef: 'backup-1' },
    ],
    delivery: { skipped: 'nobody_spoke' },
  });
  const app = await ownerApp((app) =>
    app.register(watcherPanelRoutes, {
      ledger,
      turnExecutionStore: { get: async () => null, listSettled: async () => ({ records: [] }) },
    }),
  );
  try {
    const named = (await app.inject({ url: '/api/watcher/panel/rounds', headers: ownerHeaders })).json();
    assert.equal(named.rounds[0].members[0].catId, 'gpt52');
    const blind = await app.inject({ url: '/api/watcher/panel/rounds?blind=1', headers: ownerHeaders });
    const body = blind.body;
    for (const secret of ['gpt52', 'spark', 'inv-1', 's1', 'backup-1'])
      assert.equal(body.includes(secret), false, secret);
    assert.deepEqual(
      blind.json().rounds[0].members.map((member) => member.label),
      ['甲', '乙'],
    );
    const cat = await app.inject({
      url: '/api/watcher/panel/rounds/wpr:source',
      headers: { ...ownerHeaders, 'x-invocation-id': 'i', 'x-callback-token': 't' },
    });
    assert.equal(cat.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('legacy canceled members are corrected per opportunity on owner and blind reads without deleting the round', async () => {
  const ledger = new InMemoryWatcherPanelLedger();
  const userId = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  const round = {
    v: 1,
    roundId: 'wpr:stopped',
    userId,
    threadId: 'thread-1',
    sourceInvocationId: 'source',
    sourceSettledSequence: 3,
    workerCatId: 'codex',
    cutoffMessageId: 'cut',
    cutoffAt: 10,
    createdAt: 1,
    updatedAt: 2,
    status: 'completed',
    guidanceDigest: 'sha256:test',
    members: [
      { catId: 'gpt52', label: '甲', status: 'quiet', invocationId: 'canceled-1', sessionId: 's1' },
      { catId: 'spark', label: '乙', status: 'quiet', invocationId: 'canceled-2', sessionId: 's2' },
      { catId: 'codex', label: '丙', status: 'spoke', invocationId: 'success', sentence: '保留这一句' },
    ],
    delivery: { messageId: 'delivered', targetCatId: 'codex', deliveredAt: 20 },
  };
  await ledger.save(round);
  const turnExecutionStore = {
    get: async (id) => ({
      invocationId: id,
      userId,
      threadId: 'thread-1',
      executionKind: 'watcher',
      catId: round.members.find((entry) => entry.invocationId === id).catId,
      causal: { watcherPanelRoundId: round.roundId },
      status: id === 'success' ? 'succeeded' : 'canceled',
      terminalReason: id === 'success' ? 'watcher_panel_quiet' : 'user_cancel',
    }),
    listSettled: async () => ({ records: [] }),
  };
  const app = await ownerApp((app) => app.register(watcherPanelRoutes, { ledger, turnExecutionStore }));
  try {
    for (const suffix of ['', '?blind=1']) {
      const response = await app.inject({ url: `/api/watcher/panel/rounds${suffix}`, headers: ownerHeaders });
      assert.equal(response.statusCode, 200);
      const view = response.json().rounds[0];
      assert.equal(view.members.length, 3);
      const byLabel = Object.fromEntries(view.members.map((entry) => [entry.label, entry]));
      assert.equal(byLabel['甲'].status, 'interrupted');
      assert.equal(byLabel['乙'].status, 'interrupted');
      assert.equal(byLabel['丙'].status, 'spoke');
      assert.equal(byLabel['丙'].sentence, '保留这一句');
      assert.equal(view.delivery.messageId, 'delivered');
    }
    assert.equal((await ledger.get(round.roundId)).members[0].status, 'quiet', 'raw historical evidence is preserved');
  } finally {
    await app.close();
  }
});

test('a panel member’s nudge is held for the round, not posted', async () => {
  const registry = new InvocationRegistry();
  const held = [];
  const app = Fastify();
  await app.register(watcherCallbackRoutes, {
    registry,
    executions: new InMemoryTurnExecutionStore(),
    sessions: {},
    messages: {},
    queue: { enqueueExistingMessageDurable: () => assert.fail('a panel sentence never wakes on its own') },
    maySpeak: async () => assert.fail('the single-watcher check is not the panel’s'),
    publish: () => assert.fail('nothing is posted by the nudge itself'),
    panelNudge: async (input) => {
      held.push(input);
      return input.sourceMessageId === 'ok'
        ? { accepted: true, delivered: false, deliveryAfterRound: true }
        : { accepted: false, reason: 'citation_outside_material' };
    },
  });
  const auth = await registry.create(
    'owner',
    'gpt52',
    'thread-1',
    'watcher-panel:r:gpt52',
    undefined,
    watcherPanelToolPolicy(),
  );
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/watcher-nudge',
      headers,
      payload: { sentence: '一句', sourceMessageId: 'ok' },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().delivered, false);
    assert.match(accepted.json().note, /合成一条/);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/callbacks/watcher-nudge',
      headers,
      payload: { sentence: '一句', sourceMessageId: 'elsewhere' },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(
      held.map((input) => [input.invocationId, input.threadId]),
      [
        [auth.invocationId, 'thread-1'],
        [auth.invocationId, 'thread-1'],
      ],
    );
  } finally {
    await app.close();
  }
});
