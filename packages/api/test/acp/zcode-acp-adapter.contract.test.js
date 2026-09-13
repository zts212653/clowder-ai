// @ts-check

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AVAILABLE_MODELS, ZCODE_PROTOCOL } from './helpers/zcode-0.16.3-fixtures.mjs';
import { assistantText, startAdapter } from './helpers/zcode-acp-test-harness.mjs';

const {
  diagnoseZcodeSpawnReady,
  extractZcodeFailure,
  formatZcodeTurnFailure,
  normalizeZcodeAnthropicBaseUrl,
  parseTurnEvent,
  readZcodeEnvModel,
  sanitizeZcodeFailureText,
  zcodeAppServerEnv,
  ZcodeStderrRedactor,
} = await import('../../dist/domains/cats/services/agents/providers/acp/zcode-acp-protocol.js');

describe('ZCode ACP adapter contract (fake app-server)', () => {
  it('initialize / session/new / prompt returns PONG with end_turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-prompt-'));
    const acp = startAdapter(dir);
    try {
      const init = await acp.request('initialize', { protocolVersion: 1 });
      assert.equal(init.result.agentCapabilities.loadSession, true);
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompted = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply PONG' }],
      });
      assert.equal(prompted.error, undefined);
      assert.equal(prompted.result.stopReason, 'end_turn');
      assert.equal(assistantText(acp.updates, sessionId), 'PONG');
      const create = acp.rpcLog().find((row) => row.method === 'session/create');
      assert.equal(create.model, null, 'clean-home create must omit native model');
      const send = acp.rpcLog().find((row) => row.method === 'session/send');
      assert.ok(send);
      const store = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
      const rec = store[sessionId];
      assert.ok(rec.events?.length > 0);
      assert.match(rec.events[0].eventId, /^evt_/);
      assert.equal(typeof rec.events[0].seq, 'number');
      assert.equal(typeof rec.events[0].timestamp, 'number');
      assert.doesNotMatch(acp.stderr(), /split-secret-value/);
      assert.doesNotMatch(acp.stderr(), /secret-value/);
      assert.ok(existsSync(join(acp.isolatedHome, '.zcode', 'cli', 'hub-isolation-canary')));
      assert.equal(existsSync(join(homedir(), '.zcode', 'cli', 'hub-isolation-canary')), false);
      assert.equal(statSync(acp.isolatedHome).mode & 0o777, 0o700);
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers from -32031 runtime model unavailability via session/setModel and retries the prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-32031-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompted = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'FAIL_MODEL_UNAVAILABLE then PONG' }],
      });
      assert.equal(prompted.error, undefined, JSON.stringify(prompted.error));
      assert.equal(prompted.result.stopReason, 'end_turn');
      assert.match(assistantText(acp.updates, sessionId), /PONG/);
      const setModel = acp.rpcLog().find((row) => row.method === 'session/setModel');
      assert.ok(setModel, 'adapter must attempt session/setModel recovery');
      assert.equal(setModel.model?.providerId, 'anthropic');
      assert.equal(setModel.model?.modelId, 'GLM-5.2');
      assert.equal(setModel.revision, 'hub-env:GLM-5.2');
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not resend the prompt when cancel lands during the -32031 recovery window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-32031-cancel-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompt = acp.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'FAIL_MODEL_UNAVAILABLE DELAY_RECOVERY' }] },
        5000,
      );
      // Let the first send fail with -32031 so the adapter enters the delayed
      // setModel recovery window, then cancel before it can resend.
      await new Promise((r) => setTimeout(r, 200));
      acp.notify('session/cancel', { sessionId });
      const outcome = await prompt;
      assert.equal(outcome.result?.stopReason, 'cancelled');
      const sends = acp.rpcLog().filter((row) => row.method === 'session/send');
      assert.equal(sends.length, 1, 'cancel during recovery must prevent the resend');
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces -32031 as an ACP error when session/setModel recovery is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-32031-norecover-'));
    const acp = startAdapter(dir, { ZCODE_MODEL: 'REJECTED' });
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const prompted = await acp.request('session/prompt', {
        sessionId: created.result.sessionId,
        prompt: [{ type: 'text', text: 'FAIL_MODEL_UNAVAILABLE' }],
      });
      assert.ok(prompted.error, 'unrecoverable -32031 must surface to the ACP client');
      assert.match(String(prompted.error.message), /32031|模型已不可用/);
      assert.equal(
        acp.rpcLog().some((row) => row.method === 'session/setModel'),
        true,
        'adapter must have attempted recovery before surfacing the error',
      );
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles as cancelled (not -32031) when cancel lands while the first send is in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-32031-cancel-send-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompt = acp.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'FAIL_MODEL_UNAVAILABLE DELAY_SEND_FAIL' }] },
        5000,
      );
      await new Promise((r) => setTimeout(r, 200));
      acp.notify('session/cancel', { sessionId });
      const outcome = await prompt;
      assert.equal(outcome.result?.stopReason, 'cancelled', JSON.stringify(outcome.error));
      assert.equal(acp.rpcLog().filter((row) => row.method === 'session/send').length, 1, 'exactly one send');
      assert.equal(
        acp.rpcLog().some((row) => row.method === 'session/setModel'),
        false,
        'no recovery attempt after cancel',
      );
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session/cancel becomes a native session/stop request with id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-cancel-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const prompt = acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'SLEEP_TURN' }],
      });
      await new Promise((r) => setTimeout(r, 80));
      acp.notify('session/cancel', { sessionId });
      const prompted = await prompt;
      assert.equal(prompted.result.stopReason, 'cancelled');
      const stop = acp.rpcLog().find((row) => row.method === 'session/stop');
      assert.ok(stop, 'native session/stop must be recorded');
      assert.notEqual(stop.id, null);
      assert.notEqual(stop.id, undefined);
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session/load keeps history in-process and after adapter restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-load-'));
    const first = startAdapter(dir);
    let sessionId;
    try {
      await first.request('initialize', { protocolVersion: 1 });
      const created = await first.request('session/new', { cwd: dir, mcpServers: [] });
      sessionId = created.result.sessionId;
      const round1 = await first.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'remember TOKEN_A' }],
      });
      assert.equal(round1.result.stopReason, 'end_turn');
      assert.match(assistantText(first.updates, sessionId), /TOKEN_A/);
      const loaded = await first.request('session/load', { sessionId, cwd: dir, mcpServers: [] });
      assert.equal(loaded.result.sessionId, sessionId);
      const afterLoad = first.updates.length;
      const round2 = await first.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'what was the token?' }],
      });
      assert.equal(round2.error, undefined);
      assert.equal(round2.result.stopReason, 'end_turn');
      assert.match(assistantText(first.updates.slice(afterLoad), sessionId), /TOKEN_A/);
    } finally {
      first.child.kill('SIGTERM');
    }

    const second = startAdapter(dir);
    try {
      await second.request('initialize', { protocolVersion: 1 });
      const loaded = await second.request('session/load', { sessionId, cwd: dir, mcpServers: [] });
      assert.equal(loaded.error, undefined, JSON.stringify(loaded.error));
      assert.equal(loaded.result.sessionId, sessionId);
      const beforeRestartPrompt = second.updates.length;
      const round3 = await second.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'what was the token after restart?' }],
      });
      assert.equal(round3.error, undefined);
      assert.match(assistantText(second.updates.slice(beforeRestartPrompt), sessionId), /TOKEN_A/);
    } finally {
      second.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turn.failed becomes a sanitized ACP error, not empty refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-fail-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const prompted = await acp.request('session/prompt', {
        sessionId: created.result.sessionId,
        prompt: [{ type: 'text', text: 'FAIL_SECRET' }],
      });
      assert.ok(prompted.error, 'turn.failed must be an ACP error');
      assert.notEqual(prompted.result?.stopReason, 'refusal');
      const message = String(prompted.error.message);
      assert.match(message, /MISSING_CREDENTIAL/);
      assert.match(message, /provider rejected/);
      assert.doesNotMatch(message, /ZCode turn failed/);
      assert.doesNotMatch(message, /sk-secret-LIVEKEY99/);
      assert.doesNotMatch(message, /supersecret/);
      assert.doesNotMatch(message, /Bearer abc\.def\.ghi/);
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readiness uses clean-home ZCODE_MODEL env token, not zai/glm-5.2', () => {
    const missingModel = diagnoseZcodeSpawnReady({ ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(missingModel.ok, false);
    if (!missingModel.ok) assert.match(missingModel.error.message, /ZCODE_MODEL/);

    const missingKey = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'GLM-5.2' });
    assert.equal(missingKey.ok, false);
    if (!missingKey.ok) {
      assert.match(missingKey.error.message, /ANTHROPIC_API_KEY/);
      assert.doesNotMatch(missingKey.error.message, /cli\/config\.json to make/);
    }

    const ready = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'GLM-5.2', ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(ready.ok, true);
    if (ready.ok) assert.equal(ready.envModel, 'GLM-5.2');
    assert.equal(readZcodeEnvModel('GLM-5.2'), 'GLM-5.2');
    assert.equal(readZcodeEnvModel('zai/glm-5.2'), undefined);
    assert.equal(readZcodeEnvModel('{"providerId":"zai","modelId":"glm-5.2"}'), undefined);
    const slash = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'zai/glm-5.2', ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(slash.ok, false);

    assert.equal(normalizeZcodeAnthropicBaseUrl('https://api.z.ai/api/anthropic'), 'https://api.z.ai/api/anthropic/v1');
    assert.equal(
      normalizeZcodeAnthropicBaseUrl('https://api.z.ai/api/anthropic/v1'),
      'https://api.z.ai/api/anthropic/v1',
    );
    assert.equal(
      normalizeZcodeAnthropicBaseUrl('https://open.bigmodel.cn/api/anthropic/'),
      'https://open.bigmodel.cn/api/anthropic/v1',
    );
    const spawned = zcodeAppServerEnv(
      { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', HOME: '/tmp/parent-home' },
      '/tmp/zcode-isolated',
    );
    assert.equal(spawned.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic/v1');
    assert.equal(spawned.HOME, '/tmp/zcode-isolated');

    const leaked = formatZcodeTurnFailure({
      code: 'MISSING_CREDENTIAL',
      message: 'bad sk-secret-LIVEKEY99 ANTHROPIC_API_KEY=supersecret',
    });
    assert.match(leaked, /MISSING_CREDENTIAL/);
    assert.doesNotMatch(leaked, /sk-secret-LIVEKEY99/);
    assert.doesNotMatch(leaked, /supersecret/);
    assert.equal(sanitizeZcodeFailureText('Bearer abc.def').includes('abc.def'), false);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"api_key":"dummy-short-secret"}'), /dummy-short-secret/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"ZCODE_API_KEY":"dummy-zcode-key"}'), /dummy-zcode-key/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"ANTHROPIC_API_KEY":"dummy-anthropic-key"}'), /dummy-anthropic-key/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"x-api-key":"dummy-x-api-key"}'), /dummy-x-api-key/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"api_key":"secret\\"tail"}'), /secret/);
    assert.doesNotMatch(sanitizeZcodeFailureText('{"api_key":"secret\\"tail"}'), /tail/);
    const unstructured = extractZcodeFailure({ api_key: 'dummy-short-secret', nested: true });
    assert.equal(unstructured.message, undefined);
    assert.doesNotMatch(formatZcodeTurnFailure(unstructured), /dummy-short-secret/);
    assert.deepEqual(ZCODE_PROTOCOL, { name: 'ZCode Protocol', version: 1 });
    assert.ok(AVAILABLE_MODELS.includes('anthropic/GLM-5.2'));
  });

  it('maps ZCode 0.16.3 turn envelopes, not invented event names', () => {
    const sid = 'sess_1';
    const cancelled = parseTurnEvent(
      {
        method: 'session/event',
        params: { sessionId: sid, type: 'turn.completed', payload: { resultType: 'cancelled' } },
      },
      sid,
    );
    assert.equal(cancelled?.terminal, 'cancelled');
    const success = parseTurnEvent(
      {
        method: 'session/event',
        params: { sessionId: sid, type: 'turn.completed', payload: { resultType: 'success' } },
      },
      sid,
    );
    assert.equal(success?.terminal, 'completed');
    const failed = parseTurnEvent(
      {
        method: 'session/event',
        params: {
          sessionId: sid,
          type: 'turn.failed',
          payload: { error: { type: 'MISSING_CREDENTIAL', message: 'nope' }, turnPhase: 'model' },
        },
      },
      sid,
    );
    assert.equal(failed?.terminal, 'failed');
    assert.equal(failed?.failure?.code, 'MISSING_CREDENTIAL');
    assert.equal(failed?.failure?.message, 'nope');
    const flatCheat = parseTurnEvent(
      {
        method: 'session/event',
        params: { sessionId: sid, type: 'turn.failed', payload: { code: 'MISSING_CREDENTIAL', message: 'nope' } },
      },
      sid,
    );
    assert.equal(flatCheat?.failure?.code, undefined);
    assert.equal(flatCheat?.failure?.message, undefined);
    const invented = parseTurnEvent(
      { method: 'session/event', params: { sessionId: sid, type: 'turn.cancelled', payload: {} } },
      sid,
    );
    assert.equal(invented, undefined);
  });

  it('replies to native permission with decision=allow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-perm-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const prompted = await acp.request('session/prompt', {
        sessionId: created.result.sessionId,
        prompt: [{ type: 'text', text: 'ASK_PERMISSION then PONG' }],
      });
      assert.equal(prompted.result.stopReason, 'end_turn');
      const reply = acp.rpcLog().find((row) => row.method === 'interaction/requestPermission/reply');
      assert.equal(reply?.decision, 'allow');
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the turn listener when the first send fails so a retry can succeed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-retry-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const failed = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'FAIL_SEND' }],
      });
      assert.ok(failed.error);
      const afterFail = acp.updates.length;
      const prompted = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply PONG' }],
      });
      assert.equal(prompted.result.stopReason, 'end_turn');
      assert.equal(assistantText(acp.updates.slice(afterFail), sessionId), 'PONG');
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the turn listener when session/send times out so a retry can succeed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-timeout-'));
    const acp = startAdapter(dir, { ZCODE_REQUEST_TIMEOUT_MS: '400' });
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const sessionId = created.result.sessionId;
      const hung = await acp.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'HANG_SEND' }] },
        2000,
      );
      assert.ok(hung.error);
      assert.match(String(hung.error.message), /timeout/);
      const afterHang = acp.updates.length;
      const prompted = await acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply PONG' }],
      });
      assert.equal(prompted.error, undefined, JSON.stringify(prompted.error));
      assert.equal(prompted.result.stopReason, 'end_turn');
      assert.equal(assistantText(acp.updates.slice(afterHang), sessionId), 'PONG');
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts credentials split across stderr chunks before emitting', () => {
    const redactor = new ZcodeStderrRedactor();
    assert.deepEqual(redactor.push('{"api_key":"split-'), []);
    const lines = redactor.push('secret-value"}\n');
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /secret-value/);
    assert.doesNotMatch(lines[0], /split-secret/);
    const overflow = new ZcodeStderrRedactor();
    const dropped = overflow.push(`${'a'.repeat(5000)}`);
    assert.deepEqual(dropped, ['[redacted-truncated]']);
  });

  it('drops the rest of an oversize stderr line until newline so split credentials cannot leak', () => {
    const redactor = new ZcodeStderrRedactor();
    const prefix = `${'a'.repeat(4090)}{"api_key":"split-`;
    assert.deepEqual(redactor.push(prefix), ['[redacted-truncated]']);
    const tail = redactor.push('secret-value"}\nsafe-line\n');
    assert.deepEqual(tail, ['safe-line']);
    assert.doesNotMatch(tail.join('\n'), /secret-value/);
    assert.doesNotMatch(tail.join('\n'), /split-/);
    const later = redactor.push('{"api_key":"after-drop"}\n');
    assert.equal(later.length, 1);
    assert.doesNotMatch(later[0], /after-drop/);
    const dangling = new ZcodeStderrRedactor();
    assert.deepEqual(dangling.push(prefix), ['[redacted-truncated]']);
    assert.deepEqual(dangling.push('secret-value"}'), []);
    assert.equal(dangling.flush(), undefined);
  });

  it('settles the prompt waiter when the native child exits after send accepted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-acp-exit-'));
    const acp = startAdapter(dir);
    try {
      await acp.request('initialize', { protocolVersion: 1 });
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] });
      const prompted = await acp.request(
        'session/prompt',
        {
          sessionId: created.result.sessionId,
          prompt: [{ type: 'text', text: 'EXIT_AFTER_SEND' }],
        },
        3000,
      );
      assert.ok(prompted.error, 'child exit after send must not hang the ACP prompt');
      assert.match(String(prompted.error.message), /native_exit|exited/);
    } finally {
      acp.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
