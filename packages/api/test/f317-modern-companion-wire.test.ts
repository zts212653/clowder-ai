import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateHostCompanionCommand,
  validateHostCompanionReply,
} from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';

const legacy = '0.1.0-beta.21';
const modern = '0.1.0-beta.23';
const state = {
  kind: 'state',
  phase: 'idle',
  displayName: '猫猫球',
  skin: 'yanyan-codex',
  duty: { catId: 'codex61-sol', displayName: '砚砚' },
  carrier: { catId: 'codex61-sol', displayName: '砚砚' },
  documentsAllowed: true,
  behaviorEnabled: false,
  toolsReady: false,
  nativeActivity: 'none',
  nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
};

test('modern settings and transcript commands are admitted only by the selected modern ABI', () => {
  for (const command of [
    { kind: 'settings.read' },
    { kind: 'settings.update', field: 'behaviorEnabled', value: false },
    { kind: 'transcript.read' },
    { kind: 'view.reset' },
    { kind: 'companion.disable' },
  ]) {
    assert.equal(validateHostCompanionCommand(command, modern), true);
    assert.equal(validateHostCompanionCommand(command, legacy), false);
  }
  assert.equal(validateHostCompanionCommand({ kind: 'settings.read', userId: 'someone-else' }, modern), false);
  assert.equal(validateHostCompanionCommand({ kind: 'settings.update', field: 'ballSize', value: 193 }, modern), false);
});

test('modern Host state requires its boolean policy while legacy keeps the guarded private extension', () => {
  assert.equal(validateHostCompanionReply(state, modern), true);
  assert.equal(validateHostCompanionReply(state, legacy), true);
  const { behaviorEnabled: _missing, ...missing } = state;
  assert.equal(validateHostCompanionReply(missing, modern), false);
  assert.equal(validateHostCompanionReply({ ...state, behaviorEnabled: null }, modern), false);
  assert.equal(validateHostCompanionReply({ ...state, writer: true }, modern), false);
});

test('typed delivery receipts preserve stable send/message/call identity only on the modern ABI', () => {
  const delivery = {
    kind: 'delivery',
    delivery: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    messageId: 'message-a',
    callId: '22222222-2222-4222-8222-222222222222',
  };
  assert.equal(validateHostCompanionReply(delivery, modern), true);
  assert.equal(validateHostCompanionReply(delivery, legacy), false);
  assert.equal(validateHostCompanionReply({ ...delivery, played: true }, modern), false);
});
