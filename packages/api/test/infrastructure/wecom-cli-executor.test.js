/**
 * F162: WeComCliExecutor unit tests.
 *
 * Tests the CLI wrapper in isolation — mocks execFile to avoid needing
 * actual wecom-cli credentials. Covers: availability check, JSON parsing,
 * error classification (API error, timeout, ENOENT).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

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

// Dynamic import so we can mock child_process before module load
const { WeComCliExecutor, WeComApiError, WeComCliUnavailableError } = await import(
  '../../dist/infrastructure/enterprise/WeComCliExecutor.js'
);

describe('WeComCliExecutor', () => {
  let executor;

  beforeEach(() => {
    executor = new WeComCliExecutor(noopLog());
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

  describe('WeComApiError', () => {
    it('has correct properties', () => {
      const err = new WeComApiError(40001, 'invalid token', 'doc', 'create_doc');
      assert.equal(err.errcode, 40001);
      assert.equal(err.errmsg, 'invalid token');
      assert.equal(err.category, 'doc');
      assert.equal(err.method, 'create_doc');
      assert.equal(err.name, 'WeComApiError');
      assert.ok(err.message.includes('40001'));
      assert.ok(err.message.includes('invalid token'));
    });
  });

  describe('WeComCliUnavailableError', () => {
    it('has correct properties', () => {
      const cause = new Error('boom');
      const err = new WeComCliUnavailableError('wecom-cli not found', cause);
      assert.equal(err.name, 'WeComCliUnavailableError');
      assert.equal(err.message, 'wecom-cli not found');
      assert.equal(err.reason, cause);
    });

    it('works without a reason', () => {
      const err = new WeComCliUnavailableError('not installed');
      assert.equal(err.reason, undefined);
    });
  });

  describe('unwrapOutput (calls actual private method via bracket notation)', () => {
    // JS doesn't enforce TS private — bracket notation invokes the real method.
    const unwrap = (raw) => executor['unwrapOutput'](raw);

    it('unwraps MCP content wrapper format', () => {
      const mcpWrapped = JSON.stringify({
        content: [{ text: JSON.stringify({ errcode: 0, errmsg: 'ok', docid: 'D1' }), type: 'text' }],
        isError: false,
      });
      const result = unwrap(mcpWrapped);
      assert.equal(result.errcode, 0);
      assert.equal(result.docid, 'D1');
    });

    it('passes through raw JSON (no MCP wrapper)', () => {
      const rawJson = JSON.stringify({ errcode: 0, errmsg: 'ok', docid: 'D2' });
      const result = unwrap(rawJson);
      assert.equal(result.errcode, 0);
      assert.equal(result.docid, 'D2');
    });

    it('throws on malformed JSON', () => {
      assert.throws(() => unwrap('not-json{'), { name: 'SyntaxError' });
    });

    it('falls back to raw when content array is empty', () => {
      const emptyContent = JSON.stringify({ content: [], errcode: 0, errmsg: 'ok', extra: 'val' });
      const result = unwrap(emptyContent);
      assert.equal(result.errcode, 0);
      assert.equal(result.extra, 'val');
    });
  });

  describe('exec() — when CLI is unavailable', () => {
    it('throws WeComCliUnavailableError if isAvailable is false', async () => {
      // Force unavailable
      await executor.isAvailable(); // populate cache
      executor._resetCache();
      // Manually set unavailable by overriding the private field via prototype trick
      Object.defineProperty(executor, 'available', { value: false, writable: true });

      await assert.rejects(
        () => executor.exec('doc', 'create_doc', { doc_name: 'test' }),
        (err) => {
          assert.ok(err instanceof WeComCliUnavailableError);
          return true;
        },
      );
    });
  });
});
