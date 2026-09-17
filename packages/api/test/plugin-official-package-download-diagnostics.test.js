import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const childScript = String.raw`
import { downloadCatalogArchive } from './src/domains/plugin/official-package-archive.ts';
import { OFFICIAL_PLUGIN_CATALOG } from './src/domains/plugin/official-catalog.ts';
import { logger } from './src/infrastructure/logger.ts';
const phase = process.argv[1];
const leaf = Object.assign(new Error('connect attempt failed'), {
  code: phase === 'fetch' ? 'ENETUNREACH' : 'UND_ERR_SOCKET',
  authorization: 'must-not-be-logged',
});
const cause = phase === 'fetch' ? new AggregateError([leaf], 'all addresses failed') : leaf;
const failure = new TypeError(phase === 'fetch' ? 'fetch failed' : 'terminated', { cause });
globalThis.fetch = async () => {
  if (phase === 'fetch') throw failure;
  if (phase === 'response') return new Response('registry unavailable', { status: 503 });
  if (phase === 'success') return new Response(new Uint8Array([1, 2, 3]));
  let pulls = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
      else controller.error(failure);
    },
  }), { headers: { 'content-length': '10' } });
};
try {
  const bytes = await downloadCatalogArchive(OFFICIAL_PLUGIN_CATALOG.find(e => e.catalogId === 'genoffice-docx'));
  process.stdout.write(JSON.stringify({ kind: 'outcome', bytes: [...bytes] }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    kind: 'outcome', code: error.code, message: error.message, sameCause: error.cause === failure,
  }) + '\n');
}
logger.flush();
`;

async function observeDownload(phase) {
  const logDir = await mkdtemp(join(tmpdir(), 'official-download-diagnostics-'));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', childScript, phase],
      {
        cwd: apiRoot,
        env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn', LOG_DIR: logDir },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const rows = stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    return {
      diagnostics: rows.filter((row) => row.module === 'plugin/official-package-archive'),
      outcome: rows.find((row) => row.kind === 'outcome'),
      stdout,
    };
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
}

for (const phase of ['fetch', 'body']) {
  test(`official download retains ${phase} transport evidence without changing its public error`, async () => {
    const observed = await observeDownload(phase);
    assert.deepEqual(observed.outcome, {
      kind: 'outcome',
      code: 'PACKAGE_DOWNLOAD_FAILED',
      message: 'official package download failed',
      sameCause: true,
    });
    assert.equal(observed.diagnostics.length, 1, `${phase} failure must emit one structured download diagnostic`);
    const diagnostic = observed.diagnostics[0];
    assert.equal(diagnostic.phase, phase);
    assert.equal(diagnostic.catalogId, 'genoffice-docx');
    assert.ok(Number.isFinite(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0);
    assert.equal(diagnostic.bytesReceived, phase === 'body' ? 3 : 0);
    assert.equal(diagnostic.error.name, 'TypeError');
    if (phase === 'fetch') {
      assert.equal(diagnostic.response, null);
      assert.equal(diagnostic.error.cause.name, 'AggregateError');
      assert.equal(diagnostic.error.cause.errors[0].code, 'ENETUNREACH');
    } else {
      assert.equal(diagnostic.response.status, 200);
      assert.equal(diagnostic.response.contentLength, '10');
      assert.equal(diagnostic.error.cause.code, 'UND_ERR_SOCKET');
    }
    assert.equal(observed.stdout.includes('must-not-be-logged'), false);
    assert.equal('stack' in diagnostic.error, false);
  });
}

test('official download preserves the final HTTP rejection and its existing public classification', async () => {
  const observed = await observeDownload('response');
  assert.equal(observed.outcome.code, 'PACKAGE_DOWNLOAD_FAILED');
  assert.equal(observed.outcome.message, 'official package registry returned HTTP 503');
  assert.equal(observed.diagnostics.length, 1, 'HTTP rejection must retain response evidence');
  assert.equal(observed.diagnostics[0].phase, 'response');
  assert.equal(observed.diagnostics[0].response.status, 503);
});

test('a successful official download returns the same bytes without a failure diagnostic', async () => {
  const observed = await observeDownload('success');
  assert.deepEqual(observed.outcome, { kind: 'outcome', bytes: [1, 2, 3] });
  assert.deepEqual(observed.diagnostics, []);
});
