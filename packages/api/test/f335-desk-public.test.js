import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import { validateCompanionReply as validateDeskReply } from '@clowder-ai/plugin-contract-033c0';
import { validateCompanionCommand as validateAppAssistCommand } from '@clowder-ai/plugin-contract-beta29';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { ConciergeThreadService } from '../dist/domains/concierge/ConciergeThreadService.js';
import { CompanionHostBridge } from '../dist/domains/concierge/live/CompanionHostBridge.js';
import { CompanionAppAssistOwner } from '../dist/domains/concierge/live/host/companion-app-assist-owner.js';
import { CompanionDeskOwner } from '../dist/domains/concierge/live/host/companion-desk-owner.js';
import {
  appAssistReplyValidator,
  companionCommandValidator,
} from '../dist/domains/plugin/desktop-window-runtime/admission.js';
import { validateHostCompanionReply } from '../dist/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { createDeskPipe } from '../dist/domains/plugin/desktop-window-runtime/desk-pipe.js';
import { validateHostPluginManifest } from '../dist/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import {
  COMPANION_CAPABILITY_SINCE,
  COMPANION_CONTRACT_LINES,
  companionContractHas,
  resolveCompanionArchiveContract,
} from '../dist/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { conciergeRoutes } from '../dist/routes/concierge.js';

const require = createRequire(import.meta.url);
const kernelContracts = require('../../../desktop/plugin-window/companion-contracts.cjs');
const { createManagedWindow } = require('../../../desktop/plugin-window/window.cjs');
const { createAppAssistHost } = require('../../../desktop/plugin-window/app-assist-host.cjs');
const { createDeskDeliveryHost } = require('../../../desktop/plugin-window/desk-delivery-host.cjs');
const { createDeskOwnerPipe } = require('../../../desktop/plugin-window/desk-pipe.cjs');
const { fixture, input } = require('../../../desktop/plugin-window/window-motion-fixture.cjs');

const DESK = '0.3.3-candidate.0';
// clowder-ai-plugins #188 (f21df559), npm `next`, catalog/candidate.json.
const ALPHA37 = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.37',
  packageDigest: 'sha512-xfxNnyl0Zg8qxCXInQdN5UJBn+uaKZF0exdDItNBCAputlke1Btfvk8GqdTCiYo0/2g/tmqAYegzOJhyZrRq/g==',
};
// The manifest bytes shipped in that archive (renderer integrity included).
const ALPHA37_MANIFEST = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.37',
  contractVersion: '0.1.0',
  name: '猫猫球',
  icon: { type: 'png', src: 'renderer/skins/ragdoll-v1.png' },
  description: {
    default: 'Talk, think and find your shared history with your companion.',
    translations: { 'zh-CN': '和猫猫说话、查资料，回到同一段聊天继续工作。' },
  },
  runtime: { transport: 'builtin' },
  features: [
    {
      id: 'companion',
      name: '猫猫球',
      resources: [],
      contributions: [{ type: 'desktop-window', id: 'companion' }],
    },
  ],
  contributions: [
    {
      type: 'desktop-window',
      id: 'companion',
      role: 'companion',
      bridgeVersion: '1.7.0',
      surface: {
        entrypoint: 'renderer/index.html',
        integrity: 'sha256-R425ilNu5hQtVtI0oFF8s+WBb+bWbDIXfUDn9y/Ve2c=',
      },
      presentation: { width: 300, height: 270, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
    },
  ],
};

test('F335 desk admission: the kernel and the Host admit the same contract lines and capabilities', () => {
  assert.deepEqual([...kernelContracts.COMPANION_CONTRACT_LINES], [...COMPANION_CONTRACT_LINES]);
  assert.deepEqual({ ...kernelContracts.COMPANION_CAPABILITY_SINCE }, { ...COMPANION_CAPABILITY_SINCE });
  for (const contract of [...COMPANION_CONTRACT_LINES, '0.1.0-beta.30', undefined])
    for (const capability of Object.keys(COMPANION_CAPABILITY_SINCE))
      assert.equal(
        kernelContracts.companionContractHas(contract, capability),
        companionContractHas(contract, capability),
        `${contract} ${capability}`,
      );
});

test('F335 desk admission: alpha.37 is admitted only by its exact SRI, and only its line carries the desk', () => {
  assert.equal(resolveCompanionArchiveContract(ALPHA37), DESK);
  assert.equal(
    resolveCompanionArchiveContract({ ...ALPHA37, packageDigest: `${ALPHA37.packageDigest.slice(0, -4)}AA==` }),
    undefined,
  );
  assert.equal(resolveCompanionArchiveContract({ ...ALPHA37, version: '0.1.0-alpha.36' }), undefined);
  assert.equal(resolveCompanionArchiveContract({ ...ALPHA37, pluginId: 'dev.other' }), undefined);
  assert.equal(companionContractHas(DESK, 'desk'), true);
  assert.equal(companionContractHas(DESK, 'appAssist'), true, 'the desk line keeps app assist');
  assert.equal(companionContractHas(DESK, 'presentation'), true);
  assert.equal(companionContractHas('0.1.0-beta.29', 'desk'), false);
  assert.equal(companionContractHas('0.1.0-beta.30', 'modern'), false, 'an unknown line has no capability');
});

test('F335 desk admission: bridge 1.7.0 is admitted only for the shipped alpha.37 manifest', () => {
  // The generic Host manifest ABI stops at bridge 1.6.0; 1.7.0 enters only through the archive row.
  const admitted = validateHostPluginManifest(ALPHA37_MANIFEST);
  assert.equal(admitted.valid, true);
  if (admitted.valid) assert.deepEqual(admitted.manifest, ALPHA37_MANIFEST, 'manifest bytes are never rewritten');
  const withBridge = (bridgeVersion) => ({
    ...ALPHA37_MANIFEST,
    contributions: ALPHA37_MANIFEST.contributions.map((c) => ({ ...c, bridgeVersion })),
  });
  assert.equal(validateHostPluginManifest(withBridge('1.8.0')).valid, false);
  assert.equal(validateHostPluginManifest({ ...ALPHA37_MANIFEST, version: '0.1.0-alpha.36' }).valid, false);
  assert.equal(validateHostPluginManifest({ ...ALPHA37_MANIFEST, pluginId: 'dev.other' }).valid, false);
});

test('F335 desk admission: desk commands exist only on the desk line', () => {
  const settle = { kind: 'desk.settle', scopeRef: 'desk-scope', deliveryRef: 'delivery-1', action: 'shown' };
  assert.equal(companionCommandValidator(DESK)(settle), true);
  assert.equal(companionCommandValidator('0.1.0-beta.29')(settle), false);
  assert.equal(validateAppAssistCommand(settle), false);
  assert.throws(() => companionCommandValidator('0.1.0-beta.30'), /Unsupported companion contract/);
});

const OWNER = 'fixture-desk-public-owner';
const WORK = { contentRef: 'work:sheet', ownerRevision: 1 };
const CARD = {
  id: 'work-reference-abc',
  kind: 'card',
  v: 1,
  title: '六猫岛 · 单采肖像参考',
  bodyMarkdown: '',
  meta: { kind: 'work_reference', reference: WORK },
};

async function until(read, ok, label) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('F335 desk public pair: the complete 0.3.3 reply passes the published validator from base to bubble to settlement', async (t) => {
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = OWNER;
  const app = Fastify();
  const store = new MemoryConciergeConfigStore();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  await store.put(OWNER, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus' });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: OWNER });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: store,
    conciergeThreadService: new ConciergeThreadService({ conciergeConfigStore: store, threadStore: new ThreadStore() }),
  });

  // 「给人的东西」 holds the one copy; the desk owner reads it under the Host lease.
  const messages = new Map([
    ['msg-sol', { id: 'msg-sol', userId: OWNER, threadId: 'thread_video', extra: { rich: { v: 1, blocks: [CARD] } } }],
  ]);
  const suggestions = createSuggestionIntegration({
    messageStore: { getById: (id) => messages.get(id) ?? null },
    threadTitle: async () => '「视频」自媒体视频运营',
  });
  const opened = [];
  const deskOwner = new CompanionDeskOwner({
    desk: suggestions.desk,
    ownerUserId: OWNER,
    assertCurrent: async () => {},
    messages: { getById: (id) => messages.get(id) ?? null },
    openCard: async (destination) => {
      opened.push(destination);
      return true;
    },
  });
  const appAssistOwner = new CompanionAppAssistOwner({
    store,
    ownerUserId: OWNER,
    timeZone: () => 'Pacific/Honolulu',
    now: () => Date.parse('2030-01-02T12:00:00Z'),
    assertCurrent: async () => {},
  });
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: OWNER,
    origin: 'http://localhost:5102',
    assertCurrent: async () => {},
    publicCompanionV2: true,
    openConversation: async () => true,
    appAssist: { request: async () => ({ status: 'off' }), watch: async () => async () => {} },
    desk: deskOwner,
    companionContract: DESK,
  });
  assert.ok(bridge.appAssist, 'the desk line keeps the app-assist owner');
  assert.equal(bridge.desk, deskOwner);

  // The private API base carries neither transient owner; the window adds both.
  const base = await bridge.request({ kind: 'state' });
  assert.equal(base.kind, 'state');
  assert.equal(Object.hasOwn(base, 'appAssist') || Object.hasOwn(base, 'desk'), false);
  assert.equal(validateHostCompanionReply(base, DESK), true);
  assert.equal(validateHostCompanionReply({ ...base, desk: null }, DESK), false, 'the API never sends a desk');

  // The kernel side: desk owner pipe ↔ API pipe, the real desk Host, the real app-assist Host.
  let kernelPipe;
  const apiPipe = createDeskPipe(deskOwner, (line) => kernelPipe.accept(JSON.parse(line)));
  kernelPipe = createDeskOwnerPipe((frame, callback) => {
    apiPipe.accept(JSON.parse(frame));
    callback?.();
  });
  const desk = createDeskDeliveryHost({ owner: kernelPipe, activity: { presence: () => 'present' } });
  const appAssist = createAppAssistHost({
    owner: {
      read: () => appAssistOwner.request({ kind: 'read' }),
      claim: (appKey) => appAssistOwner.request({ kind: 'claim', appKey }),
    },
    selfBundleIds: ['ai.fixture.self'],
    sourceFactory: async () => ({ close: async () => {} }),
    validateReply: appAssistReplyValidator(DESK),
  });
  const native = fixture();
  const managed = await createManagedWindow(
    native.electron,
    { ...input, publicCompanionV2: true, companionContract: DESK },
    { appAssist, desk, validate: companionCommandValidator(DESK), request: (command) => bridge.request(command) },
  );
  t.after(async () => {
    managed.close();
    desk.close();
    await appAssist.close();
    kernelPipe.close();
    apiPipe.close();
  });
  native.win.emit('show');
  managed.poll();

  const idle = await native.request({ kind: 'state' });
  assert.equal(idle.kind, 'state', 'the complete reply is not replaced by an unavailable error');
  assert.equal(validateDeskReply(idle), true);
  assert.equal(idle.desk.status, 'ready');
  assert.equal(idle.desk.delivery, null);

  await suggestions.desk.bring(
    { userId: OWNER, threadId: 'thread_video', catId: 'codex61-sol', invocationId: 'inv', byline: 'watcher' },
    { messageId: 'msg-sol', sentence: '鲸鲸那三格，照他的头像画就行。', work: WORK },
  );
  desk.changed();
  const bubble = await until(
    () => native.request({ kind: 'state' }),
    (state) => state.kind === 'state' && state.desk.delivery !== null,
    'the bubble',
  );
  assert.equal(validateDeskReply(bubble), true);
  const { delivery } = bubble.desk;
  assert.equal(delivery.mode, 'single');
  assert.equal(delivery.from.role, 'watcher');
  assert.equal(delivery.items[0].title, '六猫岛 · 单采肖像参考');
  assert.equal(delivery.items[0].source.conversationTitle, '「视频」自媒体视频运营');

  const command = (kind, extra = {}) => ({
    kind,
    scopeRef: bubble.desk.scopeRef,
    deliveryRef: delivery.deliveryRef,
    ...extra,
  });
  const shown = await native.request(command('desk.settle', { action: 'shown' }), true);
  assert.equal(validateDeskReply(shown), true);
  assert.equal(shown.outcome, 'settled');
  const avatar = await native.request(command('desk.avatar.read'), true);
  assert.equal(validateDeskReply(avatar), true);
  const open = await native.request(
    command('desk.settle', { action: 'open', itemRef: delivery.items[0].itemRef }),
    true,
  );
  assert.equal(validateDeskReply(open), true);
  assert.equal(open.outcome, 'settled');
  assert.deepEqual(opened, [{ threadId: 'thread_video', messageId: 'msg-sol', blockId: 'work-reference-abc' }]);
  const after = await native.request({ kind: 'state' });
  assert.equal(validateDeskReply(after), true);
  assert.equal(after.desk.delivery, null, 'the bubble is gone once its one line is opened');
});
