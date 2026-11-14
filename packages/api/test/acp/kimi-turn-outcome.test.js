import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const {
  captureKimiLedgerBoundary,
  formatKimiTurnFailure,
  kimiSessionTurnLedgerPath,
  readKimiTurnOutcome,
  resolveKimiShareDir,
} = await import('../../dist/domains/cats/services/agents/providers/acp/kimi/kimi-turn-outcome.js');

const CWD = '/tmp/kimi-ledger-project';

function ledgerLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}

function turnEnded({ reason = 'failed', error, time = 123 } = {}) {
  return { type: 'turn.ended', agentId: 'main', turnId: 0, reason, ...(error === undefined ? {} : { error }), time };
}

const QUOTA = {
  code: 'provider.api_error',
  message:
    "429 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.",
  name: 'APIProviderQuotaExhaustedError',
  details: { statusCode: 429, requestId: null, traceId: 'trace-1' },
  retryable: false,
};

async function withLedger({ pre = [] } = {}, run) {
  const shareDir = await mkdtemp(join(tmpdir(), 'kimi-turn-outcome-'));
  const path = kimiSessionTurnLedgerPath({ shareDir, cwd: CWD, sessionId: 'session-1' });
  await mkdir(dirname(path), { recursive: true });
  if (pre.length > 0) await writeFile(path, pre.map(ledgerLine).join(''), 'utf8');
  const context = {
    shareDir,
    path,
    boundary: () => captureKimiLedgerBoundary({ shareDir, cwd: CWD, sessionId: 'session-1' }),
    append: (entries) => appendFile(path, entries.map(ledgerLine).join(''), 'utf8'),
    read: (boundary) => readKimiTurnOutcome({ shareDir, cwd: CWD, sessionId: 'session-1', boundary }),
  };
  try {
    return await run(context);
  } finally {
    await rm(shareDir, { recursive: true, force: true });
  }
}

test('the ledger path follows the native workspace hash the CLI writes', () => {
  const path = kimiSessionTurnLedgerPath({
    shareDir: '/native/home',
    cwd: '/workspace/cat-cafe',
    sessionId: 'session_3494094f-df2c-48f2-a0fd-e0820d66bf35',
  });
  assert.equal(
    path,
    '/native/home/sessions/wd_cat-cafe_29816e116854/session_3494094f-df2c-48f2-a0fd-e0820d66bf35/agents/main/wire.jsonl',
  );
});

test('native home resolution never falls back to ambient host state', () => {
  const saved = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = '/host-account-kimi';
  try {
    assert.equal(resolveKimiShareDir({ HOME: '/child-home' }), '/child-home/.kimi-code');
    assert.equal(resolveKimiShareDir({ HOME: '/child-home', KIMI_CODE_HOME: '/child-kimi' }), '/child-kimi');
    assert.equal(resolveKimiShareDir({ USERPROFILE: '/child-win' }), '/child-win/.kimi-code');
    assert.equal(resolveKimiShareDir({}), null);
  } finally {
    if (saved === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = saved;
  }
});

test('a failed turn appended after the boundary surfaces only the bounded error fields', async () => {
  await withLedger({}, async ({ boundary, append, read }) => {
    const before = await boundary();
    await append([turnEnded({ error: QUOTA })]);
    const outcome = await read(before);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.name, 'APIProviderQuotaExhaustedError');
    assert.equal(outcome.failure.code, 'provider.api_error');
    assert.equal(outcome.failure.statusCode, 429);
    assert.match(outcome.failure.message, /weekly \(7-day\) usage limit/);
    assert.doesNotMatch(outcome.failure.message, /trace-1/, 'internal ids must not be projected');
    const rendered = formatKimiTurnFailure(outcome.failure);
    assert.match(rendered, /HTTP 429/);
    assert.match(rendered, /APIProviderQuotaExhaustedError/);
  });
});

test('a terminal that predates the boundary is never reused', async () => {
  await withLedger({ pre: [turnEnded({ error: QUOTA })] }, async ({ boundary, append, read }) => {
    const before = await boundary();
    await append([turnEnded({ reason: 'completed' })]);
    assert.equal((await read(before)).kind, 'completed');
  });
});

test('an unchanged ledger cannot describe the current turn', async () => {
  await withLedger({ pre: [turnEnded({ error: QUOTA })] }, async ({ boundary, read }) => {
    const before = await boundary();
    assert.equal((await read(before)).kind, 'unknown');
  });
});

test('a truncated ledger invalidates the boundary instead of guessing', async () => {
  await withLedger({ pre: [turnEnded({ error: QUOTA })] }, async ({ path, boundary, read }) => {
    const before = await boundary();
    await truncate(path, Math.max(0, before.size - 1));
    assert.equal((await read(before)).kind, 'unknown');
  });
});

test('cancelled and unknown reasons never become provider failures', async () => {
  for (const [reason, expected] of [
    ['cancelled', 'cancelled'],
    ['surprising', 'unknown'],
  ]) {
    await withLedger({}, async ({ boundary, append, read }) => {
      const before = await boundary();
      await append([turnEnded({ reason })]);
      assert.equal((await read(before)).kind, expected);
    });
  }
});

test('a missing ledger yields no evidence instead of a fabricated cause', async () => {
  await withLedger({}, async ({ boundary, read }) => {
    const before = await boundary();
    assert.deepEqual(before, { size: 0 });
    assert.equal((await read(before)).kind, 'unknown');
  });
});

test('malformed appended lines are skipped without losing the terminal record', async () => {
  await withLedger({}, async ({ boundary, append, path, read }) => {
    const before = await boundary();
    await append([turnEnded({ error: QUOTA })]);
    await appendFile(path, '{"type":"turn.ended","truncated', 'utf8');
    const outcome = await read(before);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.failure.statusCode, 429);
  });
});

test('only the appended window is read: an oversized prefix cannot resurrect an old failure', async () => {
  await withLedger({}, async ({ boundary, append, read }) => {
    const before = await boundary();
    // A failed terminal first, then more than one readable window of trace, then completed.
    await append([turnEnded({ error: QUOTA })]);
    await append(
      Array.from({ length: 300 }, (_, index) => ({
        type: 'tool.trace',
        agentId: 'main',
        payload: `${index}-${'x'.repeat(1024)}`,
      })),
    );
    await append([turnEnded({ reason: 'completed' })]);
    assert.equal((await read(before)).kind, 'completed');
  });
});
