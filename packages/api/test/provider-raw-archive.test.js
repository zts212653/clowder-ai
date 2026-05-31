/**
 * #780: Raw NDJSON archive integration tests for Claude / OpenCode / Kimi providers.
 *
 * Codex already had raw archive support — these tests verify the same pattern
 * was wired correctly in the other three CLI-based providers.
 *
 * Test strategy: inject a mock RawArchiveSink and verify:
 *   1. Events are archived when invocationId is provided
 *   2. Events are NOT archived when invocationId is absent
 *   3. Sensitive tokens are redacted before archiving (sanitizeRawEvent)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockArchive,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

ensureFakeCliOnPath('claude');
ensureFakeCliOnPath('opencode');
ensureFakeCliOnPath('kimi');

const { ClaudeAgentService } = await import('../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
const { OpenCodeAgentService } = await import('../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js');
const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');

// ── Claude raw archive tests ──

describe('#780 ClaudeAgentService raw archive', () => {
  test('archives events when invocationId is provided', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-test',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive,
    });

    const promise = collect(service.invoke('test raw archive', { invocationId: 'inv-claude-1' }));

    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-1' },
      { type: 'result', subtype: 'success' },
    ]);

    await promise;

    assert.ok(
      rawArchive.append.mock.callCount() >= 2,
      `Expected ≥2 archive calls, got ${rawArchive.append.mock.callCount()}`,
    );
    assert.equal(rawArchive.append.mock.calls[0].arguments[0], 'inv-claude-1', 'invocationId passed to archive');
  });

  test('does NOT archive events when invocationId is absent', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-test',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive,
    });

    const promise = collect(service.invoke('no invocation id'));

    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-2' },
      { type: 'result', subtype: 'success' },
    ]);

    await promise;

    assert.equal(rawArchive.append.mock.callCount(), 0, 'No archive calls without invocationId');
  });

  test('redacts sensitive tokens before archiving', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-test',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive,
    });

    const promise = collect(service.invoke('redact test', { invocationId: 'inv-claude-redact' }));

    emitEvents(proc, [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'ses-r',
        callbackToken: 'secret-token-123',
      },
    ]);

    await promise;

    assert.ok(rawArchive.append.mock.callCount() >= 1);
    const archived = rawArchive.append.mock.calls[0].arguments[1];
    assert.equal(archived.callbackToken, '[redacted]', 'callbackToken is redacted in archive');
  });
});

// ── OpenCode raw archive tests ──

describe('#780 OpenCodeAgentService raw archive', () => {
  test('archives events when invocationId is provided', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new OpenCodeAgentService({
      spawnFn,
      model: 'opencode-test',
      rawArchive,
    });

    const promise = collect(service.invoke('test raw archive', { invocationId: 'inv-oc-1' }));

    emitEvents(proc, [
      {
        type: 'step_start',
        timestamp: Date.now(),
        sessionID: 'ses-oc-1',
        part: { type: 'step-start', id: 'p1', sessionID: 'ses-oc-1' },
      },
      {
        type: 'text',
        timestamp: Date.now(),
        part: { type: 'text', text: 'hello from opencode' },
      },
    ]);

    await promise;

    assert.ok(
      rawArchive.append.mock.callCount() >= 2,
      `Expected ≥2 archive calls, got ${rawArchive.append.mock.callCount()}`,
    );
    assert.equal(rawArchive.append.mock.calls[0].arguments[0], 'inv-oc-1', 'invocationId passed to archive');
  });

  test('does NOT archive events when invocationId is absent', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new OpenCodeAgentService({
      spawnFn,
      model: 'opencode-test',
      rawArchive,
    });

    const promise = collect(service.invoke('no invocation id'));

    emitEvents(proc, [
      {
        type: 'text',
        timestamp: Date.now(),
        part: { type: 'text', text: 'hello' },
      },
    ]);

    await promise;

    assert.equal(rawArchive.append.mock.callCount(), 0, 'No archive calls without invocationId');
  });

  test('redacts sensitive tokens before archiving', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new OpenCodeAgentService({
      spawnFn,
      model: 'opencode-test',
      rawArchive,
    });

    const promise = collect(service.invoke('redact test', { invocationId: 'inv-oc-redact' }));

    emitEvents(proc, [
      {
        type: 'text',
        timestamp: Date.now(),
        part: { type: 'text', text: 'hello' },
        callbackToken: 'oc-secret-token',
        nested: { callback_token: 'deep-secret' },
      },
    ]);

    await promise;

    assert.ok(rawArchive.append.mock.callCount() >= 1);
    const archived = rawArchive.append.mock.calls[0].arguments[1];
    assert.equal(archived.callbackToken, '[redacted]');
    assert.equal(archived.nested.callback_token, '[redacted]');
  });
});

// ── Kimi raw archive tests ──

describe('#780 KimiAgentService raw archive', () => {
  test('archives events when invocationId is provided', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new KimiAgentService({
      spawnFn,
      model: 'kimi-test',
      rawArchive,
    });

    const promise = collect(service.invoke('test raw archive', { invocationId: 'inv-kimi-1' }));

    emitEvents(proc, [{ role: 'assistant', content: 'hello from kimi' }]);

    await promise;

    assert.ok(
      rawArchive.append.mock.callCount() >= 1,
      `Expected ≥1 archive calls, got ${rawArchive.append.mock.callCount()}`,
    );
    assert.equal(rawArchive.append.mock.calls[0].arguments[0], 'inv-kimi-1', 'invocationId passed to archive');
  });

  test('does NOT archive events when invocationId is absent', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new KimiAgentService({
      spawnFn,
      model: 'kimi-test',
      rawArchive,
    });

    const promise = collect(service.invoke('no invocation id'));

    emitEvents(proc, [{ role: 'assistant', content: 'hello' }]);

    await promise;

    assert.equal(rawArchive.append.mock.callCount(), 0, 'No archive calls without invocationId');
  });

  test('redacts sensitive tokens before archiving', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new KimiAgentService({
      spawnFn,
      model: 'kimi-test',
      rawArchive,
    });

    const promise = collect(service.invoke('redact test', { invocationId: 'inv-kimi-redact' }));

    emitEvents(proc, [
      {
        role: 'assistant',
        content: 'hello',
        callbackToken: 'kimi-secret',
      },
    ]);

    await promise;

    assert.ok(rawArchive.append.mock.callCount() >= 1);
    const archived = rawArchive.append.mock.calls[0].arguments[1];
    assert.equal(archived.callbackToken, '[redacted]');
  });
});
