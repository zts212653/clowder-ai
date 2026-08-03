import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelIdentityRegistry } from '../dist/infrastructure/connectors/channel-identity.js';
import { OutboundDeliveryHook } from '../dist/infrastructure/connectors/OutboundDeliveryHook.js';

// -----------------------------------------------------------------------------
// OutboundDeliveryHook.resolveBindingIdentity (F267 AC-1A/1B/1C)
// Unit tests on the pure resolver — no I/O mocks needed.
// -----------------------------------------------------------------------------

const baseOpts = () => ({
  bindingStore: {
    bind: () => null,
    getByExternal: () => null,
    getByThread: () => [],
    remove: () => false,
    listByUser: () => [],
    setHubThread: () => null,
  },
  adapters: new Map(),
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => baseOpts().log,
  },
});

test('OutboundDeliveryHook: no registry → natural cat identity, overridden=false', () => {
  const hook = new OutboundDeliveryHook(baseOpts());
  const identity = hook.resolveBindingIdentity({ connectorId: 'feishu', externalChatId: 'oc_xxx' }, '砚砚');
  assert.equal(identity.displayName, '砚砚');
  assert.equal(identity.emoji, '🐱');
  assert.equal(identity.exposeInternalNames, true);
  assert.equal(identity.overridden, false);
});

test('OutboundDeliveryHook: feishu group default → 咖啡猫, overridden=true', () => {
  const registry = new ChannelIdentityRegistry();
  // No explicit set — rely on defaults via connector default fallback.
  const hook = new OutboundDeliveryHook({ ...baseOpts(), channelIdentityRegistry: registry });
  const identity = hook.resolveBindingIdentity({ connectorId: 'feishu', externalChatId: 'oc_yizhidui' }, '砚砚');
  assert.equal(identity.displayName, '咖啡猫');
  assert.equal(identity.overridden, true);
  assert.equal(identity.emoji, '🐱');
  assert.equal(identity.exposeInternalNames, false);
});

test('OutboundDeliveryHook: explicit registration wins even when natural name matches', () => {
  const registry = new ChannelIdentityRegistry();
  registry.set('feishu', 'oc_z', { displayName: '咖啡猫-夜话组' });
  const hook = new OutboundDeliveryHook({ ...baseOpts(), channelIdentityRegistry: registry });
  const identity = hook.resolveBindingIdentity({ connectorId: 'feishu', externalChatId: 'oc_z' }, '小狸');
  assert.equal(identity.displayName, '咖啡猫-夜话组');
  assert.equal(identity.overridden, true);
});

test('OutboundDeliveryHook: telegram channel has no default → keep natural name', () => {
  const registry = new ChannelIdentityRegistry();
  const hook = new OutboundDeliveryHook({ ...baseOpts(), channelIdentityRegistry: registry });
  const identity = hook.resolveBindingIdentity({ connectorId: 'telegram', externalChatId: '@group' }, '砚砚');
  assert.equal(identity.displayName, '砚砚');
  assert.equal(identity.overridden, false);
});

test('OutboundDeliveryHook: empty natural name → fallback "Cat"', () => {
  const registry = new ChannelIdentityRegistry();
  registry.set('feishu', 'oc_empty', { displayName: '咖啡猫' });
  const hook = new OutboundDeliveryHook({ ...baseOpts(), channelIdentityRegistry: registry });
  const identity = hook.resolveBindingIdentity({ connectorId: 'feishu', externalChatId: 'oc_empty' }, '');
  assert.equal(identity.displayName, '咖啡猫');
  assert.equal(identity.overridden, true);
});
