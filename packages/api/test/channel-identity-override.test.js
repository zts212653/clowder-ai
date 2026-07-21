import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANNEL_IDENTITY_DEFAULTS,
  ChannelIdentityRegistry,
} from '../dist/infrastructure/connectors/channel-identity.js';

// -----------------------------------------------------------------------------
// ChannelIdentityRegistry unit tests (F267 AC-1G)
// -----------------------------------------------------------------------------

test('ChannelIdentityRegistry: explicit set wins over default', () => {
  const reg = new ChannelIdentityRegistry();
  reg.set('feishu', 'oc_xxx', { displayName: '咖啡猫-毅之队', emoji: '🐱' });
  const id = reg.resolve('feishu', 'oc_xxx');
  assert.equal(id.displayName, '咖啡猫-毅之队');
});

test('ChannelIdentityRegistry: unset falls back to connector default', () => {
  const reg = new ChannelIdentityRegistry();
  const id = reg.resolve('feishu', 'oc_some_group');
  assert.equal(id.displayName, CHANNEL_IDENTITY_DEFAULTS.feishu.default.displayName);
  assert.equal(id.emoji, '🐱');
  assert.equal(id.exposeInternalNames, false);
});

test('ChannelIdentityRegistry: unknown connector → undefined', () => {
  const reg = new ChannelIdentityRegistry();
  const id = reg.resolve('unsupported-channel', 'oc_xxx');
  assert.equal(id, undefined);
});

test('ChannelIdentityRegistry: resolveForChatType p2p ignores connector default', () => {
  const reg = new ChannelIdentityRegistry();
  // No explicit registration; DMs should not inherit 'feishu default' override.
  const id = reg.resolveForChatType('feishu', 'oc_dm', 'p2p');
  assert.equal(id, undefined);
});

test('ChannelIdentityRegistry: resolveForChatType group uses connector default', () => {
  const reg = new ChannelIdentityRegistry();
  const id = reg.resolveForChatType('feishu', 'oc_group', 'group');
  assert.equal(id.displayName, '咖啡猫');
});

test('ChannelIdentityRegistry: resolveForChatType undefined falls back to resolver (legacy)', () => {
  const reg = new ChannelIdentityRegistry();
  const id = reg.resolveForChatType('feishu', 'oc_group', undefined);
  assert.equal(id.displayName, '咖啡猫');
});

test('ChannelIdentityRegistry: explicit registration wins even for p2p', () => {
  const reg = new ChannelIdentityRegistry();
  reg.set('feishu', 'oc_dm_specific', { displayName: '客服小咖啡' });
  const id = reg.resolveForChatType('feishu', 'oc_dm_specific', 'p2p');
  assert.equal(id.displayName, '客服小咖啡');
});

test('ChannelIdentityRegistry: list returns all explicit registrations', () => {
  const reg = new ChannelIdentityRegistry();
  reg.set('feishu', 'oc_a', { displayName: 'A' });
  reg.set('telegram', 'tg_b', { displayName: 'B' });
  const list = reg.list();
  assert.equal(list.length, 2);
  const keys = list.map((e) => `${e.key.connectorId}:${e.key.externalChatId}`).sort();
  assert.deepEqual(keys, ['feishu:oc_a', 'telegram:tg_b']);
});

test('ChannelIdentityRegistry: unset removes registration', () => {
  const reg = new ChannelIdentityRegistry();
  reg.set('feishu', 'oc_x', { displayName: 'X' });
  assert.equal(reg.unset('feishu', 'oc_x'), true);
  // Falls back to default
  const id = reg.resolve('feishu', 'oc_x');
  assert.equal(id.displayName, '咖啡猫');
});
