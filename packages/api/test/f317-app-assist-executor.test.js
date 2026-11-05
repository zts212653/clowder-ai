import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RedisConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { CompanionAppAssistOwner } from '../dist/domains/concierge/live/host/companion-app-assist-owner.js';
import { ElectronDesktopWindowExecutor } from '../dist/domains/plugin/desktop-window-runtime/electron-executor.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const redis = ownedRedisFixture('f317-app-assist-executor');

test('actual executor/private pipes and Host instances enforce the same owner daily claim and immediate saved opt-out', async (t) => {
  const store = new RedisConciergeConfigStore(redis.client('executor:'));
  await store.patch('fixture-owner', { appAssistEnabled: true });
  const frames = [];
  const windows = [];
  t.after(async () => {
    await Promise.all(windows.map((win) => win.close()));
  });
  for (let i = 0; i < 2; i++) {
    const owner = new CompanionAppAssistOwner({
      store: new RedisConciergeConfigStore(redis.client('executor:')),
      ownerUserId: 'fixture-owner',
      timeZone: () => 'Pacific/Honolulu',
      now: () => Date.parse('2030-01-02T12:00:00Z'),
      assertCurrent: async () => {},
    });
    const executor = new ElectronDesktopWindowExecutor({
      executable: process.execPath,
      entrypoint: fileURLToPath(new URL('../../../desktop/test/app-assist-kernel.fixture.cjs', import.meta.url)),
    });
    const window = await executor.open({
      url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/body/index.html`,
      presentation: { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
      publicCompanionV2: true,
      companionContract: '0.1.0-beta.29',
      signal: new AbortController().signal,
      onClosed() {},
      appAssist: {
        watch: (listener) => owner.watch(listener),
        request: (input) => {
          frames.push(input);
          return owner.request(input);
        },
      },
    });
    windows.push(window);
  }
  const deadline = Date.now() + 1500;
  let visible = 0;
  do {
    visible = (await Promise.all(windows.map((win) => win.poll()))).filter((state) => state === 'visible').length;
    if (visible === 1) break;
    await new Promise((done) => setTimeout(done, 5));
  } while (Date.now() < deadline);
  assert.equal(visible, 1);
  assert.equal(frames.filter((frame) => frame.kind === 'claim').length, 2);
  assert.ok(
    frames.every((frame) => Object.keys(frame).sort().join(',') === (frame.kind === 'read' ? 'kind' : 'appKey,kind')),
  );
  assert.ok(frames.filter((frame) => frame.kind === 'claim').every((frame) => /^[0-9a-f]{64}$/.test(frame.appKey)));
  await store.patch('fixture-owner', { appAssistEnabled: false });
  // Redis publication is asynchronous; no subsequent application event is sent.
  const stoppedBy = Date.now() + 1500;
  let states;
  do {
    states = await Promise.all(windows.map((win) => win.poll()));
    if (states.every((state) => state === 'hidden')) break;
    await new Promise((done) => setTimeout(done, 5));
  } while (Date.now() < stoppedBy);
  assert.deepEqual(states, ['hidden', 'hidden']);
});
