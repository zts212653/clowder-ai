import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { connectionDiagnosticsFixture as fixture } from './helpers/connection-diagnostics-fixture.js';

test('real HTTP accepts correlated reading cancellation, rejects private payload and preserves the old event', async () => {
  const { app, records } = await fixture();
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const session = await fetch(`${base}/api/session`);
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const headers = {
    cookie: session.headers.get('set-cookie')?.split(';')[0] ?? '',
    origin: base,
    'x-csrf-token': csrfToken,
    'Content-Type': 'application/json',
  };
  const bridgeId = randomUUID(),
    operationId = randomUUID(),
    readerId = randomUUID();
  const events = [
    {
      eventId: randomUUID(),
      at: Date.now(),
      kind: 'settings_return',
      bridgeId,
      phase: 'return',
      notice: null,
      noticeSeq: 0,
      returning: true,
      hasSource: true,
      hasReader: false,
      admitted: false,
    },
    {
      eventId: randomUUID(),
      at: Date.now(),
      kind: 'reading_restore',
      bridgeId,
      operationId,
      readerId,
      phase: 'cancel',
      cancelSource: 'bootstrap_cleanup',
      readerMounted: true,
      refreshPending: true,
      restorePending: false,
      settlementPending: false,
    },
  ];
  const post = (payload: unknown, requestHeaders: Record<string, string> = headers) =>
    fetch(`${base}/api/diagnostics/connection`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(payload),
    });
  try {
    assert.equal((await post({ v: 1, events })).status, 204);
    const accepted = records.filter((r) => r.kind === 'reading_restore');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.operationId, operationId);
    assert.equal(accepted[0]?.readerId, readerId);
    assert.equal(accepted[0]?.trustedTiming, false);
    assert.equal((await post({ v: 1, events }, { ...headers, 'x-csrf-token': 'forged' })).status, 403);
    for (const invalid of [
      { ...events[1], body: 'private body' },
      { ...events[1], cancelSource: 'private reason' },
      { ...events[1], readerId: 'raw-reader' },
      { ...events[1], source: 'private original' },
      { ...events[1], url: 'private URL' },
      { ...events[1], draft: 'private draft' },
      { ...events[1], token: 'private token' },
    ])
      assert.equal((await post({ v: 1, events: [invalid] })).status, 400);
    assert.equal((await post({ v: 1, events: Array(61).fill(events[1]) })).status, 400);
    assert.equal(records.filter((r) => r.kind === 'reading_restore').length, 1);
    assert.ok(!JSON.stringify(accepted).includes('private'));
  } finally {
    await app.close();
  }
});

test(
  'the existing Web collector delivers its bounded reading record through the real authenticated HTTP endpoint',
  { timeout: 12000 },
  async () => {
    let observed!: () => void;
    const recorded = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const { app, records } = await fixture((record) => {
      if (record.kind === 'reading_restore') observed();
    });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const originalFetch = globalThis.fetch;
    const session = await originalFetch(`${base}/api/session`);
    const sessionBody = (await session.json()) as { csrfToken: string };
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    let acknowledged!: (status: number) => void;
    const delivered = new Promise<number>((resolve) => {
      acknowledged = resolve;
    });
    let payload: unknown;
    // Node has no browser cookie jar. Supply only this isolated server's fixture cookie;
    // the production collector still constructs and sends its own exact request body/CSRF header.
    globalThis.fetch = async (input, init) => {
      if (String(input) !== `${base}/api/diagnostics/connection`) return originalFetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      headers.set('origin', base);
      assert.equal(headers.get('x-csrf-token'), sessionBody.csrfToken);
      payload = JSON.parse(String(init?.body));
      const response = await originalFetch(input, { ...init, headers });
      acknowledged(response.status);
      return response;
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const compiled = await build({
        entryPoints: [fileURLToPath(new URL('../../web/src/utils/connection-diagnostics.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        alias: {
          '@cat-cafe/shared': fileURLToPath(
            new URL('../../shared/dist/types/connection-diagnostics.js', import.meta.url),
          ),
        },
      });
      const collector = await import(
        `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
      );
      const { configureConnectionDiagnostics, recordConnectionDiagnostic } = collector;
      const bridgeId = randomUUID(),
        operationId = randomUUID(),
        readerId = randomUUID();
      configureConnectionDiagnostics(base, () => sessionBody.csrfToken);
      recordConnectionDiagnostic({
        kind: 'reading_restore',
        bridgeId,
        operationId,
        readerId,
        phase: 'cancel',
        cancelSource: 'bootstrap_cleanup',
        readerMounted: true,
        refreshPending: true,
        restorePending: false,
        settlementPending: false,
      });
      const [, status] = await Promise.race([
        Promise.all([recorded, delivered]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Isolated Web diagnostic delivery did not finish')), 8000);
        }),
      ]);
      assert.equal(status, 204);
      assert.ok(payload && typeof payload === 'object');
      const logged = records.find((record) => record.kind === 'reading_restore');
      assert.equal(logged?.operationId, operationId);
      assert.equal(logged?.readerId, readerId);
      assert.equal(logged?.cancelSource, 'bootstrap_cleanup');
      assert.equal(logged?.trustedTiming, false);
      assert.ok(!JSON.stringify(logged).includes(cookie));
      assert.ok(!JSON.stringify(logged).includes(sessionBody.csrfToken));
    } finally {
      if (deadline) clearTimeout(deadline);
      globalThis.fetch = originalFetch;
      await app.close();
    }
  },
);
