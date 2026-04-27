/**
 * F174 Phase E — DegradePolicy + withDegradation() framework tests.
 *
 * AC-E1: framework落地，create_rich_block existing Route B 重构不变行为
 * AC-E2: 每个写类 callback tool 显式声明 degradePolicy（含 none）
 * AC-E3: 降级只在 401-degradable reason 触发；5xx 仍走 retry
 * AC-E4: 降级产物含 DEGRADED: true 字段
 * AC-E6: stale_invocation 不降级，给清晰提示
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('withDegradation framework (F174-E)', () => {
  test('AC-E1: returns primary result on success without invoking degrade', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    let degradeCalled = false;
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      policy: {
        kind: 'custom',
        degrade: async () => {
          degradeCalled = true;
          return { content: [{ type: 'text', text: 'fallback' }] };
        },
      },
    });
    assert.equal(degradeCalled, false, 'degrade must NOT fire on primary success');
    assert.equal(result.content[0].text, 'ok');
    assert.ok(!result.isError);
  });

  test('AC-E1: degrades on expired auth failure (degradable reason)', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=expired' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => ({ content: [{ type: 'text', text: 'fallback-success' }] }),
      },
    });
    assert.equal(result.content[0].text.includes('fallback-success'), true);
    assert.ok(!result.isError);
  });

  test('AC-E1: degrades on unknown_invocation auth failure', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=unknown_invocation' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => ({ content: [{ type: 'text', text: 'recovered' }] }),
      },
    });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text.includes('recovered'), true);
  });

  test('AC-E2: kind=none surfaces original error without degrading', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=expired' }],
      }),
      policy: { kind: 'none' },
    });
    assert.ok(result.isError, 'none policy must surface original error');
    assert.equal(result.content[0].text.includes('expired'), true);
  });

  test('AC-E3: invalid_token (not degradable) skips degrade — surfaces original', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    let degradeCalled = false;
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=invalid_token' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => {
          degradeCalled = true;
          return { content: [{ type: 'text', text: 'should-not-reach' }] };
        },
      },
    });
    assert.equal(degradeCalled, false, 'invalid_token must NOT trigger degrade (client bug, not transient)');
    assert.ok(result.isError);
    assert.equal(result.content[0].text.includes('invalid_token'), true);
  });

  // AC-E6: stale_invocation = invocation succeeded but was superseded.
  // Degrading would re-create state. Surface clearly so caller knows their
  // invocation lost the latest pointer.
  test('AC-E6: stale_invocation skips degrade and surfaces clear hint', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    let degradeCalled = false;
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=stale_invocation' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => {
          degradeCalled = true;
          return { content: [{ type: 'text', text: 'wrong' }] };
        },
      },
    });
    assert.equal(degradeCalled, false, 'stale_invocation must NEVER trigger degrade');
    assert.ok(result.isError);
    assert.equal(result.content[0].text.includes('stale_invocation'), true);
  });

  // AC-E3: 5xx and other non-401 errors should not invoke the degrade path —
  // those are transient and handled by callbackPost's retry layer separately.
  test('AC-E3: non-auth error (e.g. 5xx) skips degrade', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    let degradeCalled = false;
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'HTTP 503 Service Unavailable' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => {
          degradeCalled = true;
          return { content: [{ type: 'text', text: 'wrong' }] };
        },
      },
    });
    assert.equal(degradeCalled, false, '5xx must NOT trigger degrade — retry layer handles it');
    assert.ok(result.isError);
  });

  // AC-E4: degraded result must carry DEGRADED:true field so caller can detect
  // they're in fallback mode (e.g. for telemetry / UX hints).
  test('AC-E4: successful degraded fallback marks result with DEGRADED:true', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    const result = await withDegradation({
      toolName: 'test-tool',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=expired' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok', via: 'fallback' }) }],
        }),
      },
    });
    assert.ok(!result.isError, 'successful fallback should not be error');
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.DEGRADED, true, 'result must carry DEGRADED:true');
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.via, 'fallback');
  });

  test('AC-E1: degrade fallback that itself fails surfaces the failure', async () => {
    const { withDegradation } = await import('../dist/tools/degradation.js');
    const result = await withDegradation({
      toolName: 'test',
      primary: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'callback_auth_failed reason=expired' }],
      }),
      policy: {
        kind: 'custom',
        degrade: async () => ({
          isError: true,
          content: [{ type: 'text', text: 'fallback also failed' }],
        }),
      },
    });
    assert.ok(result.isError, 'fallback-failure must propagate isError');
    assert.equal(result.content[0].text.includes('fallback also failed'), true);
  });
});
