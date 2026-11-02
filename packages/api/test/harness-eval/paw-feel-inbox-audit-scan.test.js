import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  loadOrCreatePawFeelInboxAuditCursorSigner,
  PawFeelInboxAuditCursorError,
  PawFeelInboxAuditCursorSigner,
  PawFeelInboxAuditScanService,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/inbox-audit-scan.js';

function disposition(signalId) {
  const sourceMessageId = signalId.split(':')[0];
  return {
    signalId,
    sourceMessageId,
    sourceThreadId: 'thread-source',
    sourceCatId: 'codex-sol',
    markerDigest: 'a'.repeat(64),
    sameDigestOrdinal: 0,
    markerIndex: 0,
    state: 'new',
    sequence: 1,
    discoveredAt: '2026-10-22T00:00:00.000Z',
    lastTransitionAt: '2026-10-22T00:00:00.000Z',
    backfilled: false,
    captureMethod: 'typed',
    captureAssessment: 'confirmed',
  };
}

function fixture(total = 10_000) {
  const signalIds = Array.from(
    { length: total },
    (_, index) => `message-${String(index).padStart(5, '0')}:${'a'.repeat(64)}:0`,
  );
  const scanInputs = [];
  const readBatches = [];
  return {
    scanInputs,
    readBatches,
    service: new PawFeelInboxAuditScanService({
      eventLog: {
        async scanSignalIds(cursor, limit) {
          scanInputs.push(cursor);
          const offset = cursor ? Number(cursor.redisCursor) : 0;
          const page = signalIds.slice(offset, offset + limit);
          const next = offset + page.length;
          return {
            signalIds: page,
            scanCalls: 1,
            ...(next < signalIds.length
              ? {
                  nextCursor: {
                    redisCursor: String(next),
                    pendingSignalIds: [],
                    completeAfterPending: false,
                  },
                }
              : {}),
          };
        },
      },
      readModel: {
        async readAuditSignals(ids) {
          readBatches.push([...ids]);
          return ids.map((signalId) => ({
            disposition: disposition(signalId),
            source: {
              availability: 'available',
              preview: signalId,
              sourceHref: `/thread/thread-source?message=${signalId.split(':')[0]}`,
              digestVerified: true,
            },
          }));
        },
      },
      signer: new PawFeelInboxAuditCursorSigner(Buffer.alloc(32, 4)),
      now: () => '2026-10-22T17:00:00.000Z',
    }),
  };
}

describe('F278 bounded inbox audit scan', () => {
  it('reads only each 50-signal page even when the canonical ledger has 10k rows', async () => {
    const { service, scanInputs, readBatches } = fixture();

    const first = await service.read({ limit: 50 });
    assert.equal(first.status, 'partial');
    assert.equal(first.pageScannedSignals, 50);
    assert.equal(first.totalScannedSignals, 50);
    assert.equal(first.entries.length, 50);
    assert.ok(first.nextCursor);

    const second = await service.read({ limit: 50, cursor: first.nextCursor });
    assert.equal(second.status, 'partial');
    assert.equal(second.pageScannedSignals, 50);
    assert.equal(second.totalScannedSignals, 100);
    assert.equal(second.entries.length, 50);
    assert.deepEqual(
      readBatches.map((batch) => batch.length),
      [50, 50],
    );
    assert.equal(new Set(readBatches.flat()).size, 100);
    assert.equal(scanInputs[0], undefined);
    assert.equal(scanInputs[1].redisCursor, '50');
  });

  it('returns a complete final page without fabricating global aggregates', async () => {
    const { service } = fixture(3);

    const page = await service.read({ limit: 50 });

    assert.equal(page.status, 'complete');
    assert.equal(page.pageScannedSignals, 3);
    assert.equal(page.totalScannedSignals, 3);
    assert.equal(page.entries.length, 3);
    assert.equal('nextCursor' in page, false);
    assert.equal('denominator' in page, false);
    assert.equal('responsibilityCounts' in page, false);
    assert.equal('bundleCounts' in page, false);
  });

  it('rejects forged cursors and limit drift before reading another page', async () => {
    const { service, readBatches } = fixture();
    const first = await service.read({ limit: 25 });
    assert.equal(first.status, 'partial');
    assert.ok(first.nextCursor);

    await assert.rejects(
      () => service.read({ limit: 50, cursor: first.nextCursor }),
      (error) => error instanceof PawFeelInboxAuditCursorError && /limit changed/u.test(error.message),
    );
    const forged = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('a') ? 'b' : 'a'}`;
    await assert.rejects(
      () => service.read({ limit: 25, cursor: forged }),
      (error) => error instanceof PawFeelInboxAuditCursorError && /signature/u.test(error.message),
    );
    assert.equal(readBatches.length, 1);
  });

  it('keeps signed continuations valid across signer reloads from the durable secret', async () => {
    const values = new Map();
    const redis = {
      async set(key, value, mode) {
        assert.equal(mode, 'NX');
        if (!values.has(key)) values.set(key, value);
        return values.get(key) === value ? 'OK' : null;
      },
      async get(key) {
        return values.get(key) ?? null;
      },
    };
    const first = await loadOrCreatePawFeelInboxAuditCursorSigner(redis);
    const token = first.sign({
      v: 1,
      contract: 'f278-inbox-audit-scan:v1',
      startedAt: '2026-10-22T17:00:00.000Z',
      pageLimit: 25,
      totalScannedSignals: 25,
      scanCursor: { redisCursor: '25', pendingSignalIds: [], completeAfterPending: false },
    });

    const reloaded = await loadOrCreatePawFeelInboxAuditCursorSigner(redis);
    assert.equal(reloaded.verify(token).totalScannedSignals, 25);
    assert.equal(values.size, 1);
  });
});
