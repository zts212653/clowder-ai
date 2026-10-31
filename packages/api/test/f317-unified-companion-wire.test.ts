import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companionCommandValidator } from '../src/domains/plugin/desktop-window-runtime/admission.js';
import {
  validateHostCompanionCommand,
  validateHostCompanionReply,
} from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';

test('only the selected unified ABI admits opaque decision navigation; raw authority and cross-pairs fail', () => {
  const command = { kind: 'decision.open', variantRef: 'opaque_version', target: 'origin' };
  assert.equal(validateHostCompanionCommand(command, '0.1.0-beta.24'), true);
  for (const contract of ['0.1.0-beta.21', '0.1.0-beta.23'] as const)
    assert.equal(validateHostCompanionCommand(command, contract), false);
  for (const extra of [{ threadId: 'other' }, { ownerUserId: 'other' }, { url: 'https://foreign' }])
    assert.equal(validateHostCompanionCommand({ ...command, ...extra }, '0.1.0-beta.24'), false);
  assert.equal(companionCommandValidator('0.1.0-beta.24')(command), true);
  assert.throws(() => companionCommandValidator('unknown' as never));
  assert.equal(validateHostCompanionCommand({ kind: 'state' }, 'unknown' as never), false);
  assert.equal(validateHostCompanionReply({ kind: 'ok' }, 'unknown' as never), false);
});

test('beta.25 alone admits zero-selector work reads and opaque work opens', () => {
  for (const command of [{ kind: 'work.read' }, { kind: 'work.open', entryRef: 'a'.repeat(64) }]) {
    assert.equal(validateHostCompanionCommand(command, '0.1.0-beta.25'), true);
    assert.equal(companionCommandValidator('0.1.0-beta.25')(command), true);
    for (const contract of ['0.1.0-beta.21', '0.1.0-beta.23', '0.1.0-beta.24'] as const)
      assert.equal(validateHostCompanionCommand(command, contract), false);
    for (const extra of [{ projectPath: '/foreign' }, { threadId: 'foreign' }, { taskId: 'foreign' }])
      assert.equal(validateHostCompanionCommand({ ...command, ...extra }, '0.1.0-beta.25'), false);
  }
  for (const delivery of ['applied', 'queued', 'blocked', 'unconfirmed'])
    assert.equal(validateHostCompanionReply({ kind: 'navigation', delivery }, '0.1.0-beta.25'), true);
  assert.equal(validateHostCompanionReply({ kind: 'navigation', delivery: 'unknown' }, '0.1.0-beta.25'), false);
});
