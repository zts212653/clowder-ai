import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchTraces,
  parseMetricsHistoryResponse,
  parseTraceStoreStats,
  parseTracesResponse,
} from '../../dist/infrastructure/harness-eval/telemetry-adapter.js';
import metricsHistoryFixture from './fixtures/metrics-history-response.json' with { type: 'json' };
import tracesFixture from './fixtures/traces-response.json' with { type: 'json' };
import statsFixture from './fixtures/traces-stats-response.json' with { type: 'json' };

describe('F192 Telemetry Adapter Contract', () => {
  describe('parseTracesResponse', () => {
    it('parses /traces response preserving span structure', () => {
      const result = parseTracesResponse(tracesFixture);
      assert.ok(Array.isArray(result.spans));
      assert.equal(result.count, 2);
      const span = result.spans[0];
      assert.equal(span.traceId, 'abcdef1234567890abcdef1234567890');
      assert.equal(span.spanId, '1234567890abcdef');
      assert.equal(span.name, 'cat_cafe.invocation');
      assert.equal(typeof span.startTimeMs, 'number');
      assert.equal(typeof span.endTimeMs, 'number');
      assert.equal(typeof span.durationMs, 'number');
      assert.deepEqual(span.status, { code: 0 });
      assert.ok(Array.isArray(span.events));
    });

    it('preserves parentSpanId when present', () => {
      const result = parseTracesResponse(tracesFixture);
      assert.equal(result.spans[0].parentSpanId, undefined);
      assert.equal(result.spans[1].parentSpanId, '1234567890abcdef');
    });

    it('preserves trace event attributes', () => {
      const result = parseTracesResponse(tracesFixture);
      const event = result.spans[0].events[0];
      assert.equal(event.name, 'tool_use');
      assert.equal(typeof event.timeMs, 'number');
      assert.equal(event.attributes['tool.name'], 'cat_cafe_hold_ball');
    });

    it('strips storedAt from output (F192 adapter boundary)', () => {
      const result = parseTracesResponse(tracesFixture);
      for (const span of result.spans) {
        assert.equal('storedAt' in span, false);
      }
    });

    it('strips kind from output (F192 adapter boundary)', () => {
      const result = parseTracesResponse(tracesFixture);
      for (const span of result.spans) {
        assert.equal('kind' in span, false);
      }
    });

    it('rejects malformed response missing spans', () => {
      assert.throws(() => parseTracesResponse({ wrong: 'shape' }), /expected.*spans/i);
    });

    it('rejects non-array spans', () => {
      assert.throws(() => parseTracesResponse({ spans: 'not-array', count: 0 }), /expected.*spans.*array/i);
    });
  });

  describe('parseMetricsHistoryResponse', () => {
    it('parses /metrics/history response', () => {
      const result = parseMetricsHistoryResponse(metricsHistoryFixture);
      assert.ok(Array.isArray(result.snapshots));
      assert.equal(result.count, 2);
      const snap = result.snapshots[0];
      assert.equal(typeof snap.timestamp, 'number');
      assert.equal(typeof snap.metrics, 'object');
      assert.equal(snap.metrics['cat_cafe_a2a_inline_action_checked'], 150);
    });

    it('rejects malformed response missing snapshots', () => {
      assert.throws(() => parseMetricsHistoryResponse({ bad: true }), /expected.*snapshots/i);
    });
  });

  describe('parseTraceStoreStats', () => {
    it('parses /traces/stats response', () => {
      const result = parseTraceStoreStats(statsFixture);
      assert.equal(result.spanCount, 4500);
      assert.equal(result.maxSpans, 10000);
      assert.equal(result.maxAgeMs, 86400000);
      assert.equal(result.oldestStoredAt, 1715213600000);
      assert.equal(result.newestStoredAt, 1715300005300);
    });

    it('handles null oldest/newest timestamps', () => {
      const result = parseTraceStoreStats({
        spanCount: 0,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: null,
        newestStoredAt: null,
      });
      assert.equal(result.oldestStoredAt, null);
      assert.equal(result.newestStoredAt, null);
    });

    it('rejects missing spanCount', () => {
      assert.throws(() => parseTraceStoreStats({ maxSpans: 10000 }), /expected.*spanCount/i);
    });
  });

  // F192 verdict 2026-06-17-eval-a2a-c1-sample-window-build — expandLimit
  // passthrough on fetchTraces. The adapter is the only path scheduled eval
  // uses to talk to /api/telemetry/traces; if it silently drops expandLimit
  // the route fix is invisible to run-f167-eval.
  describe('fetchTraces expandLimit URL passthrough', () => {
    /** Replace globalThis.fetch with a recorder that returns a stub response. */
    function withCapturedFetch(body, fn) {
      const original = globalThis.fetch;
      let capturedUrl = '';
      let capturedHeaders = null;
      globalThis.fetch = async (url, opts) => {
        capturedUrl = String(url);
        capturedHeaders = opts?.headers ?? null;
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      };
      return Promise.resolve(fn(() => ({ url: capturedUrl, headers: capturedHeaders }))).finally(() => {
        globalThis.fetch = original;
      });
    }

    const emptyTracesBody = { spans: [], count: 0 };

    it('passes expandLimit=true as query param when filter.expandLimit set', async () => {
      await withCapturedFetch(emptyTracesBody, async (get) => {
        await fetchTraces({ baseUrl: 'http://test', cookie: 'k=v' }, { limit: 10000, expandLimit: true });
        const { url } = get();
        assert.ok(url.includes('expandLimit=true'), `expected expandLimit=true in URL, got: ${url}`);
        assert.ok(url.includes('limit=10000'), `expected limit=10000 in URL, got: ${url}`);
      });
    });

    it('omits expandLimit when filter.expandLimit is undefined (default)', async () => {
      await withCapturedFetch(emptyTracesBody, async (get) => {
        await fetchTraces({ baseUrl: 'http://test', cookie: 'k=v' }, { limit: 200 });
        const { url } = get();
        assert.ok(!url.includes('expandLimit'), `expected no expandLimit param, got: ${url}`);
      });
    });

    it('omits expandLimit when filter.expandLimit is false (explicit opt-out)', async () => {
      await withCapturedFetch(emptyTracesBody, async (get) => {
        await fetchTraces({ baseUrl: 'http://test', cookie: 'k=v' }, { limit: 200, expandLimit: false });
        const { url } = get();
        assert.ok(!url.includes('expandLimit'), `false should not emit param, got: ${url}`);
      });
    });
  });
});
