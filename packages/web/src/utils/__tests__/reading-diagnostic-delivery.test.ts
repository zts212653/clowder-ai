// @vitest-environment jsdom
import { connectionDiagnosticBatchSchema, connectionDiagnosticEventSchema } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const bridgeId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const readerId = '33333333-3333-4333-8333-333333333333';
const event = {
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
} as const;
const storage = 'cat-cafe:connection-diagnostics:v1';
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});
it('strictly accepts the finite diagnostic and preserves old Settings consumers without new fields', () => {
  const stamped = { ...event, eventId: crypto.randomUUID(), at: Date.now() };
  expect(connectionDiagnosticEventSchema.safeParse(stamped).success).toBe(true);
  const maximal = {
    ...stamped,
    cancelSource: 'correction_thread_change',
    inputKind: 'pointer',
    inputTrusted: true,
    status: 'interrupted',
    exact: false,
  };
  expect(connectionDiagnosticBatchSchema.safeParse({ v: 1, events: Array(60).fill(maximal) }).success).toBe(true);
  expect(
    new TextEncoder().encode(JSON.stringify({ v: 1, events: Array(60).fill(maximal) })).length,
  ).toBeLessThanOrEqual(32768);
  expect(
    connectionDiagnosticEventSchema.safeParse({
      eventId: crypto.randomUUID(),
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
    }).success,
  ).toBe(true);
  for (const invalid of [
    { ...stamped, cancelSource: 'private stack' },
    { ...stamped, readerId: 'private-reader' },
    { ...stamped, body: 'private body' },
    { ...stamped, draft: 'private draft' },
    { ...stamped, url: 'private URL' },
    { ...stamped, geometry: { top: 123 } },
    { ...stamped, token: 'private token' },
  ])
    expect(connectionDiagnosticEventSchema.safeParse(invalid).success).toBe(false);
});
it('uses the existing authenticated bounded batches and does not leak added private fields', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const { configureConnectionDiagnostics, recordConnectionDiagnostic } = await import('../connection-diagnostics');
  for (let i = 0; i < 300; i++) recordConnectionDiagnostic(event);
  expect(JSON.parse(localStorage.getItem(storage) ?? '[]')).toHaveLength(240);
  const rejected = { ...event, body: 'private-body', draft: 'private-draft', title: 'private-title' };
  recordConnectionDiagnostic(rejected);
  configureConnectionDiagnostics('http://isolated.invalid', () => 'session-fixture');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe('http://isolated.invalid/api/diagnostics/connection');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('session-fixture');
    const payload = JSON.parse(String(init?.body));
    expect(payload.events).toHaveLength(60);
    expect(connectionDiagnosticBatchSchema.safeParse(payload).success).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/private-body|private-draft|private-title/);
    expect(payload.events.every((r: typeof event) => r.readerId === readerId && r.operationId === operationId)).toBe(
      true,
    );
  }
  expect(JSON.parse(localStorage.getItem(storage) ?? '[]')).toEqual([]);
});
it('survives storage refusal and transport failure without recursive reporting or retry loops', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('private storage refusal');
  });
  const fetchMock = vi.fn<typeof fetch>(async () => {
    throw new TypeError('private offline');
  });
  vi.stubGlobal('fetch', fetchMock);
  const { configureConnectionDiagnostics, recordConnectionDiagnostic } = await import('../connection-diagnostics');
  configureConnectionDiagnostics('http://isolated.invalid', () => 'session-fixture');
  expect(() => recordConnectionDiagnostic(event)).not.toThrow();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
