import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LegacyPawFeelBlockerCensusCursorSigner,
  LegacyPawFeelBlockerCensusService,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-census.js';

const SIGNAL_COUNT = 500;
const signalIds = Array.from(
  { length: SIGNAL_COUNT },
  (_, index) => `legacy-${String(index).padStart(3, '0')}:${index.toString(16).padStart(64, '0')}:0`,
);

function events(signalId, index) {
  return [
    {
      eventId: `discover:${index}`,
      signalId,
      type: 'discovered',
      actor: { kind: 'migration', id: 'legacy-fixture' },
      occurredAt: '2026-09-01T00:00:00.000Z',
      source: {
        sourceMessageId: `legacy-${String(index).padStart(3, '0')}`,
        sourceThreadId: 'thread-source',
        sourceCatId: 'codex-sol',
        markerDigest: index.toString(16).padStart(64, '0'),
        sameDigestOrdinal: 0,
        markerIndex: 0,
      },
      backfilled: true,
      captureMethod: 'legacy_parser',
      captureAssessment: 'ambiguous',
    },
    {
      eventId: `blocked:${index}`,
      signalId,
      type: 'blocked',
      actor: { kind: 'cat', id: 'opus' },
      occurredAt: '2026-09-01T00:00:01.000Z',
      blockerCode: 'legacy_wait',
      blockerRef: `legacy:${index}`,
    },
  ];
}

function harness() {
  const scanLimits = [];
  const readCalls = [];
  const service = {
    async scanSignalIds(cursor, limit) {
      scanLimits.push(limit);
      const offset = cursor ? Number(cursor.redisCursor) : 0;
      const page = signalIds.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        signalIds: page,
        scanCalls: 1,
        ...(nextOffset < signalIds.length
          ? {
              nextCursor: {
                redisCursor: String(nextOffset),
                pendingSignalIds: [],
                completeAfterPending: false,
              },
            }
          : {}),
      };
    },
    async readSignalEvents(signalId) {
      readCalls.push(signalId);
      const index = signalIds.indexOf(signalId);
      return events(signalId, index);
    },
  };
  return {
    census: new LegacyPawFeelBlockerCensusService({
      service,
      signer: new LegacyPawFeelBlockerCensusCursorSigner(Buffer.alloc(32, 9)),
      now: () => '2026-09-09T00:00:00.000Z',
    }),
    scanLimits,
    readCalls,
  };
}

describe('F313 bounded legacy blocker census', () => {
  it('returns no manifest until a complete 500-signal traversal and keeps only the smallest 51 refs', async () => {
    const { census, scanLimits, readCalls } = harness();
    let cursor;
    let response;
    let calls = 0;
    do {
      const readsBefore = readCalls.length;
      response = await census.read({ cursor, limit: 50 });
      calls += 1;
      assert.ok(response.pageScannedSignals <= 50);
      assert.ok(readCalls.length - readsBefore <= 50);
      if (response.status === 'partial') {
        assert.equal('manifest' in response, false);
        assert.ok(response.nextCursor.length < 100_000);
        cursor = response.nextCursor;
      } else {
        cursor = undefined;
      }
      assert.ok(calls <= 10);
    } while (cursor);

    assert.equal(calls, 10);
    assert.deepEqual(scanLimits, Array(10).fill(50));
    assert.equal(response.status, 'complete');
    assert.equal(response.totalScannedSignals, 500);
    assert.equal(response.manifest.entries.length, 50);
    assert.equal(response.manifest.truncated, true);
    assert.deepEqual(
      response.manifest.entries.map((entry) => entry.signalId),
      signalIds.slice(0, 50),
    );
    assert.match(response.manifest.manifestDigest, /^[a-f0-9]{64}$/);
  });

  it('rejects forged, oversized, and limit-drifted continuation tokens', async () => {
    const { census } = harness();
    const first = await census.read({ limit: 25 });
    assert.equal(first.status, 'partial');
    assert.equal('manifest' in first, false);

    for (const cursor of [`${first.nextCursor.slice(0, -1)}x`, 'x'.repeat(100_001)]) {
      await assert.rejects(census.read({ cursor, limit: 25 }), /cursor|token/i);
    }
    await assert.rejects(census.read({ cursor: first.nextCursor, limit: 50 }), /limit/i);
  });
});
