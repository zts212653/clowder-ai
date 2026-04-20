/**
 * F162 Phase B: LarkCliExecutor unit tests.
 *
 * Tests the CLI wrapper in isolation. Covers: availability check, JSON parsing,
 * error classification (API error, CLI unavailable), flag composition.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function noopLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  };
}

const { LarkCliExecutor, LarkApiError, LarkCliUnavailableError, LarkCliProtocolError } = await import(
  '../../dist/infrastructure/enterprise/LarkCliExecutor.js'
);

describe('LarkCliExecutor', () => {
  let executor;

  beforeEach(() => {
    executor = new LarkCliExecutor(noopLog());
    executor._resetCache();
  });

  describe('isAvailable()', () => {
    it('returns a boolean', async () => {
      const result = await executor.isAvailable();
      assert.equal(typeof result, 'boolean');
    });

    it('caches the result on subsequent calls', async () => {
      const r1 = await executor.isAvailable();
      const r2 = await executor.isAvailable();
      assert.equal(r1, r2);
    });
  });

  describe('LarkApiError', () => {
    it('has correct properties from the error detail', () => {
      const err = new LarkApiError(
        {
          type: 'validation_error',
          code: 1470400,
          message: 'Invalid request parameters',
          hint: 'Check the assignee id',
        },
        'task',
        '+create',
      );
      assert.equal(err.code, 1470400);
      assert.equal(err.type, 'validation_error');
      assert.equal(err.hint, 'Check the assignee id');
      assert.equal(err.domain, 'task');
      assert.equal(err.command, '+create');
      assert.equal(err.name, 'LarkApiError');
      assert.ok(err.message.includes('1470400'));
      assert.ok(err.message.includes('Invalid request parameters'));
    });
  });

  describe('LarkCliUnavailableError', () => {
    it('has correct properties', () => {
      const cause = new Error('boom');
      const err = new LarkCliUnavailableError('lark-cli not found', cause);
      assert.equal(err.name, 'LarkCliUnavailableError');
      assert.equal(err.message, 'lark-cli not found');
      assert.equal(err.reason, cause);
    });

    it('works without a reason', () => {
      const err = new LarkCliUnavailableError('not installed');
      assert.equal(err.reason, undefined);
    });
  });

  describe('parseOutput', () => {
    const parse = (raw) => executor['parseOutput'](raw);

    it('parses standard success envelope { ok: true, identity, data }', () => {
      const raw = JSON.stringify({ ok: true, identity: 'user', data: { x: 1 } });
      const result = parse(raw);
      assert.equal(result.ok, true);
      assert.equal(result.identity, 'user');
      assert.deepEqual(result.data, { x: 1 });
    });

    it('parses failure envelope { ok: false, identity, error }', () => {
      const raw = JSON.stringify({
        ok: false,
        identity: 'user',
        error: { type: 'validation_error', code: 1470400, message: 'bad' },
      });
      const result = parse(raw);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 1470400);
    });

    it('treats missing ok as success and wraps raw JSON as data', () => {
      const raw = JSON.stringify({ some: 'payload', nested: { y: 2 } });
      const result = parse(raw);
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, { some: 'payload', nested: { y: 2 } });
    });

    it('throws LarkCliProtocolError (not SyntaxError) on malformed JSON', () => {
      // Prevents misclassification as "CLI unavailable" (503) — see callback route.
      assert.throws(
        () => parse('not-json{'),
        (err) => {
          assert.ok(err instanceof LarkCliProtocolError, `expected LarkCliProtocolError, got ${err?.name}`);
          assert.equal(err.name, 'LarkCliProtocolError');
          assert.ok(err.rawOutput?.includes('not-json{'));
          assert.ok(err.reason instanceof SyntaxError);
          return true;
        },
      );
    });

    it('LarkCliProtocolError truncates rawOutput to 500 chars', () => {
      const big = `{{{${'x'.repeat(600)}`;
      assert.throws(
        () => parse(big),
        (err) => {
          assert.ok(err instanceof LarkCliProtocolError);
          assert.equal(err.rawOutput.length, 500);
          return true;
        },
      );
    });
  });

  describe('LarkCliProtocolError', () => {
    it('has correct properties', () => {
      const cause = new SyntaxError('Unexpected token');
      const err = new LarkCliProtocolError('non-JSON output', cause, '<html>...</html>');
      assert.equal(err.name, 'LarkCliProtocolError');
      assert.equal(err.message, 'non-JSON output');
      assert.equal(err.reason, cause);
      assert.equal(err.rawOutput, '<html>...</html>');
    });
  });

  describe('exec() — when CLI is unavailable', () => {
    it('throws LarkCliUnavailableError if isAvailable is false', async () => {
      await executor.isAvailable();
      executor._resetCache();
      Object.defineProperty(executor, 'available', { value: false, writable: true });

      await assert.rejects(
        () => executor.exec('docs', '+create', { title: 'x' }),
        (err) => {
          assert.ok(err instanceof LarkCliUnavailableError);
          return true;
        },
      );
    });
  });
});
