import assert from 'node:assert/strict';
import { test } from 'node:test';

const { isCliTimeoutError } = await import('../dist/domains/cats/services/agents/invocation/invoke-helpers.js');

test('isCliTimeoutError matches 响应超时 pattern', () => {
  assert.ok(isCliTimeoutError('缅因猫 CLI 响应超时 (300s)'));
  assert.ok(isCliTimeoutError('布偶猫 CLI 响应超时 (1800s)'));
  assert.ok(isCliTimeoutError('暹罗猫 CLI 响应超时 (300s, 未收到首帧)'));
  assert.ok(isCliTimeoutError('DARE CLI 响应超时 (300s)'));
  assert.ok(isCliTimeoutError('opencode CLI 响应超时 (600s, 未收到首帧)'));
});

test('isCliTimeoutError matches idle-silent pattern', () => {
  assert.ok(isCliTimeoutError('CLI idle-silent 超时 (300s — stall auto-kill)'));
});

test('isCliTimeoutError rejects unrelated errors', () => {
  assert.ok(!isCliTimeoutError(undefined));
  assert.ok(!isCliTimeoutError(''));
  assert.ok(!isCliTimeoutError('No conversation found with session ID abc'));
  assert.ok(!isCliTimeoutError('CLI 异常退出 (code: 1, signal: none)'));
});
